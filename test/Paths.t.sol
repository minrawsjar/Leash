// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";
import {TickBitmap} from "v4-core/libraries/TickBitmap.sol";
import {Pool} from "v4-core/libraries/Pool.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {SwapParams} from "v4-core/types/PoolOperation.sol";
import {ImmutableState} from "v4-periphery/src/base/ImmutableState.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {Leash, Terms, Position, Mandate, EpochRecord} from "../src/Leash.sol";
import {LeashOracle} from "../src/LeashOracle.sol";
import {LeashBase} from "./utils/LeashBase.sol";

/// Whole flows through the hook, on the shared mandate (test/utils/LeashBase.sol). Success: a full lifecycle with
/// every event, what a swap does and doesn't touch, the stablecoin as currency0, own-bid raises, claims, checkpoints
/// that book nothing. Failure: every entry point on a missing or closed mandate, keys and terms out of bounds, a
/// takeover of a live pool, missing approvals and balances, misaligned ticks, callbacks from outside the PoolManager,
/// and each time gate at its exact second.
contract LeashPathsTest is LeashBase {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for *;

    address carol = makeAddr("carol"); // holds tokens, has approved nothing

    // ================================================================ success paths

    /// Two bidders, a hire, trading both ways, a fee change and a re-range, every epoch settled by a keeper, then
    /// close and every claim: each step emits its event, the treasury gets back more than it put in, and the hook
    /// ends holding nothing.
    function test_happyPath_lifecycleEmitsEveryEventAndEndsEmpty() public {
        PoolId id = key.toId();
        vm.expectEmit(address(leash));
        emit Leash.Bid(id, alice, 10e18);
        vm.prank(alice);
        leash.bid(key, 10e18);
        vm.expectEmit(address(leash));
        emit Leash.Bid(id, bob, 12e18);
        vm.prank(bob);
        leash.bid(key, 12e18);
        assertEq(leash.owed(alice, currency1), 10e18, "the outbid bond is claimable at once");

        vm.warp(auctionEnd);
        leash.checkpoint(key);
        vm.expectEmit(address(leash));
        emit Leash.FeeSet(id, 3000);
        vm.prank(bob);
        leash.setFee(key, 3000);
        swap(key, true, -10e18, ZERO_BYTES);
        swap(key, false, -10e18, ZERO_BYTES);
        _moveTo(0); // the market brings the price back in the same block: the TWAP never saw the trades
        _next(1 hours);
        vm.expectEmit(address(leash));
        emit Leash.Rebalanced(id, -1200, 1200, 1_000e18);
        vm.prank(bob);
        leash.rebalance(key, -1200, 1200, 1_000e18);

        for (uint256 e; e < 3; e++) {
            vm.warp(auctionEnd + (e + 1) * 1 days);
            vm.expectEmit(true, true, false, false, address(leash)); // the amounts are checked below
            emit Leash.EpochSettled(id, e, true, 0, 0, 0);
            vm.prank(alice); // the outbid bidder keeps the books: she earns the keeper bounty
            leash.settle(key, e);
            assertTrue(leash.epochRecord(id, e).clean);
        }
        EpochRecord memory e0 = leash.epochRecord(id, 0); // the only epoch with trades
        assertGt(e0.fees0, 0);
        assertEq(leash.owed(bob, currency0), uint256(e0.fees0) * 3000 / 10_000, "30% of the fees");
        assertEq(leash.owed(bob, currency1), 12e18 + uint256(e0.fees1) * 3000 / 10_000, "pay, and the bond back");
        assertGt(leash.owed(alice, currency0), 0, "keeper bounty");
        (uint32 clean, uint32 breached) = leash.records(bob);
        assertEq(clean, 3);
        assertEq(breached, 0);
        _assertLedger();

        uint256 before0 = _bal(currency0, address(this));
        uint256 before1 = _bal(currency1, address(this));
        vm.expectEmit(address(leash));
        emit Leash.Closed(id);
        leash.close(key);
        // The price is back where it opened, so the inventory is too, plus the treasury's share of the fees.
        assertGt(_bal(currency0, address(this)) - before0, 100e18, "more currency0 back than deposited");
        assertGt(_bal(currency1, address(this)) - before1, 100e18, "more currency1 back than deposited");

        address[2] memory who = [alice, bob];
        for (uint256 i; i < 2; i++) {
            vm.startPrank(who[i]);
            leash.claim(currency0);
            leash.claim(currency1);
            vm.stopPrank();
        }
        assertEq(_bal(currency0, address(leash)), 0, "nothing left behind (0)");
        assertEq(_bal(currency1, address(leash)), 0, "nothing left behind (1)");
    }

    /// A swap moves no hook money: the tokens go between the swapper and the PoolManager, and the fee accrues to the
    /// hook's positions inside the pool. Only a poke (rebalance, settle, close) collects it, exactly as measured.
    function test_swap_movesNoHookFunds_feesWaitInThePool() public {
        _win();
        Mandate memory m0 = _m();
        (uint256 h0, uint256 h1) = (_bal(currency0, address(leash)), _bal(currency1, address(leash)));
        swap(key, true, -10e18, ZERO_BYTES);
        swap(key, false, -10e18, ZERO_BYTES);

        Mandate memory m1 = _m();
        assertEq(_bal(currency0, address(leash)), h0, "hook balance (0) untouched");
        assertEq(_bal(currency1, address(leash)), h1, "hook balance (1) untouched");
        assertEq(abi.encode(m1.idle0, m1.idle1, m1.fees0, m1.fees1), abi.encode(m0.idle0, m0.idle1, m0.fees0, m0.fees1));
        assertEq(
            abi.encode(m1.tickLower, m1.tickUpper, m1.liquidity), abi.encode(m0.tickLower, m0.tickUpper, m0.liquidity)
        );
        assertEq(_anchorLiquidity(), 20e18, "anchor untouched");

        (uint128 p0, uint128 p1) = LeashOracle.pendingFees(manager, key.toId(), address(leash), -600, 600);
        assertApproxEqAbs(p0, MANAGED_FEE, 2, "the managed share of each 1% fee, still in the pool");
        assertApproxEqAbs(p1, MANAGED_FEE, 2);

        vm.warp(auctionEnd + 1 days);
        leash.settle(key, 0);
        EpochRecord memory e = leash.epochRecord(key.toId(), 0);
        assertEq(e.fees0, p0, "collected exactly what was pending");
        assertEq(e.fees1, p1);
        _assertLedger();
    }

    /// With the stablecoin as currency0, bonds, refunds and slashes all move in currency0; currency1 never does.
    function test_stableIs0_bondsRefundsAndSlashesInCurrency0() public {
        key = _key(10);
        Terms memory t = _terms();
        t.stableIs0 = true;
        _create(key, SQRT_PRICE_1_1, t, _initial());
        _fund(alice, 1_000e18, 0);
        _fund(bob, 1_000e18, 0);

        vm.prank(alice);
        leash.bid(key, 10e18);
        vm.prank(bob);
        leash.bid(key, 20e18);
        assertEq(leash.owed(alice, currency0), 10e18, "refund in currency0");
        assertEq(_bal(currency0, bob), 980e18, "bond pulled in currency0");
        assertEq(_bal(currency1, bob), 1_000e18, "currency1 untouched");

        vm.warp(auctionEnd);
        leash.checkpoint(key);
        vm.warp(auctionEnd + 21 hours);
        _swapTo(false, 100e18, 900); // out for the last 3h: fired
        vm.warp(auctionEnd + 1 days);
        leash.settle(key, 0);
        assertTrue(_m().breached);
        assertEq(leash.owed(address(this), currency0), 20e18, "whole bond to the treasury, in currency0");
        assertEq(leash.owed(address(this), currency1), 0);
        _assertLedger();
    }

    /// Raising your own leading bid refunds the first one, like any outbid bond.
    function test_bid_raisingYourOwnBidRefundsTheFirst() public {
        vm.startPrank(alice);
        leash.bid(key, 10e18);
        leash.bid(key, 15e18);
        vm.stopPrank();
        assertEq(_m().manager, alice);
        assertEq(_m().bond, 15e18);
        assertEq(leash.owed(alice, currency1), 10e18);
        vm.prank(alice);
        leash.claim(currency1);
        assertEq(_bal(currency1, alice), 1_000e18 - 15e18, "only the standing bond is held");
        _assertLedger();
    }

    /// claim pays what is owed exactly once; with nothing owed (any currency, even a non-token) it does nothing.
    function test_claim_paysOnce_nothingOwedIsANoop() public {
        vm.prank(alice);
        leash.bid(key, 10e18);
        vm.prank(bob);
        leash.bid(key, 20e18);
        vm.startPrank(alice);
        leash.claim(currency1);
        leash.claim(currency1);
        leash.claim(currency0);
        leash.claim(Currency.wrap(address(0)));
        vm.stopPrank();
        assertEq(_bal(currency1, alice), 1_000e18, "refunded once");
        _assertLedger();
    }

    /// Compliance is booked only inside the epochs and only with a manager.
    function test_checkpoint_booksNothingBeforeTheAuctionEndsOrWithoutAManager() public {
        uint256 snap = vm.snapshotState();
        vm.warp(auctionEnd + 1 hours);
        leash.checkpoint(key); // nobody bid
        assertEq(leash.epochRecord(key.toId(), 0).inSecs, 0, "no manager, nothing booked");
        assertEq(_m().lastCheck, 0);
        vm.revertToState(snap);

        vm.prank(alice);
        leash.bid(key, 10e18);
        vm.warp(auctionEnd - 1);
        leash.checkpoint(key);
        assertEq(leash.epochRecord(key.toId(), 0).inSecs, 0, "the auction is not an epoch");
        vm.warp(auctionEnd + 1 hours);
        leash.checkpoint(key);
        assertEq(leash.epochRecord(key.toId(), 0).inSecs, 1 hours);
    }

    // ================================================================ failure paths

    function test_noMandate_everyEntryPointReverts() public {
        PoolKey memory k = _key(10);
        vm.startPrank(alice);
        vm.expectRevert(Leash.NoMandate.selector);
        leash.bid(k, 10e18);
        vm.expectRevert(Leash.NoMandate.selector);
        leash.rebalance(k, -600, 600, 1_000e18);
        vm.expectRevert(Leash.NoMandate.selector);
        leash.setFee(k, 500);
        vm.expectRevert(Leash.NoMandate.selector);
        leash.checkpoint(k);
        vm.expectRevert(Leash.NoMandate.selector);
        leash.settle(k, 0);
        vm.expectRevert(Leash.NoMandate.selector);
        leash.close(k);
        vm.stopPrank();
    }

    function test_closedMandate_everyEntryPointReverts() public {
        vm.warp(auctionEnd);
        leash.close(key);
        vm.startPrank(alice);
        vm.expectRevert(Leash.MandateClosed.selector);
        leash.bid(key, 10e18);
        vm.expectRevert(Leash.MandateClosed.selector);
        leash.rebalance(key, -600, 600, 1_000e18);
        vm.expectRevert(Leash.MandateClosed.selector);
        leash.setFee(key, 500);
        vm.expectRevert(Leash.MandateClosed.selector);
        leash.checkpoint(key);
        vm.expectRevert(Leash.MandateClosed.selector);
        leash.settle(key, 0);
        vm.stopPrank();
        vm.expectRevert(Leash.MandateClosed.selector);
        leash.close(key);
    }

    /// Only this hook's own dynamic-fee pools over two deployed tokens.
    function test_createMandate_rejectsKeysThatAreNotLeashPools() public {
        PoolKey memory k = _key(10);
        k.hooks = IHooks(address(0));
        vm.expectRevert(Leash.NotLeashPool.selector);
        leash.createMandate(k, SQRT_PRICE_1_1, _terms(), 100e18, 100e18, _initial());
        k = _key(10);
        k.fee = 3000; // a static fee
        vm.expectRevert(Leash.NotLeashPool.selector);
        leash.createMandate(k, SQRT_PRICE_1_1, _terms(), 100e18, 100e18, _initial());
        k = _key(10);
        k.currency0 = Currency.wrap(address(0)); // native ETH
        vm.expectRevert(Leash.NotLeashPool.selector);
        leash.createMandate(k, SQRT_PRICE_1_1, _terms(), 100e18, 100e18, _initial());
    }

    /// Each bound in createMandate, broken on its own, then all of them at their inclusive edges.
    function test_createMandate_rejectsEveryOutOfBoundsTerm() public {
        for (uint256 i; i < 14; i++) {
            Terms memory t = _terms();
            if (i == 0) t.auctionEnd = uint40(block.timestamp + t.twapWindow - 1); // auction shorter than a window
            else if (i == 1) t.twapWindow = 0;
            else if (i == 2) t.epochLength = 0;
            else if (i == 3) t.epochs = 0;
            else if (i == 4) t.epochs = 105;
            else if (i == 5) t.maxFee = 1_000_001;
            else if (i == 6) t.minFee = t.maxFee + 1;
            else if (i == 7) t.minLiquidity = 0;
            else if (i == 8) t.uptimeBps = 10_001;
            else if (i == 9) t.managerFeeBps = 10_001;
            else if (i == 10) t.startStableBps = 10_001;
            else if (i == 11) t.endStableBps = 10_001;
            else if (i == 12) t.minHalfWidth = t.maxTickDeviation;
            else t.anchorLiquidity = 0;
            vm.expectRevert(Leash.BadTerms.selector);
            leash.createMandate(_key(10), SQRT_PRICE_1_1, t, 100e18, 100e18, _initial());
        }
        Terms memory edge = _terms();
        edge.auctionEnd = uint40(block.timestamp + edge.twapWindow);
        (edge.epochs, edge.maxFee, edge.minFee) = (104, 1_000_000, 1_000_000);
        (edge.uptimeBps, edge.managerFeeBps, edge.startStableBps, edge.endStableBps) = (10_000, 10_000, 10_000, 10_000);
        edge.minHalfWidth = edge.maxTickDeviation + 1;
        leash.createMandate(_key(10), SQRT_PRICE_1_1, edge, 100e18, 100e18, _initial());
    }

    /// A second treasury can't open a mandate on a live pool and overwrite the first.
    function test_createMandate_cannotTakeOverALivePool() public {
        vm.prank(carol);
        vm.expectRevert(Pool.PoolAlreadyInitialized.selector);
        leash.createMandate(key, SQRT_PRICE_1_1, _terms(), 100e18, 100e18, _initial());
        assertEq(_m().treasury, address(this));
    }

    function test_createMandate_needsApprovalAndBalance() public {
        PoolKey memory k = _key(10);
        MockERC20(Currency.unwrap(currency0)).mint(carol, 100e18);
        MockERC20(Currency.unwrap(currency1)).mint(carol, 50e18);
        vm.startPrank(carol);
        vm.expectRevert(bytes("TRANSFER_FROM_FAILED")); // nothing approved
        leash.createMandate(k, SQRT_PRICE_1_1, _terms(), 100e18, 100e18, _initial());
        _approve(address(leash));
        vm.expectRevert(bytes("TRANSFER_FROM_FAILED")); // approved, but holds 50 of the 100 currency1
        leash.createMandate(k, SQRT_PRICE_1_1, _terms(), 100e18, 100e18, _initial());
        vm.stopPrank();

        MockERC20(Currency.unwrap(currency1)).mint(carol, 50e18);
        vm.prank(carol);
        leash.createMandate(k, SQRT_PRICE_1_1, _terms(), 100e18, 100e18, _initial());
        assertEq(leash.mandate(k.toId()).treasury, carol);
        assertEq(_bal(currency0, carol) + _bal(currency1, carol), 0, "the whole deposit was pulled");
    }

    function test_bid_needsApprovalAndBalance() public {
        MockERC20(Currency.unwrap(currency1)).mint(carol, 15e18);
        vm.prank(carol);
        vm.expectRevert(bytes("TRANSFER_FROM_FAILED")); // nothing approved
        leash.bid(key, 10e18);
        vm.prank(carol);
        MockERC20(Currency.unwrap(currency1)).approve(address(leash), type(uint256).max);
        vm.prank(carol);
        vm.expectRevert(bytes("TRANSFER_FROM_FAILED")); // more than she holds
        leash.bid(key, 20e18);
        assertEq(_m().manager, address(0), "a failed bid leaves no manager");

        vm.prank(carol);
        leash.bid(key, 15e18);
        assertEq(_m().manager, carol);
        assertEq(_m().bond, 15e18);
    }

    /// Ticks off the spacing pass Leash's own range rules and are refused by the PoolManager, whole: on a rebalance
    /// the old position, already pulled in the same unlock, stays where it was.
    function test_misalignedTicks_revertAtThePoolManager() public {
        vm.expectRevert(abi.encodeWithSelector(TickBitmap.TickMisaligned.selector, int24(-605), int24(10)));
        leash.createMandate(_key(10), SQRT_PRICE_1_1, _terms(), 100e18, 100e18, Position(-605, 600, 1_000e18));

        _win();
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(TickBitmap.TickMisaligned.selector, int24(-1210), int24(60)));
        leash.rebalance(key, -1210, 1200, 1_000e18);
        Mandate memory m = _m();
        assertEq(
            abi.encode(m.tickLower, m.tickUpper, m.liquidity), abi.encode(int24(-600), int24(600), uint128(1_000e18))
        );
    }

    /// The hook's callbacks run only for the PoolManager: a direct beforeSwap would write oracle observations and
    /// checkpoints, a direct unlockCallback would move the treasury's liquidity.
    function test_hookCallbacks_onlyFromThePoolManager() public {
        vm.expectRevert(ImmutableState.NotPoolManager.selector);
        leash.unlockCallback("");
        vm.expectRevert(ImmutableState.NotPoolManager.selector);
        leash.beforeSwap(address(this), key, SwapParams(true, -1e18, TickMath.MIN_SQRT_PRICE + 1), ZERO_BYTES);
        vm.expectRevert(ImmutableState.NotPoolManager.selector);
        leash.beforeInitialize(address(this), key, SQRT_PRICE_1_1);
        vm.expectRevert(ImmutableState.NotPoolManager.selector);
        leash.beforeAddLiquidity(address(this), key, LIQUIDITY_PARAMS, ZERO_BYTES);
    }

    /// Each time gate, one second before and at its edge.
    function test_timeGates_atTheirExactSecond() public {
        uint256 end = auctionEnd + 3 days;
        vm.warp(auctionEnd - 1);
        vm.expectRevert(Leash.NotEnded.selector); // no bids yet: closable only once the auction is over
        leash.close(key);
        vm.prank(alice);
        leash.bid(key, 10e18); // the auction's last second
        vm.prank(alice);
        vm.expectRevert(Leash.NotActive.selector);
        leash.setFee(key, 500);

        vm.warp(auctionEnd);
        vm.prank(bob);
        vm.expectRevert(Leash.AuctionClosed.selector);
        leash.bid(key, 20e18);
        vm.prank(alice);
        leash.setFee(key, 500); // epoch 0's first second

        vm.warp(auctionEnd + 1 days - 1);
        vm.expectRevert(Leash.NotEnded.selector);
        leash.settle(key, 0);
        vm.warp(auctionEnd + 1 days);
        leash.settle(key, 0);
        vm.expectRevert(Leash.NotEnded.selector);
        leash.settle(key, 1);

        vm.warp(end - 1);
        vm.prank(alice);
        leash.setFee(key, 600); // the mandate's last second
        vm.expectRevert(Leash.NotEnded.selector);
        leash.close(key);

        vm.warp(end);
        vm.prank(alice);
        vm.expectRevert(Leash.NotActive.selector);
        leash.setFee(key, 700);
        leash.settle(key, 1);
        leash.settle(key, 2);
        vm.expectRevert(Leash.BadEpoch.selector); // there is no epoch 3
        leash.settle(key, 3);
        leash.close(key);
        assertTrue(_m().closed);
    }
}
