// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {Leash, Terms, Mandate, EpochRecord} from "../../src/Leash.sol";
import {LeashBase} from "../utils/LeashBase.sol";

/// Property tests on the shared mandate (test/utils/LeashBase.sol): each takes random inputs, works out from the rules
/// what must happen, and checks the hook did exactly that, refusal or result. 256 runs each by default.
/// Where a rule has a threshold, inputs come through _around, so a third of runs land on the edge or within 3 of it.
contract LeashFuzzTest is LeashBase {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for *;

    function _end() internal view returns (uint256) {
        return auctionEnd + 3 days;
    }

    /// A value in [lo, hi] from `seed`: one run in three lands within 3 of `edge`, where off-by-one bugs live (uniform
    /// inputs over a wide range almost never hit an exact threshold); the rest anywhere in the range.
    function _around(uint256 seed, int256 edge, int256 lo, int256 hi) internal pure returns (int256) {
        int256 v = seed % 3 == 0 ? edge + int256((seed >> 2) % 7) - 3 : int256(seed >> 2);
        return bound(v, lo, hi);
    }

    // ---------------------------------------------------------------- auction and time gates

    /// The first bid needs the minimum bond; a later one must be strictly higher, and refunds the one it beats.
    function testFuzz_bid_minBondThenStrictlyHigher(uint256 a, uint256 b) public {
        uint256 first = uint256(_around(a, 10e18, 0, 500e18)); // around the minimum bond
        uint256 second = uint256(_around(b, int256(first), 0, int256(first) + 500e18)); // around the first bid
        vm.prank(alice);
        if (first < 10e18) {
            vm.expectRevert(Leash.LowBid.selector);
            leash.bid(key, first);
            return;
        }
        leash.bid(key, first);

        vm.prank(bob);
        if (second <= first) vm.expectRevert(Leash.LowBid.selector);
        leash.bid(key, second);
        bool won = second > first;
        assertEq(_m().manager, won ? bob : alice);
        assertEq(_m().bond, won ? second : first);
        assertEq(leash.owed(alice, currency1), won ? first : 0, "the beaten bond is claimable");
        assertEq(_bal(currency1, bob), won ? 1_000e18 - second : 1_000e18);
        _assertLedger();
    }

    /// At any second: bids only before auctionEnd; the manager acts only inside the epochs; epoch 0 settles only once
    /// it is over; the treasury closes a hired mandate only at the end.
    function testFuzz_timeGates(uint256 seed, uint256 gate) public {
        vm.prank(alice);
        leash.bid(key, 10e18);
        uint256[3] memory edges = [uint256(auctionEnd), auctionEnd + 1 days, _end()]; // around one of the gates
        uint256 at = uint256(_around(seed, int256(edges[gate % 3]), int256(block.timestamp), int256(_end() + 1 days)));
        vm.warp(at);
        uint256 snap = vm.snapshotState();

        vm.prank(bob);
        if (at >= auctionEnd) vm.expectRevert(Leash.AuctionClosed.selector);
        leash.bid(key, 20e18);
        vm.revertToState(snap);

        vm.prank(alice);
        if (at < auctionEnd || at >= _end()) vm.expectRevert(Leash.NotActive.selector);
        leash.setFee(key, 500);
        vm.revertToState(snap);

        if (at < auctionEnd + 1 days) vm.expectRevert(Leash.NotEnded.selector);
        leash.settle(key, 0);
        vm.revertToState(snap);

        if (at < _end()) vm.expectRevert(Leash.NotEnded.selector);
        leash.close(key);
    }

    /// Anyone may checkpoint; nobody but the treasury may close.
    function testFuzz_close_onlyTheTreasury(address caller) public {
        vm.assume(caller != address(this));
        vm.warp(auctionEnd); // nobody bid: closable now
        vm.prank(caller);
        leash.checkpoint(key);
        vm.prank(caller);
        vm.expectRevert(Leash.NotTreasury.selector);
        leash.close(key);
        leash.close(key);
        assertTrue(_m().closed);
    }

    // ---------------------------------------------------------------- fees

    function testFuzz_setFee_onlyInsideTheBand(uint256 fee, bool atCap) public {
        _win();
        uint24 f = uint24(uint256(_around(fee, atCap ? int256(10_000) : int256(500), 0, 20_000))); // around an edge
        bool ok = f >= 500 && f <= 10_000;
        vm.prank(alice);
        if (f > 10_000) vm.expectRevert(Leash.FeeTooHigh.selector);
        else if (f < 500) vm.expectRevert(Leash.FeeTooLow.selector);
        leash.setFee(key, f);
        (,,, uint24 lpFee) = manager.getSlot0(key.toId());
        assertEq(lpFee, ok ? f : 10_000, "set, or left at the opening cap");
    }

    /// Spot pushed anywhere within 3,000 ticks, in the same block so the TWAP stays at 0: the next swap, either way,
    /// pays the set fee plus 10 pips per tick beyond 10, capped at maxFee.
    function testFuzz_dynamicFee_followsDeviation(uint256 target, uint256 fee, bool zeroForOne) public {
        _win();
        uint24 f = uint24(bound(fee, 500, 10_000));
        vm.prank(alice);
        leash.setFee(key, f);
        _moveTo(int24(_around(target, zeroForOne ? int256(10) : int256(-10), -3000, 3000))); // around the free band
        assertEq(leash.twapTick(key), 0, "same block: the TWAP hasn't moved");
        int256 gap = int256(_tick());
        if (gap < 0) gap = -gap;
        uint256 want = gap > 10 ? f + uint256(gap - 10) * 10 : f;
        assertEq(_feeOfSwap(zeroForOne), want > 10_000 ? 10_000 : want);
        (,,, uint24 lpFee) = manager.getSlot0(key.toId());
        assertEq(lpFee, f, "the override never changes the stored fee");
    }

    // ---------------------------------------------------------------- rebalance

    /// Any aligned range within 1,200 ticks and any size up to the current one (no growth): accepted exactly when it
    /// holds the depth floor and covers TWAP +- minHalfWidth (200), and then it is live in the pool. On a tick-spacing
    /// 10 pool, so the range can sit exactly on TWAP +- 200.
    function testFuzz_rebalance_rangeAndDepth(uint256 below, uint256 above, uint256 depth) public {
        key = _key(10);
        _create(key, SQRT_PRICE_1_1, _terms(), _initial());
        _win();
        int24 l = int24(_around(below, -20, -120, 20)) * 10; // around TWAP - 200, in ticks of 10
        int24 h = int24(_around(above, 20, -20, 120)) * 10; // around TWAP + 200
        uint128 L = uint128(uint256(_around(depth, 100e18, 0, 1_000e18))); // around the depth floor
        bool shallow = L < 100e18;
        bool misses = l > -200 || h < 200;
        vm.prank(alice);
        if (shallow) vm.expectRevert(Leash.TooShallow.selector);
        else if (misses) vm.expectRevert(Leash.RangeMissesTwap.selector);
        leash.rebalance(key, l, h, L);
        if (shallow || misses) return;

        Mandate memory m = _m();
        assertEq(abi.encode(m.tickLower, m.tickUpper, m.liquidity), abi.encode(l, h, L));
        assertEq(manager.getLiquidity(key.toId()), L + 20e18, "live: managed + anchor");
        _assertLedger();
    }

    /// Growth is at most 5% at once, and once per TWAP window.
    function testFuzz_rebalance_growthCappedAtFivePercent(uint256 more, uint256 wait) public {
        _win();
        uint128 L = uint128(uint256(_around(more, 1_050e18, 1_000e18 + 1, 1_200e18))); // around the 5% cap
        vm.prank(alice);
        if (L > 1_050e18) vm.expectRevert(Leash.GrowTooFast.selector);
        leash.rebalance(key, -600, 600, L);
        if (L > 1_050e18) return;
        assertEq(_m().liquidity, L);

        uint256 gap = uint256(_around(wait, 1800, 1, 3600)); // around the TWAP window
        _next(gap);
        vm.prank(alice);
        if (gap < 1800) vm.expectRevert(Leash.GrowTooFast.selector);
        leash.rebalance(key, -600, 600, L + 1);
        _assertLedger();
    }

    // ---------------------------------------------------------------- creation

    /// Random terms inside every bound open a mandate that stores them as given; breaking any one bound is BadTerms.
    function testFuzz_createMandate_termsInBoundsOnly(
        uint256 which,
        uint32 window,
        uint16 epochs,
        uint16 uptime,
        uint16 share,
        uint24 maxFee,
        uint24 minFee
    ) public {
        Terms memory t = _terms();
        t.twapWindow = uint32(bound(window, 1, 1 days)); // the auction (1 day) must outlast it
        t.epochs = uint16(bound(epochs, 1, 104));
        t.uptimeBps = uint16(bound(uptime, 0, 10_000));
        t.managerFeeBps = uint16(bound(share, 0, 10_000));
        t.maxFee = uint24(bound(maxFee, 0, 1_000_000));
        t.minFee = uint24(bound(minFee, 0, t.maxFee));
        which = bound(which, 0, 6); // 0..5 break one bound; 6 breaks none
        if (which == 0) t.twapWindow = window % 2 == 0 ? 0 : uint32(bound(window, 1 days + 1, type(uint32).max));
        if (which == 1) t.epochs = epochs % 2 == 0 ? 0 : uint16(bound(epochs, 105, type(uint16).max));
        if (which == 2) t.uptimeBps = uint16(bound(uptime, 10_001, type(uint16).max));
        if (which == 3) t.managerFeeBps = uint16(bound(share, 10_001, type(uint16).max));
        if (which == 4) t.maxFee = uint24(bound(maxFee, 1_000_001, type(uint24).max));
        if (which == 5) t.minFee = uint24(bound(minFee, uint256(t.maxFee) + 1, type(uint24).max));

        PoolKey memory k = _key(10);
        if (which < 6) vm.expectRevert(Leash.BadTerms.selector);
        leash.createMandate(k, SQRT_PRICE_1_1, t, 100e18, 100e18, _initial());
        if (which < 6) return;
        assertEq(abi.encode(leash.mandate(k.toId()).terms), abi.encode(t));
        (,,, uint24 lpFee) = manager.getSlot0(k.toId());
        assertEq(lpFee, t.maxFee, "opens at the fee cap");
    }

    // ---------------------------------------------------------------- swaps and compliance

    /// The fields of a mandate that hold money or the position.
    function _money(Mandate memory m) internal pure returns (bytes memory) {
        return abi.encode(m.idle0, m.idle1, m.fees0, m.fees1, m.bond, m.tickLower, m.tickUpper, m.liquidity);
    }

    /// A swap of any size either way, at any time, hired or not, never reverts, never moves the hook's tokens or
    /// positions, and books compliance up to now only with a manager. Afterwards the treasury can still close and
    /// every claim leaves the hook empty.
    function testFuzz_swap_neverBricksNorMovesHookFunds(uint256 at, bool hired, bool zeroForOne, uint256 amount)
        public
    {
        if (hired) {
            vm.prank(alice);
            leash.bid(key, 10e18);
        }
        vm.warp(bound(at, block.timestamp, _end() + 1 days));
        bytes memory before = _money(_m());
        (uint256 h0, uint256 h1) = (_bal(currency0, address(leash)), _bal(currency1, address(leash)));

        _swapTo(
            zeroForOne, -int256(bound(amount, 1, 50e18)), zeroForOne ? TickMath.MIN_TICK + 1 : TickMath.MAX_TICK - 1
        );

        assertEq(_bal(currency0, address(leash)), h0, "hook balance (0) untouched");
        assertEq(_bal(currency1, address(leash)), h1, "hook balance (1) untouched");
        assertEq(_money(_m()), before, "ledger and position untouched");
        assertEq(_anchorLiquidity(), 20e18, "anchor untouched");
        uint256 booked;
        for (uint256 e; e < 3; e++) {
            EpochRecord memory r = leash.epochRecord(key.toId(), e);
            booked += r.inSecs + r.outSecs;
        }
        uint256 upTo = block.timestamp < _end() ? block.timestamp : _end();
        assertEq(booked, hired && upTo > auctionEnd ? upTo - auctionEnd : 0, "booked up to now, only with a manager");

        if (block.timestamp < _end()) vm.warp(_end());
        leash.close(key);
        vm.startPrank(alice);
        leash.claim(currency0);
        leash.claim(currency1);
        vm.stopPrank();
        leash.claim(currency0);
        leash.claim(currency1);
        assertEq(_bal(currency0, address(leash)), 0, "nothing stuck (0)");
        assertEq(_bal(currency1, address(leash)), 0, "nothing stuck (1)");
    }

    /// Eight random steps (a gap of up to 18h, then a random swap or a checkpoint) over and past the mandate: every
    /// second of the epochs is booked exactly once, in or out, and nothing outside them.
    function testFuzz_checkpoint_booksEveryElapsedSecondOnce(uint256 seed) public {
        _win();
        for (uint256 i; i < 8; i++) {
            uint256 r = uint256(keccak256(abi.encode(seed, i)));
            _next(bound(r, 1, 18 hours));
            if (r % 3 == 0) {
                bool down = (r >> 128) % 2 == 0;
                _swapTo(
                    down, -int256(bound(r >> 64, 1e15, 30e18)), down ? TickMath.MIN_TICK + 1 : TickMath.MAX_TICK - 1
                );
            } else {
                leash.checkpoint(key);
            }
        }
        leash.checkpoint(key);

        uint256 booked;
        for (uint256 e; e < 3; e++) {
            EpochRecord memory r = leash.epochRecord(key.toId(), e);
            assertLe(r.inSecs + r.outSecs, 1 days, "no epoch holds more than its length");
            booked += r.inSecs + r.outSecs;
        }
        EpochRecord memory after3 = leash.epochRecord(key.toId(), 3);
        assertEq(after3.inSecs + after3.outSecs, 0, "nothing after the end");
        uint256 upTo = block.timestamp < _end() ? block.timestamp : _end();
        assertEq(booked, upTo - auctionEnd, "every second booked once");
    }

    // ---------------------------------------------------------------- settlement

    /// Out of range for the last `outFor` seconds of epoch 0: clean up to the 5% allowance (72 min); past it, the
    /// share of the bond slashed is the time over the allowance as a share of the allowance; at twice it, all of it,
    /// and the manager is fired.
    function testFuzz_settle_slashMatchesTimeOut(uint256 seed, bool firing) public {
        _win();
        // Around the allowance (72 min) or twice it (144 min); from 25 min (by then the TWAP has left the range) to 23 h.
        int256 edge = firing ? int256(144 minutes) : int256(72 minutes);
        uint256 outFor = uint256(_around(seed, edge, 25 minutes, 23 hours));
        vm.warp(auctionEnd + 1 days - outFor);
        _swapTo(false, 100e18, 900);
        vm.warp(auctionEnd + 1 days);
        leash.settle(key, 0);

        EpochRecord memory e = leash.epochRecord(key.toId(), 0);
        assertEq(e.outSecs, outFor);
        assertEq(e.inSecs, 1 days - outFor);
        uint256 allowed = (10_000 - 9500) * 1 days; // in seconds x BPS
        bool clean = outFor * 10_000 <= allowed;
        assertEq(e.clean, clean);
        (uint32 nClean, uint32 nBreached) = leash.records(alice);
        if (clean) {
            assertEq(_m().bond, 10e18);
            assertEq(leash.owed(alice, currency1), uint256(e.fees1) * 3000 / 10_000, "paid 30%");
            assertEq(nClean, 1);
        } else {
            uint256 over = outFor * 10_000 - allowed;
            bool fired = over >= allowed;
            uint256 slashed = fired ? 10e18 : 10e18 * over / allowed;
            assertEq(_m().breached, fired);
            assertEq(_m().bond, 10e18 - slashed);
            assertEq(leash.owed(address(this), currency1), slashed, "slash to the treasury");
            assertEq(leash.owed(alice, currency1), 0, "no pay");
            assertEq(nBreached, 1);
        }
        _assertLedger();
    }

    /// Any trade sizes, any manager share: a clean epoch pays the manager exactly its share of the fees, the keeper
    /// 10 bps of the rest, and the treasury keeps the remainder as inventory.
    function testFuzz_settle_cleanPayIsExactShare(uint256 in0, uint256 in1, uint256 share) public {
        key = _key(10);
        Terms memory t = _terms();
        t.managerFeeBps = uint16(bound(share, 0, 10_000));
        _create(key, SQRT_PRICE_1_1, t, _initial());
        _win();
        swap(key, true, -int256(bound(in0, 1e15, 20e18)), ZERO_BYTES);
        swap(key, false, -int256(bound(in1, 1e15, 20e18)), ZERO_BYTES);
        _moveTo(0); // the market brings it back within the block: the epoch stays clean
        vm.warp(auctionEnd + 1 days);
        Mandate memory m0 = _m();
        vm.prank(bob);
        leash.settle(key, 0);

        EpochRecord memory e = leash.epochRecord(key.toId(), 0);
        assertTrue(e.clean);
        assertGt(e.fees0, 0);
        assertGt(e.fees1, 0);
        uint256 pay0 = uint256(e.fees0) * t.managerFeeBps / 10_000;
        uint256 pay1 = uint256(e.fees1) * t.managerFeeBps / 10_000;
        assertEq(leash.owed(alice, currency0), pay0, "manager: its share (0)");
        assertEq(leash.owed(alice, currency1), pay1, "manager: its share (1)");
        assertEq(leash.owed(bob, currency0), (e.fees0 - pay0) * 10 / 10_000, "keeper: 10 bps of the rest (0)");
        assertEq(leash.owed(bob, currency1), (e.fees1 - pay1) * 10 / 10_000, "keeper: 10 bps of the rest (1)");
        assertEq(_m().idle0, m0.idle0 + e.fees0 - pay0 - leash.owed(bob, currency0), "treasury keeps the rest (0)");
        assertEq(_m().idle1, m0.idle1 + e.fees1 - pay1 - leash.owed(bob, currency1), "treasury keeps the rest (1)");
        _assertLedger();
    }
}
