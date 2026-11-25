// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {stdError} from "forge-std/Test.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";
import {FullMath} from "v4-core/libraries/FullMath.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";
import {SqrtPriceMath} from "v4-core/libraries/SqrtPriceMath.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {Leash, Terms, Position, Mandate, EpochRecord} from "../src/Leash.sol";
import {LeashBase} from "./utils/LeashBase.sol";

/// One test per rule, on the shared mandate (test/utils/LeashBase.sol).
contract LeashTest is LeashBase {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for *;

    // ---------------------------------------------------------------- creation

    function test_createMandate_initsPoolAndPlacesInventory() public view {
        (uint160 sqrtPrice,,, uint24 lpFee) = manager.getSlot0(key.toId());
        assertEq(sqrtPrice, SQRT_PRICE_1_1);
        assertEq(lpFee, 10_000, "starts at the fee cap");
        Mandate memory m = _m();
        assertEq(m.treasury, address(this));
        assertEq(manager.getLiquidity(key.toId()), 1_000e18 + 20e18, "never empty: managed position + anchor");
        assertLt(m.idle0, 100e18, "inventory went into the position");
        assertEq(_bal(currency0, address(leash)), m.idle0);
        assertEq(_bal(currency1, address(leash)), m.idle1);
    }

    function test_createMandate_rejectsShallowOrOffPricePosition() public {
        PoolKey memory k = _key(10);
        vm.expectRevert(Leash.TooShallow.selector);
        leash.createMandate(k, SQRT_PRICE_1_1, _terms(), 100e18, 100e18, Position(-600, 600, 99e18));
        vm.expectRevert(Leash.RangeMissesTwap.selector);
        leash.createMandate(k, SQRT_PRICE_1_1, _terms(), 100e18, 100e18, Position(60, 600, 1_000e18));
        vm.expectRevert(Leash.RangeMissesTwap.selector); // narrower than minHalfWidth (200) on each side
        leash.createMandate(k, SQRT_PRICE_1_1, _terms(), 100e18, 100e18, Position(-120, 120, 1_000e18));
        Terms memory t = _terms();
        t.auctionEnd = uint40(block.timestamp + 1799);
        vm.expectRevert(Leash.BadTerms.selector);
        leash.createMandate(k, SQRT_PRICE_1_1, t, 100e18, 100e18, _initial());
        t = _terms();
        t.minFee = t.maxFee + 1;
        vm.expectRevert(Leash.BadTerms.selector);
        leash.createMandate(k, SQRT_PRICE_1_1, t, 100e18, 100e18, _initial());
        t = _terms();
        t.minHalfWidth = t.maxTickDeviation;
        vm.expectRevert(Leash.BadTerms.selector);
        leash.createMandate(k, SQRT_PRICE_1_1, t, 100e18, 100e18, _initial());
    }

    /// The anchor spans the full range, the manager can't move it, and its fees go to the treasury at close.
    function test_anchor_fullRangeUntouchedByRebalancesRemovedAtClose() public {
        assertEq(_anchorLiquidity(), 20e18);
        _win();
        vm.prank(alice);
        leash.rebalance(key, -1200, 1200, 1_000e18);
        swap(key, true, -10e18, ZERO_BYTES);
        _swapTo(false, 1e30, 50_000); // far outside the managed range: only the anchor is there
        assertEq(manager.getLiquidity(key.toId()), 20e18, "liquidity at every price");
        _swapTo(true, 1e30, 0);
        assertEq(_anchorLiquidity(), 20e18, "rebalances and swaps never touch it");

        vm.warp(auctionEnd + 3 days);
        leash.close(key);
        assertEq(_anchorLiquidity(), 0, "close removes it");
        _assertLedger();
        // Alice's pay is 30% of the managed position's fees only; the anchor's went to the treasury.
        uint256 managedFees0 = leash.epochRecord(key.toId(), 0).fees0;
        assertEq(leash.owed(alice, currency0), managedFees0 * 3000 / 10_000);
        vm.startPrank(alice);
        leash.claim(currency0);
        leash.claim(currency1);
        vm.stopPrank();
        assertEq(_bal(currency0, address(leash)), 0);
        assertEq(_bal(currency1, address(leash)), 0);
    }

    function test_outsiderCannotAddLiquidity() public {
        vm.expectRevert();
        modifyLiquidityRouter.modifyLiquidity(key, LIQUIDITY_PARAMS, ZERO_BYTES);
    }

    function test_outsiderCannotCreateLeashPool() public {
        PoolKey memory other = _key(10);
        vm.expectRevert();
        manager.initialize(other, SQRT_PRICE_1_1);
    }

    // ---------------------------------------------------------------- oracle

    function test_twap_ignoresSameBlockPush_followsSustainedPrice() public {
        vm.warp(auctionEnd);
        _swapTo(false, 100e18, 400); // push the price up to tick 400
        assertEq(_tick(), 400);
        assertEq(leash.twapTick(key), 0, "same-block push is invisible");

        vm.warp(block.timestamp + 180); // a tenth of the window at 400
        assertEq(leash.twapTick(key), 40);
        vm.warp(block.timestamp + 1800);
        assertEq(leash.twapTick(key), 400, "a held price becomes the TWAP");

        _swapTo(true, 100e18, -200);
        vm.warp(block.timestamp + 900); // half the window at -200, half at 400
        assertEq(leash.twapTick(key), 100);
    }

    /// A genuine 30% move (3000 ticks), traded every 12s block: the recorded tick ramps 600 per block, so it reaches
    /// the new price within a minute, and the TWAP is fully there one window after that.
    function test_twap_followsGenuineFastMoveWithinAboutAWindow() public {
        vm.warp(auctionEnd);
        _swapTo(false, 1e30, 3000);
        uint256 t0 = block.timestamp;
        while (block.timestamp < t0 + 1800 + 60) {
            vm.roll(block.number + 1);
            vm.warp(block.timestamp + 12);
            swap(key, block.number % 2 == 0, -1e15, ZERO_BYTES); // ordinary trading at the new price
            _moveTo(3000);
        }
        assertEq(leash.twapTick(key), 3000, "fully at the new price one window + one minute later");
    }

    /// Someone parks the price 400,000 ticks up for one 12s block (it costs them ~1e28 tokens through the anchor)
    /// and lets it come back: the recorded tick moves at most 600, the 30-minute TWAP at most 4.
    function test_twap_oneBlockSpikeBarelyMovesIt() public {
        vm.warp(auctionEnd);
        _swapTo(false, 1e30, 400_000);
        vm.roll(block.number + 1);
        vm.warp(block.timestamp + 12);
        assertLe(leash.twapTick(key), 4, "view while parked");
        _swapTo(true, 1e30, 0);
        assertLe(leash.twapTick(key), 4, "recorded");
        vm.warp(block.timestamp + 1 hours);
        assertEq(leash.twapTick(key), _tick(), "gone after a window"); // -1: v4's tick after landing on 0 from above
    }

    // ---------------------------------------------------------------- auction

    function test_bid_highestWins_outbidCanClaim() public {
        vm.prank(alice);
        leash.bid(key, 10e18);
        vm.prank(bob);
        vm.expectRevert(Leash.LowBid.selector);
        leash.bid(key, 10e18);
        vm.prank(bob);
        leash.bid(key, 20e18);

        assertEq(_m().manager, bob);
        assertEq(leash.owed(alice, currency1), 10e18);
        vm.prank(alice);
        leash.claim(currency1);
        assertEq(_bal(currency1, alice), 1_000e18, "alice made whole");

        vm.warp(auctionEnd);
        vm.prank(alice);
        vm.expectRevert(Leash.AuctionClosed.selector);
        leash.bid(key, 30e18);
    }

    // ---------------------------------------------------------------- manager

    function test_rebalance_onlyManager_onlyWhenActive() public {
        vm.prank(alice);
        leash.bid(key, 10e18);
        vm.prank(alice);
        vm.expectRevert(Leash.NotActive.selector);
        leash.rebalance(key, -600, 600, 1e18);

        vm.warp(auctionEnd);
        vm.prank(bob);
        vm.expectRevert(Leash.NotManager.selector);
        leash.rebalance(key, -600, 600, 1e18);
    }

    /// An attacker (or the manager's accomplice) pushes the price and the manager tries to re-place liquidity on
    /// it. Same block: refused because the price moved this block. Next block: refused because spot is 400 ticks
    /// off a TWAP that has barely moved.
    function test_rebalance_oneBlockManipulationRefused() public {
        _win();
        _swapTo(false, 100e18, 400);
        vm.prank(alice);
        vm.expectRevert(Leash.SameBlock.selector); // no growth once the price moved this block
        leash.rebalance(key, 0, 1200, 1_000e18 + 1);

        vm.roll(block.number + 1);
        vm.warp(block.timestamp + 12);
        vm.prank(alice);
        vm.expectRevert(Leash.SpotOffTwap.selector);
        leash.rebalance(key, -600, 1200, 1_000e18);

        // The price is pushed back; after honest trading time, a normal rebalance passes, once per block.
        _swapTo(true, 100e18, 0);
        vm.roll(block.number + 1);
        vm.warp(block.timestamp + 1 hours);
        assertLe(leash.twapTick(key), 100);
        vm.startPrank(alice);
        leash.rebalance(key, -1200, 1200, 1_000e18);
        assertEq(_m().tickLower, -1200);
        vm.expectRevert(Leash.SameBlock.selector);
        leash.rebalance(key, -1200, 1200, 900e18);
        vm.stopPrank();
    }

    /// Growing the managed position needs spot at the TWAP (within 2 ticks); re-ranging at the same size or smaller
    /// only needs the usual maxTickDeviation.
    function test_rebalance_growsOnlyWithSpotAtTwap() public {
        _win();
        _swapTo(false, 1e30, 60);
        vm.roll(block.number + 1);
        vm.warp(block.timestamp + 12);
        vm.prank(alice);
        vm.expectRevert(Leash.SpotOffTwap.selector);
        leash.rebalance(key, -1200, 1200, 1_000e18 + 1);
        vm.prank(alice);
        leash.rebalance(key, -1200, 1200, 1_000e18);

        _swapTo(true, 1e30, 0);
        vm.roll(block.number + 1);
        vm.warp(block.timestamp + 1 hours); // spot and TWAP agree again
        vm.startPrank(alice);
        vm.expectRevert(Leash.GrowTooFast.selector); // more than 5% at once
        leash.rebalance(key, -1200, 1200, 1_050e18 + 1);
        vm.roll(block.number + 1);
        vm.warp(block.timestamp + 12);
        leash.rebalance(key, -1200, 1200, 1_050e18);
        vm.roll(block.number + 1);
        vm.warp(block.timestamp + 12);
        vm.expectRevert(Leash.GrowTooFast.selector); // again within one TWAP window
        leash.rebalance(key, -1200, 1200, 1_100e18);
        vm.roll(block.number + 1);
        vm.warp(block.timestamp + _m().terms.twapWindow);
        leash.rebalance(key, -1200, 1200, 1_100e18);
        vm.stopPrank();
    }

    function test_rebalance_followsSustainedMove() public {
        _win();
        _swapTo(false, 100e18, 400);
        vm.warp(block.timestamp + 1 hours);
        vm.prank(alice);
        leash.rebalance(key, 0, 1200, 1_000e18); // the move is now the TWAP; re-centre on it
    }

    function test_rebalance_rejectsShallowOrRangeMissingTwap() public {
        _win();
        vm.startPrank(alice);
        vm.expectRevert(Leash.TooShallow.selector);
        leash.rebalance(key, -600, 600, 100e18 - 1);
        vm.expectRevert(Leash.RangeMissesTwap.selector);
        leash.rebalance(key, 60, 600, 1_000e18);
        vm.expectRevert(Leash.RangeMissesTwap.selector);
        leash.rebalance(key, -600, 0, 1_000e18); // upper tick is exclusive
        vm.expectRevert(Leash.RangeMissesTwap.selector);
        leash.rebalance(key, -180, 1200, 1_000e18); // lower edge within minHalfWidth of the TWAP
        leash.rebalance(key, -1200, 1200, 100e18);
        vm.stopPrank();
    }

    function test_rebalance_swap_ledgerMatchesBalances() public {
        _win();
        vm.prank(alice);
        leash.rebalance(key, -1200, 1200, 1_050e18);
        assertEq(manager.getLiquidity(key.toId()), 1_050e18 + 20e18, "hook liquidity is live");

        swap(key, true, -1e18, ZERO_BYTES); // someone buys currency1 with currency0
        vm.warp(block.timestamp + 1 hours);

        vm.prank(alice);
        leash.rebalance(key, -600, 600, 100e18);
        Mandate memory m = _m();
        assertGt(m.fees0, 0, "the swapper's fee was collected, outside idle");
        assertEq(leash.epochRecord(key.toId(), 0).fees0, m.fees0, "booked to the current epoch");
        _assertLedger();
    }

    /// The new range needs 5 currency1 more than the mandate's inventory. The hook also holds the 10 currency1
    /// bond, so its balance could pay: it must fail on the ledger.
    function test_rebalance_cannotSpendTheBond() public {
        _win();
        Mandate memory m = _m();
        uint256 have1 = m.idle1
            + SqrtPriceMath.getAmount1Delta(
                TickMath.getSqrtPriceAtTick(m.tickLower), SQRT_PRICE_1_1, m.liquidity, false
            );
        // Same liquidity (no growth), but a range reaching low enough to need 5e18 more currency1 than the mandate
        // has: only the bond could pay for it, and the ledger refuses.
        uint160 lo = uint160(FullMath.mulDiv(SQRT_PRICE_1_1, m.liquidity - have1 - 5e18, m.liquidity));
        int24 tick = TickMath.getTickAtSqrtPrice(lo);
        tick = tick - (tick % 60) - 60;
        assertLe(
            SqrtPriceMath.getAmount1Delta(TickMath.getSqrtPriceAtTick(tick), SQRT_PRICE_1_1, m.liquidity, true),
            have1 + 10e18,
            "within the bond's reach"
        );
        vm.prank(alice);
        vm.expectRevert(stdError.arithmeticError);
        leash.rebalance(key, tick, 240, m.liquidity);
    }

    function test_setFee_betweenFloorAndCap() public {
        _win();
        vm.startPrank(alice);
        vm.expectRevert(Leash.FeeTooHigh.selector);
        leash.setFee(key, 10_001);
        vm.expectRevert(Leash.FeeTooLow.selector);
        leash.setFee(key, 499);
        leash.setFee(key, 500);
        vm.stopPrank();
        (,,, uint24 lpFee) = manager.getSlot0(key.toId());
        assertEq(lpFee, 500);
    }

    // ---------------------------------------------------------------- compliance

    /// Out of range from 12h into epoch 0, then nothing happens for a day: the quiet gap is split 12h/12h.
    function test_checkpoint_splitsQuietGapAcrossEpochs() public {
        _win();
        vm.warp(auctionEnd + 12 hours);
        _swapTo(false, 100e18, 900); // checkpoints [0, 12h) as in, then leaves the range
        assertEq(leash.epochRecord(key.toId(), 0).inSecs, 12 hours);

        vm.warp(auctionEnd + 36 hours);
        vm.prank(alice);
        leash.setFee(key, 10_000); // any action checkpoints
        EpochRecord memory e0 = leash.epochRecord(key.toId(), 0);
        EpochRecord memory e1 = leash.epochRecord(key.toId(), 1);
        assertEq(e0.inSecs, 12 hours);
        assertEq(e0.outSecs, 12 hours);
        assertEq(e1.inSecs, 0);
        assertEq(e1.outSecs, 12 hours);
        assertEq(leash.currentEpoch(key), 1);
    }

    /// The TWAP leaves the range after a spike and drifts back on its own while nobody checkpoints. The manager
    /// checkpoints once it's back (here via setFee): the stretch since the last bad checkpoint is still booked out.
    /// Judged by its end alone, the last 110 minutes would have been booked in.
    function test_checkpoint_whitewashAttemptBooksTheBadStretchOut() public {
        _win();
        vm.warp(auctionEnd + 1 hours);
        _swapTo(false, 100e18, 3000); // checkpoint: compliant so far
        vm.warp(block.timestamp + 10 minutes);
        _swapTo(true, 100e18, 0); // checkpoint sees the TWAP at 1000, out; the TWAP is back in range by +34m
        vm.warp(auctionEnd + 3 hours);
        assertLt(leash.twapTick(key), 600, "back in range");
        vm.prank(alice);
        leash.setFee(key, 10_000);

        EpochRecord memory e = leash.epochRecord(key.toId(), 0);
        assertEq(e.inSecs, 1 hours);
        assertEq(e.outSecs, 2 hours, "10m seen out + 110m not proven in");
    }

    /// Spot at 900 for 130 min: the TWAP is out of [-600, 600) for exactly 2h (from +20m to +2h20m). With a
    /// keeper every minute, the booking is exact up to one interval at each edge.
    function test_checkpoint_keeperBooksOutStretchWithinOneIntervalPerEdge() public {
        _win();
        _keep(auctionEnd + 1 hours);
        _swapTo(false, 100e18, 900);
        _keep(block.timestamp + 130 minutes);
        _swapTo(true, 100e18, 0);
        _keep(block.timestamp + 1 hours);

        EpochRecord memory e = leash.epochRecord(key.toId(), 0);
        assertGe(e.outSecs, 2 hours, "never under-books");
        assertLe(e.outSecs, 2 hours + 2 minutes, "one keeper interval per edge");
        assertEq(e.inSecs + e.outSecs, block.timestamp - auctionEnd);
    }

    /// In range all epoch, with swaps, keeper checkpoints and a rebalance: every second is booked in.
    function test_checkpoint_compliantManagerUnaffected() public {
        _win();
        for (uint256 i = 1; i <= 144; i++) {
            vm.warp(auctionEnd + i * 10 minutes);
            vm.roll(block.number + 1);
            if (i == 72) {
                vm.prank(alice);
                leash.rebalance(key, -1200, 1200, 1_000e18); // first in its block, before the swap
            }
            if (i % 6 == 0) swap(key, i % 12 == 0, -1e18, ZERO_BYTES);
            leash.checkpoint(key);
        }
        leash.settle(key, 0);
        EpochRecord memory e = leash.epochRecord(key.toId(), 0);
        assertEq(e.inSecs, 1 days);
        assertEq(e.outSecs, 0);
        assertTrue(e.clean);
    }

    /// A rebalance that restores compliance counts from the fix, not from the next checkpoint.
    function test_checkpoint_fixCountsFromTheRebalance() public {
        _win();
        _swapTo(false, 100e18, 900);
        vm.warp(block.timestamp + 1 hours);
        leash.checkpoint(key); // out: TWAP 900
        vm.prank(alice);
        leash.rebalance(key, 600, 1200, 1_000e18);
        vm.warp(block.timestamp + 1 hours);
        leash.checkpoint(key);

        EpochRecord memory e = leash.epochRecord(key.toId(), 0);
        assertEq(e.outSecs, 1 hours);
        assertEq(e.inSecs, 1 hours);
    }

    /// Glide path 55% -> 90% stablecoin. Buyers take currency0 for stablecoin through the position, pushing the
    /// stable share to ~59%: ahead of the path for now, so out of compliance; on pace again a day later.
    function test_pace_sellingAheadOfGlidePathIsOutOfCompliance() public {
        key = _key(10);
        Terms memory t = _terms();
        (t.startStableBps, t.endStableBps) = (5500, 9000);
        leash.createMandate(key, SQRT_PRICE_1_1, t, 100e18, 100e18, _initial());
        _win();
        (bool inRange,, bool onPace, uint16 stableBps) = leash.compliance(key);
        assertTrue(onPace);
        assertApproxEqAbs(stableBps, 5000, 1);

        _swapTo(false, 100e18, 400);
        vm.warp(block.timestamp + 1 hours);
        (inRange,, onPace, stableBps) = leash.compliance(key);
        assertTrue(inRange);
        assertFalse(onPace);
        assertGt(stableBps, 5800);
        vm.prank(alice);
        leash.setFee(key, 10_000);
        assertEq(leash.epochRecord(key.toId(), 0).outSecs, 1 hours, "selling ahead counts as out");

        vm.warp(auctionEnd + 1 days);
        (,, onPace,) = leash.compliance(key);
        assertTrue(onPace, "the glide path caught up");
    }

    // ---------------------------------------------------------------- settlement

    function test_settle_cleanEpochPaysExactShare() public {
        _win();
        swap(key, true, -10e18, ZERO_BYTES); // 1% fee in currency0
        vm.warp(block.timestamp + 1 hours);
        vm.prank(alice);
        leash.rebalance(key, -1200, 1200, 1_000e18); // collects the currency0 fee into epoch 0
        swap(key, false, -10e18, ZERO_BYTES); // 1% fee in currency1, collected at settlement

        vm.expectRevert(Leash.NotEnded.selector);
        leash.settle(key, 0);
        vm.warp(auctionEnd + 1 days);
        vm.prank(bob); // anyone can settle
        leash.settle(key, 0);

        EpochRecord memory e = leash.epochRecord(key.toId(), 0);
        assertTrue(e.settled && e.clean);
        assertEq(e.outSecs, 0);
        assertApproxEqAbs(e.fees0, MANAGED_FEE, 2);
        assertApproxEqAbs(e.fees1, MANAGED_FEE, 2);
        assertEq(leash.owed(alice, currency0), uint256(e.fees0) * 3000 / 10_000, "30% of fees0");
        assertEq(leash.owed(alice, currency1), uint256(e.fees1) * 3000 / 10_000, "30% of fees1");
        (uint32 clean, uint32 breached) = leash.records(alice);
        assertEq(clean, 1);
        assertEq(breached, 0);
        assertEq(_m().fees0, 0, "the rest of the fees joined the inventory");
        _assertLedger();

        vm.expectRevert(Leash.BadEpoch.selector);
        leash.settle(key, 0);
        vm.expectRevert(Leash.NotEnded.selector);
        leash.settle(key, 1);
    }

    /// Out of range for the last 3h of the epoch (12.5%, at least twice the 5% allowed): the whole bond goes to the
    /// treasury and the manager is fired. Was 2h before partial slashing; 2h out now takes 2/3 of the bond and
    /// keeps the manager (test_partialSlash_*), so this needs 3h to test the firing path.
    function test_settle_breachSlashesBondAndFiresManager() public {
        _win();
        vm.warp(auctionEnd + 21 hours);
        _swapTo(false, 100e18, 900);
        vm.warp(auctionEnd + 1 days);
        leash.settle(key, 0);

        EpochRecord memory e = leash.epochRecord(key.toId(), 0);
        assertFalse(e.clean);
        assertEq(e.inSecs, 21 hours);
        assertEq(e.outSecs, 3 hours);
        Mandate memory m = _m();
        assertTrue(m.breached);
        assertEq(m.bond, 0);
        assertEq(leash.owed(address(this), currency1), 10e18, "bond to the treasury");
        assertEq(leash.owed(alice, currency0) + leash.owed(alice, currency1), 0, "no pay");
        (uint32 clean, uint32 breached) = leash.records(alice);
        assertEq(clean, 0);
        assertEq(breached, 1);
        _assertLedger();

        vm.startPrank(alice);
        vm.expectRevert(Leash.Breached.selector);
        leash.rebalance(key, 600, 1200, 1_000e18);
        vm.expectRevert(Leash.Breached.selector);
        leash.setFee(key, 100);
        vm.stopPrank();
        vm.warp(auctionEnd + 2 days);
        vm.expectRevert(Leash.Breached.selector);
        leash.settle(key, 1);

        // The treasury doesn't wait for the mandate to run out.
        leash.close(key);
        assertEq(manager.getLiquidity(key.toId()), 0);
        assertEq(leash.owed(alice, currency1), 0, "no bond back");
        _assertLedger();
        leash.claim(currency1);
        assertEq(_bal(currency1, address(leash)), 0);
    }

    /// Pushed out of range for one block and straight back: the TWAP barely moves, the epoch stays clean.
    function test_settle_oneBadBlockDoesNotBreach() public {
        _win();
        vm.warp(auctionEnd + 6 hours);
        _swapTo(false, 100e18, 900);
        vm.roll(block.number + 1);
        vm.warp(block.timestamp + 12);
        _swapTo(true, 100e18, 0);
        vm.warp(auctionEnd + 1 days);
        leash.settle(key, 0);
        assertTrue(leash.epochRecord(key.toId(), 0).clean);
        assertEq(_m().bond, 10e18);
    }

    /// Fees from trading during the auction go to the treasury, not into epoch 0's pay.
    function test_settle_feesEarnedBeforeHireGoToTreasury() public {
        swap(key, true, -10e18, ZERO_BYTES); // 0.1 currency0 of fees, before anyone manages
        vm.prank(alice);
        leash.bid(key, 10e18);
        vm.warp(auctionEnd);
        uint256 idle0 = _m().idle0;
        leash.checkpoint(key);
        assertApproxEqAbs(_m().idle0 - idle0, MANAGED_FEE, 2, "swept into the treasury's inventory");
        assertTrue(_m().swept);

        swap(key, false, -10e18, ZERO_BYTES); // 0.1 currency1 of fees, on alice's watch
        vm.warp(auctionEnd + 1 days);
        leash.settle(key, 0);
        EpochRecord memory e = leash.epochRecord(key.toId(), 0);
        assertEq(e.fees0, 0);
        assertApproxEqAbs(e.fees1, MANAGED_FEE, 2);
        assertEq(leash.owed(alice, currency0), 0);
        assertEq(leash.owed(alice, currency1), uint256(e.fees1) * 3000 / 10_000);
        _assertLedger();
    }

    /// Same split when nobody checkpoints after the auction and the first touch is a swap: the hook measures the
    /// pre-hire fees in that swap's beforeSwap, so the epoch's own fees are not swept to the treasury with them.
    function test_settle_epochFeesCountWhenASwapComesFirst() public {
        swap(key, true, -10e18, ZERO_BYTES); // 0.1 currency0 of fees, before anyone manages
        vm.prank(alice);
        leash.bid(key, 10e18);
        vm.warp(auctionEnd);
        swap(key, false, -10e18, ZERO_BYTES); // 0.1 currency1 of fees, on alice's watch, before any checkpoint
        assertFalse(_m().swept);

        uint256 idle0 = _m().idle0;
        vm.warp(auctionEnd + 1 days);
        leash.settle(key, 0);
        EpochRecord memory e = leash.epochRecord(key.toId(), 0);
        assertEq(e.fees0, 0, "pre-hire fees are not the epoch's");
        assertApproxEqAbs(_m().idle0 - idle0, MANAGED_FEE, 2, "pre-hire fees swept into the treasury's inventory");
        assertApproxEqAbs(e.fees1, MANAGED_FEE, 2, "the epoch's fees stay the epoch's");
        assertEq(leash.owed(alice, currency1), uint256(e.fees1) * 3000 / 10_000);
        _assertLedger();
    }

    function test_settle_needsAManager() public {
        vm.warp(auctionEnd + 1 days);
        vm.expectRevert(Leash.NotActive.selector);
        leash.settle(key, 0);
    }

    // ---------------------------------------------------------------- swaps never brick

    /// A small swap each way. A revert here means the hook halted the pool.
    function _swapBothWays() internal {
        int24 t = _tick();
        _swapTo(true, 1e15, t - 60);
        _swapTo(false, 1e15, t + 60);
    }

    function test_swap_neverBricks_cleanLifecycle() public {
        _swapBothWays(); // auction open, no bids
        vm.prank(alice);
        leash.bid(key, 10e18);
        _swapBothWays(); // auction open, a bid
        vm.warp(auctionEnd);
        _swapBothWays(); // active
        vm.warp(auctionEnd + 3 days + 1 hours);
        _swapBothWays(); // ended, unsettled, not closed: books the tail
        _swapBothWays();
        leash.close(key);
        _swapBothWays(); // closed, empty pool
    }

    function test_swap_neverBricks_noBids() public {
        vm.warp(auctionEnd + 1 hours);
        _swapBothWays();
        leash.close(key);
        _swapBothWays();
    }

    function test_swap_neverBricks_breached() public {
        _win();
        _swapTo(false, 100e18, 900);
        vm.warp(auctionEnd + 1 days);
        leash.settle(key, 0);
        assertTrue(_m().breached);
        _swapBothWays(); // breached, out of range
        vm.warp(auctionEnd + 3 days + 1);
        _swapBothWays(); // breached and ended
        leash.close(key);
        _swapBothWays();
    }

    /// Worst case for the checkpoint loop: the maximum 104 one-hour epochs and no activity at all until after the
    /// end. The first swap afterwards books every epoch, and must fit the 2^24 per-transaction gas cap.
    function test_swap_afterQuietGapAcrossAllEpochs() public {
        key = _key(10);
        Terms memory t = _terms();
        (t.epochs, t.epochLength) = (105, 1 hours);
        vm.expectRevert(Leash.BadTerms.selector);
        leash.createMandate(key, SQRT_PRICE_1_1, t, 100e18, 100e18, _initial());
        t.epochs = 104;
        leash.createMandate(key, SQRT_PRICE_1_1, t, 100e18, 100e18, _initial());
        vm.prank(alice);
        leash.bid(key, 10e18);
        vm.warp(auctionEnd + 105 hours);

        int24 tick = _tick();
        uint256 g = gasleft();
        _swapTo(true, 1e15, tick - 60);
        uint256 used = g - gasleft();
        emit log_named_uint("swap gas after a quiet gap over 104 epochs", used);
        assertLt(used, 1 << 24, "fits the per-transaction gas cap");
        assertEq(leash.epochRecord(key.toId(), 0).inSecs, 1 hours);
        assertEq(leash.epochRecord(key.toId(), 103).inSecs, 1 hours);
        _swapBothWays();
    }

    // ---------------------------------------------------------------- dynamic fee

    function test_dynamicFee_equalsSetFeeAtTwap() public {
        _win();
        vm.prank(alice);
        leash.setFee(key, 500);
        assertEq(leash.twapTick(key), _tick());
        assertEq(_feeOfSwap(true), 500, "at the TWAP: the manager's fee");
        (,,, uint24 lpFee) = manager.getSlot0(key.toId());
        assertEq(lpFee, 500, "the override never changes the stored fee");
    }

    /// Spot pushed 100 and 200 ticks off a TWAP of 0 (same block, so the TWAP hasn't moved): +10 pips per tick
    /// beyond the 10-tick free band.
    function test_dynamicFee_risesWithDeviation() public {
        _win();
        vm.prank(alice);
        leash.setFee(key, 500);
        _swapTo(false, 1e30, 5);
        assertEq(_feeOfSwap(true), 500, "inside the free band");
        _swapTo(false, 1e30, 100);
        assertEq(_feeOfSwap(true), 500 + 90 * 10);
        _swapTo(false, 1e30, 200);
        assertEq(_feeOfSwap(true), 500 + 190 * 10);
        _swapTo(true, 1e30, -200); // either side
        assertEq(_feeOfSwap(false), 500 + 190 * 10);
        assertEq(leash.twapTick(key), 0);
    }

    function test_dynamicFee_neverExceedsMaxFee() public {
        _win();
        vm.prank(alice);
        leash.setFee(key, 9_000);
        _swapTo(false, 1e30, 2000);
        assertEq(_feeOfSwap(true), 10_000, "capped at maxFee");
        _swapTo(false, 1e30, 20_000);
        assertEq(_feeOfSwap(true), 10_000);
    }

    // ---------------------------------------------------------------- partial slash

    /// Out of range for the last 2h of epoch 0: 48 minutes over the 72 allowed, so 48/72 of the bond goes to the
    /// treasury. The manager keeps the rest and its job; clean epochs after that return the remainder at the end.
    function test_partialSlash_proportionalToTimeOverAllowance() public {
        _win();
        vm.warp(auctionEnd + 22 hours);
        _swapTo(false, 100e18, 900);
        vm.warp(auctionEnd + 1 days);
        uint256 slashed = uint256(10e18) * 48 / 72;
        vm.expectEmit(address(leash));
        emit Leash.EpochSettled(key.toId(), 0, false, 0, 0, slashed);
        leash.settle(key, 0);

        Mandate memory m = _m();
        assertFalse(m.breached, "not fired");
        assertEq(m.bond, 10e18 - slashed);
        assertEq(leash.owed(address(this), currency1), slashed, "slash to the treasury");
        (uint32 clean, uint32 breached) = leash.records(alice);
        assertEq(clean, 0);
        assertEq(breached, 1);
        _assertLedger();

        vm.prank(alice);
        leash.rebalance(key, 600, 1200, 1_000e18); // still the manager: repairs
        vm.warp(auctionEnd + 3 days);
        leash.close(key);
        assertTrue(leash.epochRecord(key.toId(), 1).clean && leash.epochRecord(key.toId(), 2).clean);
        uint256 pay1 =
            (uint256(leash.epochRecord(key.toId(), 1).fees1) + leash.epochRecord(key.toId(), 2).fees1) * 3000 / 10_000;
        assertEq(leash.owed(alice, currency1), 10e18 - slashed + pay1, "the rest of the bond back, plus pay");
        _assertLedger();
    }

    /// Exactly twice the allowance (144 min) fires; one second less doesn't.
    function test_partialSlash_firesAtTwiceTheAllowance() public {
        uint256 snap = vm.snapshotState();
        _win();
        vm.warp(auctionEnd + 1 days - 144 minutes + 1);
        _swapTo(false, 100e18, 900);
        vm.warp(auctionEnd + 1 days);
        leash.settle(key, 0);
        assertFalse(_m().breached);
        assertGt(_m().bond, 0);
        vm.revertToState(snap);

        _win();
        vm.warp(auctionEnd + 1 days - 144 minutes);
        _swapTo(false, 100e18, 900);
        vm.warp(auctionEnd + 1 days);
        leash.settle(key, 0);
        assertTrue(_m().breached, "fired");
        assertEq(_m().bond, 0);
        assertEq(leash.owed(address(this), currency1), 10e18, "whole bond to the treasury");
    }

    // ---------------------------------------------------------------- keeper bounty

    /// Bob settles epoch 0: he earns 10 bps of the treasury's 70% of the fees; alice's 30% is untouched. Settling
    /// again reverts, so it can't be farmed.
    function test_keeperBounty_paidFromTreasuryShareOnce() public {
        _win();
        swap(key, true, -10e18, ZERO_BYTES);
        swap(key, false, -10e18, ZERO_BYTES);
        vm.warp(auctionEnd + 1 days);
        uint256 idle0 = _m().idle0;
        vm.prank(bob);
        leash.settle(key, 0);
        EpochRecord memory e = leash.epochRecord(key.toId(), 0);
        uint256 pay0 = uint256(e.fees0) * 3000 / 10_000;
        uint256 tip0 = (e.fees0 - pay0) * 10 / 10_000;
        assertGt(tip0, 0);
        assertEq(leash.owed(alice, currency0), pay0, "manager's pay untouched");
        assertEq(leash.owed(bob, currency0), tip0, "keeper: 10 bps of the treasury's share");
        assertEq(leash.owed(bob, currency1), (e.fees1 - uint256(e.fees1) * 3000 / 10_000) * 10 / 10_000);
        assertEq(_m().idle0, idle0 + e.fees0 - pay0 - tip0, "the treasury keeps the rest");
        assertEq(_m().bond, 10e18, "never from the bond");
        _assertLedger();

        vm.prank(bob);
        vm.expectRevert(Leash.BadEpoch.selector);
        leash.settle(key, 0);
    }

    /// The treasury settling (or close settling for it) pays itself nothing; checkpoints pay nobody.
    function test_keeperBounty_notForTreasuryOrCheckpoint() public {
        _win();
        swap(key, true, -10e18, ZERO_BYTES);
        vm.prank(bob);
        leash.checkpoint(key);
        assertEq(leash.owed(bob, currency0), 0, "checkpoint pays nothing");
        vm.warp(auctionEnd + 3 days);
        leash.close(key);
        assertEq(leash.owed(address(this), currency0), 0, "no bounty to the treasury");
        _assertLedger();
    }

    // ---------------------------------------------------------------- minimum bond

    /// minBond must be at least 2% of the deposit's value: 200 at 1:1 needs 4.
    function test_minBond_atLeastTwoPercentOfDeposit() public {
        key = _key(10);
        Terms memory t = _terms();
        t.minBond = 4e18 - 1;
        vm.expectRevert(Leash.ThinBond.selector);
        leash.createMandate(key, SQRT_PRICE_1_1, t, 100e18, 100e18, _initial());
        t.minBond = 4e18;
        leash.createMandate(key, SQRT_PRICE_1_1, t, 100e18, 100e18, _initial());
    }

    /// Stablecoin is currency0 at 4 currency1 each: the deposit (100 + 100) is worth 500 currency1, so the bond
    /// floor is 10 currency1 = 2.5 of the stablecoin.
    function test_minBond_valuedInTheStablecoin() public {
        key = _key(30);
        Terms memory t = _terms();
        (t.stableIs0, t.anchorLiquidity, t.startStableBps) = (true, 30e18, 10_000);
        Position memory p = Position(13_200, 14_400, 500e18);
        t.minBond = 2.5e18 - 1;
        vm.expectRevert(Leash.ThinBond.selector);
        leash.createMandate(key, 2 * SQRT_PRICE_1_1, t, 100e18, 100e18, p);
        t.minBond = 2.5e18;
        leash.createMandate(key, 2 * SQRT_PRICE_1_1, t, 100e18, 100e18, p);
    }

    // ---------------------------------------------------------------- close

    function test_close_returnsEverything() public {
        _win();
        vm.prank(alice);
        leash.rebalance(key, -1200, 1200, 1_000e18);

        vm.expectRevert(Leash.NotEnded.selector);
        leash.close(key);
        vm.warp(auctionEnd + 3 days);
        vm.prank(alice);
        vm.expectRevert(Leash.NotTreasury.selector);
        leash.close(key);

        uint256 before0 = _bal(currency0, address(this));
        uint256 before1 = _bal(currency1, address(this));
        leash.close(key);
        assertApproxEqAbs(_bal(currency0, address(this)) - before0, 100e18, 4, "treasury got currency0 back");
        assertApproxEqAbs(_bal(currency1, address(this)) - before1, 100e18, 4, "treasury got currency1 back");
        assertEq(leash.owed(alice, currency1), 10e18, "bond returned");
        assertEq(manager.getLiquidity(key.toId()), 0);
    }

    /// Nobody settled during the mandate: close settles all three epochs before handing the treasury its funds.
    function test_close_paysCleanManagerFirst() public {
        _win();
        swap(key, true, -10e18, ZERO_BYTES);
        vm.warp(auctionEnd + 3 days);
        leash.close(key);

        EpochRecord memory e0 = leash.epochRecord(key.toId(), 0);
        assertApproxEqAbs(e0.fees0, MANAGED_FEE, 2);
        assertEq(leash.owed(alice, currency0), uint256(e0.fees0) * 3000 / 10_000);
        assertEq(leash.owed(alice, currency1), 10e18, "bond back");
        (uint32 clean,) = leash.records(alice);
        assertEq(clean, 3);
        assertEq(_m().settled, 3);
        _assertLedger();
        vm.startPrank(alice);
        leash.claim(currency0);
        leash.claim(currency1);
        vm.stopPrank();
        assertEq(_bal(currency0, address(leash)), 0);
        assertEq(_bal(currency1, address(leash)), 0);
    }

    function test_close_noBids_afterAuction() public {
        vm.warp(auctionEnd);
        leash.close(key);
        assertTrue(_m().closed);
        assertEq(_bal(currency0, address(leash)), 0);
    }
}
