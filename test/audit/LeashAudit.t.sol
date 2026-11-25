// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {LPFeeLibrary} from "v4-core/libraries/LPFeeLibrary.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {SwapParams} from "v4-core/types/PoolOperation.sol";
import {PoolSwapTest} from "v4-core/test/PoolSwapTest.sol";
import {Leash, Terms, Position, EpochRecord} from "../../src/Leash.sol";
import {LeashBase} from "../utils/LeashBase.sol";

/// Audit PoCs. Each test asserts the property Leash is meant to guarantee; a failure is the finding.
/// The shared mandate (test/utils/LeashBase.sol); alice is the manager, eve an outsider, arb the market.
contract LeashAuditTest is LeashBase {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for *;

    address eve = makeAddr("eve"); // outsider
    address arb = makeAddr("arb"); // arbitrageur: trades the price back to 1:1, the market price in these tests

    function setUp() public override {
        _deploy();
        _fund(alice, 1_000_000e18, 1_000_000e18);
        _fund(eve, 1_000_000e18, 1_000_000e18);
        _fund(arb, 1_000_000e18, 1_000_000e18);
    }

    /// Value at the 1:1 market price.
    function _value(address who) internal view returns (uint256) {
        return _bal(currency0, who) + _bal(currency1, who);
    }

    function _swapToTick(address who, int24 t) internal {
        _swapAs(who, t < _tick(), _sqrt(t));
    }

    /// The narrowest legal range now: TWAP +- minHalfWidth (200), widened to the tick spacing.
    function _narrowest() internal view returns (int24 lo, int24 hi) {
        int256 t = leash.twapTick(key);
        (lo, hi) = (_round(t - 200, false), _round(t + 200, true));
    }

    /// Value gained since `start`, at the 1:1 market price, counting pay the hook owes (not the bond).
    function _pnl(address who, uint256 start) internal view returns (int256) {
        return int256(_value(who) + leash.owed(who, currency0) + leash.owed(who, currency1)) - int256(start);
    }

    // ================================================================ C-1

    /// C-1, fixed: the fee can't go to 0 and the position can't be 60 ticks wide. A rebalance may follow a push in
    /// the same block only if it doesn't grow the position, and then the push and the push back meet the same
    /// liquidity, so the loop pays fees for nothing.
    function test_C1_managerDrainsBySameBlockSandwichLoop() public {
        _win();
        vm.startPrank(alice);
        vm.expectRevert(Leash.FeeTooLow.selector);
        leash.setFee(key, 0);
        leash.setFee(key, 500);
        vm.expectRevert(Leash.RangeMissesTwap.selector);
        leash.rebalance(key, -60, 60, 100e18);
        vm.stopPrank();
        _moveTo(alice, 60);
        vm.prank(alice);
        vm.expectRevert(Leash.SameBlock.selector);
        leash.rebalance(key, -240, 240, 1_001e18); // growth after an in-block move

        uint256 alice0 = _value(alice);
        for (uint256 i; i < 20; i++) {
            _moveTo(alice, leash.twapTick(key) + 99);
            (int24 lo, int24 hi) = i % 2 == 0 ? _narrowest() : (int24(-600), int24(600));
            vm.prank(alice);
            leash.rebalance(key, lo, hi, 1_000e18); // same size, re-ranged behind the push
            _moveTo(alice, 0);
            _next(12);
        }
        vm.warp(auctionEnd + 1 days);
        leash.settle(key, 0);
        int256 pnl = _pnl(alice, alice0);
        emit log_named_decimal_int("manager P&L over 20 same-block loops (incl. pay)", pnl, 18);
        assertLe(pnl, 0, "same-size re-ranging behind a push loses");
    }

    /// The strongest sandwich still legal, one cycle per two blocks, fee at the 0.05% floor. Block 1: shrink to
    /// minLiquidity in the narrowest legal range, push spot to TWAP + 99 (the guard allows 100) through it and the
    /// anchor. Block 2: re-place the whole inventory in the narrowest legal range at the pushed spot, then sell back
    /// down to 1:1 into it. With `arbitraged`, an arbitrageur backruns the push in block 1; without, the manager
    /// owns the block boundary (last in block 1, first in block 2) and nobody trades in between.
    function _c1(bool arbitraged, uint256 cycles) internal returns (int256 managerPerCycle, int256 arbPerCycle) {
        _win();
        vm.prank(alice);
        leash.setFee(key, 500);
        (uint256 alice0, uint256 arb0) = (_value(alice), _value(arb));
        for (uint256 i; i < cycles; i++) {
            (int24 lo, int24 hi) = _narrowest();
            vm.prank(alice);
            leash.rebalance(key, lo, hi, 100e18);
            _moveTo(alice, leash.twapTick(key) + 99);
            if (arbitraged) _moveTo(arb, 0);
            _next(12);
            (lo, hi) = _narrowest();
            uint128 l = _maxLiquidity(lo, hi);
            vm.prank(alice);
            try leash.rebalance(key, lo, hi, l) {}
            catch {
                // Growing the position off the TWAP is refused: the best legal move is to re-range at the same size.
                vm.prank(alice);
                leash.rebalance(key, lo, hi, 100e18);
            }
            _moveTo(alice, 0);
            _next(12);
        }
        vm.warp(auctionEnd + 1 days);
        leash.settle(key, 0);
        assertTrue(leash.epochRecord(key.toId(), 0).clean, "the sandwiching manager stays clean");
        managerPerCycle = _pnl(alice, alice0) / int256(cycles);
        arbPerCycle = _pnl(arb, arb0) / int256(cycles);
    }

    function test_C1_strongestLegalSandwich_arbitraged() public {
        (int256 m, int256 a) = _c1(true, 20);
        emit log_named_decimal_int("manager P&L per cycle (tokens, incl. pay)", m, 18);
        emit log_named_decimal_int("arbitrageur P&L per cycle", a, 18);
        assertLe(m, 0, "the manager loses every attempt");
    }

    function test_C1_strongestLegalSandwich_managerOwnsBlockBoundary() public {
        (int256 m,) = _c1(false, 20);
        emit log_named_decimal_int("manager P&L per cycle (tokens, incl. pay)", m, 18);
        assertLe(m, 0, "no profit even when nobody trades between the push and the re-placement");
    }

    // ================================================================ C-2

    /// C-2, fixed: parking the price at MAX_TICK now means buying out the full-range anchor; the swap can't even be
    /// expressed (the amount overflows int128). And whatever price is held for a block moves the TWAP <= 4 ticks.
    function test_C2_managerDrainsByParkingPriceAtMaxTickForOneBlock() public {
        _win();
        vm.prank(alice);
        vm.expectRevert();
        swapRouter.swap(
            key,
            SwapParams(false, 1e30, TickMath.MAX_SQRT_PRICE - 1),
            PoolSwapTest.TestSettings(false, false),
            ZERO_BYTES
        );

        _moveTo(alice, 100_000); // as far as ~3,000 tokens through the anchor buys
        _next(12);
        assertLe(leash.twapTick(key), 4, "one block anywhere moves the TWAP <= 4 ticks");
        int24 t = leash.twapTick(key);
        vm.prank(alice);
        vm.expectRevert(Leash.SpotOffTwap.selector); // spot is far from a TWAP that hasn't moved
        leash.rebalance(key, _round(t - 200, false), _round(100_000 + 240, true), 100e18);
    }

    /// The strongest legal C-2, against an arbitrageur who restores 1:1 first thing every block. The manager drags
    /// the TWAP by ending every block with spot at +X for one window (shrunk to minLiquidity in a range that keeps
    /// it compliant on the way), then, first in a block, re-places the whole inventory around the dragged TWAP
    /// (spot == TWAP, so even growth is allowed) and sells down to 1:1 into it. Returns its P&L, split into the
    /// drag's cost and the extraction.
    function _c2(int24 x) internal returns (int256 dragCost, int256 extracted) {
        _win();
        vm.startPrank(alice);
        leash.setFee(key, 500);
        leash.rebalance(key, -240, _round(int256(x) + 240, true), 100e18);
        vm.stopPrank();
        _next(12);
        uint256 alice0 = _value(alice);
        for (uint256 i; i < 151; i++) {
            _moveTo(arb, 0);
            _moveTo(alice, x);
            _next(12);
        }
        dragCost = -_pnl(alice, alice0);
        emit log_named_int("TWAP after the drag", leash.twapTick(key));
        alice0 = _value(alice);
        (int24 lo, int24 hi) = _narrowest();
        uint128 l = _maxLiquidity(lo, hi);
        vm.prank(alice);
        leash.rebalance(key, lo, hi, l);
        _moveTo(alice, 0);
        extracted = _pnl(alice, alice0);
    }

    function test_C2_strongestLegalDragThenExtract() public {
        int24[3] memory xs = [int24(300), 600, 1200];
        for (uint256 i; i < xs.length; i++) {
            uint256 snap = vm.snapshotState();
            (int256 cost, int256 gain) = _c2(xs[i]);
            emit log_named_int("X (ticks)", xs[i]);
            emit log_named_decimal_int("  cost to drag the TWAP by X for one window", cost, 18);
            emit log_named_decimal_int("  extracted by re-placing around it", gain, 18);
            assertGt(cost, gain, "dragging costs more than it extracts");
            vm.revertToState(snap);
        }
    }

    /// The dynamic fee charges every swap 10 pips per tick of |spot - TWAP| beyond 10 ticks, so the drag (whose
    /// pushes start further and further off the dragging TWAP) pays more. With the flat fee (before this change),
    /// dragging by 600 ticks cost 16.58 tokens (test_C2_strongestLegalDragThenExtract's log, revision 2e9362f).
    function test_dynamicFee_dragPaysMore() public {
        (int256 cost, int256 gain) = _c2(600);
        emit log_named_decimal_int("cost to drag the TWAP by 600 ticks, with the surcharge", cost, 18);
        emit log_named_decimal_int("extracted", gain, 18);
        assertGt(cost, 16.58e18, "dearer than with a flat fee");
        assertGt(cost, gain);
    }

    // ================================================================ H-1

    /// H-1, fixed: the original one-block spikes can't reach MAX_TICK through the anchor, and a spike as far as
    /// ~3,000 tokens buys moves the TWAP <= 4 ticks, so three of them do nothing.
    function test_H1_outsiderForcesBreachWithThreeOneBlockSpikes() public {
        _win();
        for (uint256 i; i < 3; i++) {
            _keep(block.timestamp + 1 hours);
            _moveTo(eve, 100_000);
            _next(12);
            _moveTo(eve, 0);
            assertLe(leash.twapTick(key), 4);
        }
        _keep(auctionEnd + 1 days);
        vm.warp(auctionEnd + 1 days);
        leash.settle(key, 0);
        assertTrue(leash.epochRecord(key.toId(), 0).clean, "an always-in-range manager was breached");
    }

    /// The strongest legal H-1, against an arbitrageur who restores 1:1 first thing every block: eve ends every block
    /// with spot at the honest manager's upper edge (600), for the last 110 minutes of the epoch (a window to drag
    /// the TWAP out, then 80 minutes out of range > the 72 allowed). Every block she pays the round trip through the
    /// managed position and the anchor to the arbitrageur. Keeper every minute.
    function test_H1_strongestLegalBreachCostsFarMoreThanTheBond() public {
        _win();
        _keep(auctionEnd + 1 days - 110 minutes);
        uint256 eve0 = _value(eve);
        uint256 blocks;
        while (block.timestamp + 12 <= auctionEnd + 1 days) {
            _moveTo(arb, 0);
            _moveTo(eve, 600);
            _next(12);
            if (++blocks % 5 == 0) leash.checkpoint(key);
        }
        vm.warp(auctionEnd + 1 days);
        leash.settle(key, 0);
        int256 cost = -_pnl(eve, eve0);
        EpochRecord memory e = leash.epochRecord(key.toId(), 0);
        emit log_named_uint("blocks held", blocks);
        emit log_named_uint("outSecs", e.outSecs);
        emit log_named_decimal_int("attacker cost (tokens at 1:1)", cost, 18);
        emit log_named_decimal_uint("bond", 10e18, 18);
        assertFalse(e.clean, "held long enough, the TWAP really is out of range");
        assertGt(cost, 10 * 10e18, "forcing the breach costs > 10x the bond");
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
        assertEq(_bal(currency1, alice), 1_000_000e18, "clean manager has its bond back");
        assertEq(_m().bond, 0);

        // The treasury's later close owes the manager nothing more.
        leash.close(key);
        assertEq(leash.owed(alice, currency1), 0, "no double refund");
    }

    // ================================================================ L-1

    /// L-1, fixed: at most 104 epochs. close() with all 104 unsettled (one checkpoint booking every epoch, then
    /// 104 settles, each poking the position) stays under the EIP-7825 per-transaction cap of 2^24 gas.
    function test_L1_closeAfter365UnsettledEpochsExceedsTxGasCap() public {
        key = _key(10);
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

    /// Integral of the recorded tick over (from, now], from the history. Each interval records the tick in force,
    /// moved at most 50 ticks per second from the previous interval's recorded tick (the oracle's truncation); the
    /// creation observation records 0. Floor division, like _twap.
    function _refTwap(uint256 window) internal view returns (int24) {
        uint256 n = obsTime.length;
        uint256 oldest = n > 1024 ? obsTime[n - 1024] : obsTime[0];
        uint256 from = block.timestamp - window < oldest ? oldest : block.timestamp - window;
        int256 sum;
        int256 r;
        for (uint256 k; k < n; k++) {
            uint256 a = obsTime[k];
            uint256 b = k + 1 < n ? obsTime[k + 1] : block.timestamp;
            int256 cap = 50 * int256(b - a);
            int256 t = obsTickAfter[k];
            r = t > r + cap ? r + cap : t < r - cap ? r - cap : t;
            if (b <= from) continue;
            if (a < from) a = from;
            sum += r * int256(b - a);
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
        leash.setFee(key, 500); // the floor
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
