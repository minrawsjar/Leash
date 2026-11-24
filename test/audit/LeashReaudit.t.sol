// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Deployers} from "@uniswap/v4-core/test/utils/Deployers.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {Hooks} from "v4-core/libraries/Hooks.sol";
import {LPFeeLibrary} from "v4-core/libraries/LPFeeLibrary.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";
import {FullMath} from "v4-core/libraries/FullMath.sol";
import {SqrtPriceMath} from "v4-core/libraries/SqrtPriceMath.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {SwapParams} from "v4-core/types/PoolOperation.sol";
import {PoolSwapTest} from "v4-core/test/PoolSwapTest.sol";
import {LiquidityAmounts} from "v4-periphery/src/libraries/LiquidityAmounts.sol";
import {Leash, Terms, Position, Mandate, EpochRecord} from "../../src/Leash.sol";

/// Re-audit PoCs against the round-3 fixes (anchor, minHalfWidth, minFee, same-block rules, grow rule, truncated
/// oracle). Same setup as test/audit/LeashAudit.t.sol: 100/100 at 1:1, managed [-600, 600) L=1000e18, anchor 20e18
/// full range, bond 10e18 in currency1, TWAP 1800s, maxTickDeviation 100, minHalfWidth 200, fee floor 0.05%.
contract LeashReauditTest is Test, Deployers {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for *;

    uint160 constant FLAGS =
        uint160(Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG | Hooks.BEFORE_SWAP_FLAG);

    Leash leash;
    address alice = makeAddr("alice"); // manager
    address arb = makeAddr("arb"); // arbitrageur
    uint40 auctionEnd;

    function setUp() public {
        deployFreshManagerAndRouters();
        (currency0, currency1) = deployMintAndApprove2Currencies();
        address hook = address(FLAGS ^ (0x4444 << 144));
        deployCodeTo("Leash.sol:Leash", abi.encode(manager), hook);
        leash = Leash(hook);
        key = PoolKey(currency0, currency1, LPFeeLibrary.DYNAMIC_FEE_FLAG, 60, IHooks(hook));

        _approveAll();
        auctionEnd = uint40(block.timestamp + 1 days);
        leash.createMandate(key, SQRT_PRICE_1_1, _terms(), 100e18, 100e18, Position(-600, 600, 1_000e18));

        address[2] memory who = [alice, arb];
        for (uint256 i; i < 2; i++) {
            MockERC20(Currency.unwrap(currency0)).mint(who[i], 1_000_000e18);
            MockERC20(Currency.unwrap(currency1)).mint(who[i], 1_000_000e18);
            vm.startPrank(who[i]);
            _approveAll();
            vm.stopPrank();
        }
    }

    function _approveAll() internal {
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
            endStableBps: 10_000,
            minFee: 500,
            minHalfWidth: 200,
            anchorLiquidity: 20e18
        });
    }

    function _m() internal view returns (Mandate memory) {
        return leash.mandate(key.toId());
    }

    function _bal(Currency c, address who) internal view returns (uint256) {
        return MockERC20(Currency.unwrap(c)).balanceOf(who);
    }

    function _tick() internal view returns (int24 tick) {
        (, tick,,) = manager.getSlot0(key.toId());
    }

    function _sqrt(int24 t) internal pure returns (uint160) {
        return TickMath.getSqrtPriceAtTick(t);
    }

    /// Value in currency1 at the market price of tick `t`, counting what the hook owes `who` (pay, not the bond).
    function _valueAt(address who, int24 t) internal view returns (int256) {
        uint160 p = _sqrt(t);
        uint256 a0 = _bal(currency0, who) + leash.owed(who, currency0);
        uint256 a1 = _bal(currency1, who) + leash.owed(who, currency1);
        return int256(FullMath.mulDiv(FullMath.mulDiv(a0, p, 1 << 96), p, 1 << 96) + a1);
    }

    function _swapAs(address who, bool zeroForOne, uint160 limit) internal {
        vm.prank(who);
        swapRouter.swap(key, SwapParams(zeroForOne, 1e30, limit), PoolSwapTest.TestSettings(false, false), ZERO_BYTES);
    }

    function _moveTo(address who, int24 t) internal {
        (uint160 p,,,) = manager.getSlot0(key.toId());
        uint160 target = _sqrt(t);
        if (p != target) _swapAs(who, target < p, target);
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

    function _keep(uint256 until) internal {
        while (block.timestamp + 1 minutes <= until) {
            _next(1 minutes);
            leash.checkpoint(key);
        }
    }

    function _round(int256 t, bool up) internal pure returns (int24) {
        int256 f = t - (t % 60);
        if (t % 60 < 0) f -= 60;
        return int24(up && f != t ? f + 60 : f);
    }

    /// The most liquidity the mandate's inventory (idle plus the current managed position, at spot) can put in [lo, hi).
    function _maxLiquidity(int24 lo, int24 hi) internal view returns (uint128) {
        Mandate memory m = _m();
        (uint160 p,,,) = manager.getSlot0(key.toId());
        (uint160 l, uint160 h) = (_sqrt(m.tickLower), _sqrt(m.tickUpper));
        uint256 a0 = m.idle0 + (p < h ? SqrtPriceMath.getAmount0Delta(p > l ? p : l, h, m.liquidity, false) : 0);
        uint256 a1 = m.idle1 + (p > l ? SqrtPriceMath.getAmount1Delta(l, p < h ? p : h, m.liquidity, false) : 0);
        uint256 most = LiquidityAmounts.getLiquidityForAmounts(p, _sqrt(lo), _sqrt(hi), a0, a1) * 999 / 1000;
        uint256 step = uint256(m.liquidity) * 10_500 / 10_000; // growth is capped at 5% per TWAP window
        return uint128(most < step ? most : step);
    }

    function _settleCleanWithKeeper() internal {
        _keep(auctionEnd + 1 days);
        vm.warp(auctionEnd + 1 days);
        leash.settle(key, 0);
        assertTrue(leash.epochRecord(key.toId(), 0).clean, "the manager stays clean");
        assertEq(_m().bond, 10e18, "and keeps its bond");
    }

    // ================================================================ R-1: growth at a stale TWAP

    /// R-1a. The grow rule trusts the TWAP as fair. After a calm hour (spot == TWAP == 0), the market jumps 10%
    /// (tick 1000) between two blocks. The pool still sits at the old price, so spot == TWAP and growth is allowed.
    /// The manager, first in the next block, grows the whole inventory into [-240, 1080) at the stale price, then
    /// arbitrages it to the new market itself: the treasury sells its whole currency0 side at the pre-jump price.
    /// Compared with an ordinary arbitrageur trading the same jump against the untouched position.
    function _r1a(int24 jump) internal returns (int256 arbOnly, int256 manager) {
        _win();
        vm.prank(alice);
        leash.setFee(key, 500);
        _keep(auctionEnd + 1 hours); // calm: spot == TWAP == 0
        _next(12); // the market jumps off-chain; the pool hasn't traded yet this block

        uint256 snap = vm.snapshotState();
        int256 arb0 = _valueAt(arb, jump);
        _moveTo(arb, jump);
        arbOnly = _valueAt(arb, jump) - arb0;
        vm.revertToState(snap);

        int256 alice0 = _valueAt(alice, jump);
        int24 hi = _round(int256(jump) + 60, true);
        uint128 l = _maxLiquidity(-240, hi);
        vm.prank(alice);
        leash.rebalance(key, -240, hi, l); // spot == TWAP: growth allowed
        _moveTo(alice, jump);
        manager = _valueAt(alice, jump) - alice0;
        emit log_named_int("jump (ticks)", jump);
        emit log_named_decimal_int("  plain arbitrageur's take from the jump", arbOnly, 18);
        emit log_named_decimal_int("  manager's take (grow at stale price, then arb)", manager, 18);
        _settleCleanWithKeeper();
    }

    function test_limit_managerPlacesAtStalePriceAfterJump() public {
        int24[2] memory jumps = [int24(1000), 3000];
        int256[2] memory extra;
        for (uint256 i; i < 2; i++) {
            uint256 snap = vm.snapshotState();
            (int256 a, int256 m) = _r1a(jumps[i]);
            extra[i] = m - a;
            vm.revertToState(snap);
        }
        emit log_named_decimal_int("treasury's extra loss, 10% jump", extra[0], 18);
        emit log_named_decimal_int("treasury's extra loss, 35% jump", extra[1], 18);
        // Known limit (README): growth is capped at 5% per TWAP window, which cut the 10% case from 1.76 to ~0.54.
        // What's left is re-ranging into the jump's path at the same size, which no on-chain rule tells apart from
        // an honest re-range: an informed manager's edge, bounded by the inventory in the path (~0.3% and ~2.6% of
        // the 200-token inventory here). The bounds catch any regression.
        assertLe(extra[0], 0.6e18, "10% jump: extra loss stays bounded");
        assertLe(extra[1], 5.5e18, "35% jump: extra loss stays bounded");
    }

    /// R-1b. The same after a gradual move, for a manager that owns one block boundary (the fixer's C-1 threat
    /// model). The market moves to tick 1000 and stays; arbitrage keeps spot there. 15 minutes later the TWAP lags at
    /// ~500. Last in block N the manager sells spot down to the TWAP (only the anchor and a sliver of the old
    /// position are in the path); first in block N+1 spot == TWAP, so it grows the whole inventory around the stale
    /// TWAP and buys the treasury's currency0 back up to the market.
    function test_limit_managerOwningBlockBoundaryPlacesAtLaggingTwap() public {
        _win();
        vm.prank(alice);
        leash.setFee(key, 500);
        _keep(auctionEnd + 1 hours);
        _next(12);
        _moveTo(arb, 1000); // genuine move: the market is at 1000 from here on
        _keep(block.timestamp + 15 minutes);

        int256 alice0 = _valueAt(alice, 1000);
        _next(12);
        int24 t = leash.twapTick(key);
        _moveTo(alice, t + 3); // last in block N
        _next(12);
        t = leash.twapTick(key);
        int256 gap = int256(_tick()) - t;
        emit log_named_int("TWAP at block N+1", t);
        emit log_named_int("spot - TWAP", gap);
        (int24 lo, int24 hi) = (_round(int256(t) - 200, false), int24(1080));
        uint128 l = _maxLiquidity(lo, hi);
        vm.prank(alice);
        leash.rebalance(key, lo, hi, l); // first in block N+1: growth allowed
        _moveTo(alice, 1000);
        int256 gain = _valueAt(alice, 1000) - alice0;
        emit log_named_decimal_int("manager P&L at market (tokens)", gain, 18);
        emit log_named_uint("managed liquidity grew from 1000e18 to", l / 1e18);
        _settleCleanWithKeeper();
        assertLe(l, 1_050e18, "growth capped at 5% (was 1997e18)");
        assertLe(gain, 0.5e18, "known limit: bounded (1.02 before the growth cap)");
    }

    // ================================================================ R-2: honest manager can't follow real moves

    /// Every minute: checkpoint, and if out of compliance, try to re-range around both spot and the TWAP at the same
    /// (or smaller, if inventory is short) size, as an honest manager would.
    function _honestKeep(uint256 until) internal returns (uint256 refused) {
        while (block.timestamp + 1 minutes <= until) {
            _next(1 minutes);
            leash.checkpoint(key);
            (bool inRange,,,) = leash.compliance(key);
            if (inRange) continue;
            int256 t = leash.twapTick(key);
            int256 s = _tick();
            int24 lo = _round((t < s ? t : s) - 300, false);
            int24 hi = _round((t > s ? t : s) + 300, true);
            uint128 l = _maxLiquidity(lo, hi);
            if (l > _m().liquidity) l = _m().liquidity;
            vm.prank(alice);
            try leash.rebalance(key, lo, hi, l) {}
            catch (bytes memory why) {
                assertEq(bytes4(why), Leash.SpotOffTwap.selector, "refused only by the spot-TWAP guard");
                refused++;
            }
        }
    }

    /// R-2. A volatile day: the market swings 30% (3000 ticks) and back, twice, two hours apart. An honest manager
    /// with a +-600 range re-ranges the first minute it's allowed. After each swing the TWAP leaves the range long
    /// before it comes within maxTickDeviation (100) of spot, and until then every rebalance reverts SpotOffTwap:
    /// ~23 minutes out per swing that the manager cannot avoid. Four swings exceed the 72 minutes allowed.
    function test_limit_honestManagerBreachedByVolatilityItCannotAnswer() public {
        _win();
        int24[4] memory swings = [int24(-3000), 0, -3000, 0];
        uint256 refused;
        for (uint256 i; i < 4; i++) {
            refused += _honestKeep(auctionEnd + 1 hours + i * 2 hours);
            _next(12);
            _moveTo(arb, swings[i]); // genuine move; the market stays there
        }
        refused += _honestKeep(auctionEnd + 1 days);
        vm.warp(auctionEnd + 1 days);
        leash.settle(key, 0);
        EpochRecord memory e = leash.epochRecord(key.toId(), 0);
        emit log_named_uint("rebalances refused (SpotOffTwap)", refused);
        emit log_named_uint("outSecs", e.outSecs);
        // Known limit, kept on purpose (README, Known limits): rebalancing at any spot-TWAP gap would let a manager
        // push spot past its range, re-range into the push path and sell back into the treasury. Managers of
        // volatile tokens keep wide ranges; treasuries size maxTickDeviation and uptimeBps for the token.
        assertFalse(e.clean, "documented: repeated 30% swings breach a +-600 range");
    }

    // ================================================================ R-3: anyone can veto a rebalance

    /// R-3. "No rebalance once the price moved this block" compares spot with the block's opening tick exactly, so a
    /// one-tick swap ordered ahead of the manager's rebalance reverts it (SameBlock). A genuine 9% move takes the
    /// TWAP out of an honest manager's range; from the moment it may re-range, eve (the treasury, who gets the bond,
    /// or anyone) nudges the price one tick at the top of every block. Every repair reverts and the manager is
    /// breached for dust. Assumes eve is ordered before the manager each block (priority fee on Unichain, or a
    /// builder on L1); ordinary swap flow does the same to a manager that doesn't win top-of-block.
    function test_R3_oneTickNudgeVetoesEveryRepair() public {
        _win();
        _keep(auctionEnd + 1 hours);
        _next(12);
        _moveTo(arb, 900); // genuine move; the market stays at 900
        int256 eve0 = _valueAt(arb, 900); // the arb doubles as the griefer
        uint256 vetoed;
        int24 nudge = 901;
        uint256 stop = block.timestamp + 110 minutes; // then eve stops and the manager repairs at once
        while (block.timestamp + 12 <= stop) {
            _next(12);
            (bool inRange,,,) = leash.compliance(key);
            if (!inRange) {
                _moveTo(arb, nudge); // top of block: one tick
                nudge = nudge == 901 ? int24(900) : int24(901);
                int256 t = leash.twapTick(key);
                int256 s = _tick();
                int24 lo = _round((t < s ? t : s) - 300, false);
                int24 hi = _round((t > s ? t : s) + 300, true);
                uint128 l = _maxLiquidity(lo, hi);
                if (l > _m().liquidity) l = _m().liquidity;
                vm.prank(alice);
                try leash.rebalance(key, lo, hi, l) {}
                catch (bytes memory why) {
                    if (bytes4(why) == Leash.SameBlock.selector) vetoed++;
                }
            }
            if (block.timestamp % 60 < 12) leash.checkpoint(key);
        }
        int256 cost = eve0 - _valueAt(arb, 900);
        _next(12);
        _honestKeep(auctionEnd + 1 days);
        vm.warp(auctionEnd + 1 days);
        leash.settle(key, 0);
        EpochRecord memory e = leash.epochRecord(key.toId(), 0);
        emit log_named_uint("repairs vetoed by SameBlock", vetoed);
        emit log_named_uint("outSecs", e.outSecs);
        emit log_named_decimal_int("griefer's cost (tokens)", cost, 18);
        emit log_named_decimal_uint("bond to the treasury", leash.owed(address(this), currency1), 18);
        assertTrue(e.clean, "a responsive manager was breached by one-tick nudges");
    }

    // ================================================================ C-2 re-check, smarter drag (expected to hold)

    /// The fixer's drag keeps the managed position in the push path ([-240, X+240)). Cheaper: keep it at the narrowest
    /// range [-240, 240) so above 240 only the anchor resists (the TWAP leaves the range for part of the window, inside
    /// the 72-minute allowance), and extract with a range spanning the whole dragged band [0, X+200) instead of the
    /// narrowest one. Arbitrageur restores 1:1 first thing every block; 12s blocks.
    function _c2Smart(int24 x) internal returns (int256 dragCost, int256 extracted) {
        _win();
        vm.startPrank(alice);
        leash.setFee(key, 500);
        leash.rebalance(key, -240, 240, _m().terms.minLiquidity);
        vm.stopPrank();
        _next(12);
        int256 alice0 = _valueAt(alice, 0);
        for (uint256 i; i < 151; i++) {
            _moveTo(arb, 0);
            _moveTo(alice, x);
            _next(12);
        }
        dragCost = alice0 - _valueAt(alice, 0);
        alice0 = _valueAt(alice, 0);
        int24 t = leash.twapTick(key);
        _moveTo(alice, t); // the boundary block's last move (spot == TWAP for the grow rule)
        _next(12);
        t = leash.twapTick(key);
        (int24 lo, int24 hi) = (int24(0), _round(int256(t) + 200, true));
        if (int256(lo) > int256(t) - 200) lo = _round(int256(t) - 200, false);
        uint128 l = _maxLiquidity(lo, hi);
        vm.prank(alice);
        leash.rebalance(key, lo, hi, l);
        _moveTo(alice, 1);
        extracted = _valueAt(alice, 0) - alice0;
    }

    function test_safe_smarterC2DragStillLoses() public {
        int24[3] memory xs = [int24(200), 300, 600];
        for (uint256 i; i < xs.length; i++) {
            uint256 snap = vm.snapshotState();
            (int256 cost, int256 gain) = _c2Smart(xs[i]);
            emit log_named_int("X (ticks)", xs[i]);
            emit log_named_decimal_int("  drag cost (managed range off the path)", cost, 18);
            emit log_named_decimal_int("  extracted (range over the whole band)", gain, 18);
            assertGt(cost, gain, "dragging still costs more than it extracts");
            vm.revertToState(snap);
        }
    }

    /// R-4. Nothing bounds anchorLiquidity or minLiquidity from below (only > 0), and the safety margin above is ~2x.
    /// A treasury that sizes the anchor at 10% of value and the depth floor at 25e18 (both plausible) makes the same
    /// drag-and-extract profitable at 12s blocks; the manager stays clean and keeps its bond.
    function test_R4_dragProfitableWithThinnerAnchorAndFloor() public {
        key = PoolKey(currency0, currency1, LPFeeLibrary.DYNAMIC_FEE_FLAG, 30, IHooks(address(leash)));
        Terms memory t = _terms();
        (t.anchorLiquidity, t.minLiquidity) = (10e18, 25e18);
        vm.expectRevert(Leash.ThinAnchor.selector); // fixed: the anchor must hold ~20% of the deposit
        leash.createMandate(key, SQRT_PRICE_1_1, t, 100e18, 100e18, Position(-600, 600, 1_000e18));
        t.anchorLiquidity = 20e18; // the thinnest legal anchor, still with the thin depth floor
        leash.createMandate(key, SQRT_PRICE_1_1, t, 100e18, 100e18, Position(-600, 600, 1_000e18));
        (int256 cost, int256 gain) = _c2Smart(300);
        emit log_named_decimal_int("drag cost", cost, 18);
        emit log_named_decimal_int("extracted", gain, 18);
        emit log_named_decimal_int("manager profit", gain - cost, 18);
        _settleCleanWithKeeper();
        assertGt(cost, gain, "dragging costs more than it extracts");
    }

    // ================================================================ coverage (expected to hold)

    /// Safe: fees the anchor earns never reach the manager. Same managed-range path in both runs; run B also trades
    /// far outside the managed range (anchor only). The manager's pay is identical; the treasury gets B's extra.
    function test_safe_anchorFeesNeverPayTheManager() public {
        uint256[2] memory pay;
        uint256[2] memory treasury;
        int24[2] memory far = [int24(600), 3000];
        for (uint256 i; i < 2; i++) {
            uint256 snap = vm.snapshotState();
            _win();
            _next(12);
            for (uint256 k; k < 5; k++) {
                _moveTo(arb, far[i]); // in and back within one block: the TWAP never sees it
                _moveTo(arb, 0);
            }
            _keep(auctionEnd + 3 days);
            vm.warp(auctionEnd + 3 days);
            (uint256 b0, uint256 b1) = (_bal(currency0, address(this)), _bal(currency1, address(this)));
            leash.close(key);
            pay[i] = leash.owed(alice, currency0) + leash.owed(alice, currency1) - 10e18;
            treasury[i] = (_bal(currency0, address(this)) - b0) + (_bal(currency1, address(this)) - b1);
            vm.revertToState(snap);
        }
        assertEq(pay[0], pay[1], "anchor-only fees add nothing to the manager's pay");
        assertGt(treasury[1], treasury[0], "they go to the treasury");
    }

    /// Safe: a breach in the final epoch sends the bond to the treasury once; close credits the manager nothing.
    function test_safe_finalEpochBreachBondGoesToTreasuryOnce() public {
        _win();
        _keep(auctionEnd + 2 days + 20 hours);
        _next(12);
        _moveTo(arb, 2000); // genuine move late in the final epoch; the passive manager doesn't follow
        _keep(auctionEnd + 3 days);
        vm.warp(auctionEnd + 3 days);
        leash.close(key);
        assertTrue(leash.epochRecord(key.toId(), 1).clean);
        assertFalse(leash.epochRecord(key.toId(), 2).clean);
        assertEq(leash.owed(address(this), currency1), 10e18, "bond to the treasury");
        assertLt(leash.owed(alice, currency1), 1e18, "only pay to the manager, no bond");
        assertEq(_bal(currency1, address(leash)), leash.owed(alice, currency1) + 10e18, "ledger: only owed remains");
        assertEq(_bal(currency0, address(leash)), leash.owed(alice, currency0));
    }
}
