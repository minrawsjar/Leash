// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {Deployers} from "@uniswap/v4-core/test/utils/Deployers.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {Hooks} from "v4-core/libraries/Hooks.sol";
import {LPFeeLibrary} from "v4-core/libraries/LPFeeLibrary.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";
import {SqrtPriceMath} from "v4-core/libraries/SqrtPriceMath.sol";
import {LiquidityAmounts} from "v4-periphery/src/libraries/LiquidityAmounts.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {SwapParams} from "v4-core/types/PoolOperation.sol";
import {PoolSwapTest} from "v4-core/test/PoolSwapTest.sol";
import {Leash, Terms, Position, Mandate} from "../../src/Leash.sol";

/// The mandate the unit, paths, fuzz and audit suites share, and their helpers. A real v4-core PoolManager and
/// router; the hook at an address carrying its permission bits. 100/100 deposit at 1:1, managed [-600, 600)
/// L = 1,000e18, full-range anchor 20e18, auction 1 day, 3 x 1-day epochs, bond >= 10e18 of currency1 (the
/// stablecoin), TWAP 1,800 s, maxTickDeviation 100, minHalfWidth 200, fee 0.05% to 1%, manager share 30%, uptime 95%.
abstract contract LeashBase is Test, Deployers {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    uint160 constant FLAGS =
        uint160(Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG | Hooks.BEFORE_SWAP_FLAG);
    /// LP fees of a 10-token swap at the 1% fee, managed position's share: L 1000 next to the anchor's L 20.
    uint256 constant MANAGED_FEE = 0.1e18 * uint256(1_000) / 1_020;

    Leash leash;
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    uint40 auctionEnd;
    /// Every mandate opened through _create, so _assertLedger can sum them.
    PoolKey[] internal _keys;

    /// The shared mandate; alice and bob each hold 1,000 currency1 to bid with.
    function setUp() public virtual {
        _deploy();
        _fund(alice, 0, 1_000e18);
        _fund(bob, 0, 1_000e18);
    }

    /// v4, the hook, and the shared mandate on `key` (tick spacing 60), with this contract as the treasury.
    function _deploy() internal {
        deployFreshManagerAndRouters();
        (currency0, currency1) = deployMintAndApprove2Currencies(); // also approves this contract's routers
        address hook = address(FLAGS ^ (0x4444 << 144));
        deployCodeTo("Leash.sol:Leash", abi.encode(manager), hook);
        leash = Leash(hook);
        _approve(hook);
        auctionEnd = uint40(block.timestamp + 1 days);
        key = _key(60);
        _create(key, SQRT_PRICE_1_1, _terms(), _initial());
    }

    /// Mints `who` the amounts and approves the hook and the swap router for both currencies.
    function _fund(address who, uint256 amount0, uint256 amount1) internal {
        MockERC20(Currency.unwrap(currency0)).mint(who, amount0);
        MockERC20(Currency.unwrap(currency1)).mint(who, amount1);
        vm.startPrank(who);
        _approve(address(leash));
        _approve(address(swapRouter));
        vm.stopPrank();
    }

    function _approve(address spender) internal {
        MockERC20(Currency.unwrap(currency0)).approve(spender, type(uint256).max);
        MockERC20(Currency.unwrap(currency1)).approve(spender, type(uint256).max);
    }

    /// A Leash pool over the same two currencies; a new tick spacing makes a new pool.
    function _key(int24 spacing) internal view returns (PoolKey memory) {
        return PoolKey(currency0, currency1, LPFeeLibrary.DYNAMIC_FEE_FLAG, spacing, IHooks(address(leash)));
    }

    /// Opens a 100/100 mandate on `k` as this contract.
    function _create(PoolKey memory k, uint160 price, Terms memory t, Position memory p) internal {
        leash.createMandate(k, price, t, 100e18, 100e18, p);
        _keys.push(k);
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
            anchorLiquidity: 20e18 // full range, ~20 of each token at 1:1: 20% of the inventory's value
        });
    }

    /// Uses ~29.6 of each token at 1:1.
    function _initial() internal pure returns (Position memory) {
        return Position(-600, 600, 1_000e18);
    }

    // ---------------------------------------------------------------- reads

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

    function _anchorLiquidity() internal view returns (uint128 liq) {
        (liq,,) = manager.getPositionInfo(
            key.toId(),
            address(leash),
            TickMath.minUsableTick(key.tickSpacing),
            TickMath.maxUsableTick(key.tickSpacing),
            bytes32(uint256(1))
        );
    }

    /// The hook's balances are exactly its mandates' inventory, unsettled fees and bonds, plus what it owes.
    function _assertLedger() internal view {
        uint256 want0;
        uint256 want1;
        address[3] memory who = [address(this), alice, bob];
        for (uint256 i; i < 3; i++) {
            want0 += leash.owed(who[i], currency0);
            want1 += leash.owed(who[i], currency1);
        }
        for (uint256 i; i < _keys.length; i++) {
            Mandate memory m = leash.mandate(_keys[i].toId());
            (uint256 b0, uint256 b1) = m.terms.stableIs0 ? (m.bond, uint256(0)) : (uint256(0), m.bond);
            want0 += m.idle0 + m.fees0 + b0;
            want1 += m.idle1 + m.fees1 + b1;
        }
        assertEq(_bal(currency0, address(leash)), want0, "ledger == balance (0)");
        assertEq(_bal(currency1, address(leash)), want1, "ledger == balance (1)");
    }

    // ---------------------------------------------------------------- actions

    /// Swaps as this contract until `limitTick`: `amount` < 0 is exact input, > 0 exact output.
    function _swapTo(bool zeroForOne, int256 amount, int24 limitTick) internal {
        swapRouter.swap(
            key,
            SwapParams(zeroForOne, amount, TickMath.getSqrtPriceAtTick(limitTick)),
            PoolSwapTest.TestSettings(false, false),
            ZERO_BYTES
        );
    }

    /// `who` swaps (exact output, effectively unlimited) until the price reaches `limit`.
    function _swapAs(address who, bool zeroForOne, uint160 limit) internal {
        vm.prank(who);
        swapRouter.swap(key, SwapParams(zeroForOne, 1e30, limit), PoolSwapTest.TestSettings(false, false), ZERO_BYTES);
    }

    /// Swaps as this contract, from either side, until the price is exactly at `t`.
    function _moveTo(int24 t) internal {
        (uint160 p,,,) = manager.getSlot0(key.toId());
        uint160 target = _sqrt(t);
        if (p != target) _swapTo(target < p, 1e30, t);
    }

    /// `who` swaps until the price is exactly at `t`, from either side.
    function _moveTo(address who, int24 t) internal {
        (uint160 p,,,) = manager.getSlot0(key.toId());
        uint160 target = _sqrt(t);
        if (p != target) _swapAs(who, target < p, target);
    }

    /// Alice wins; a keeper checkpoints as epoch 0 opens.
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

    /// A keeper checkpointing every minute until `until`.
    function _keep(uint256 until) internal {
        while (block.timestamp + 1 minutes <= until) {
            _next(1 minutes);
            leash.checkpoint(key);
        }
    }

    /// The fee the PoolManager charged a tiny swap, from its Swap event.
    function _feeOfSwap(bool zeroForOne) internal returns (uint24 fee) {
        vm.recordLogs();
        _swapTo(zeroForOne, 1e12, zeroForOne ? TickMath.MIN_TICK + 1 : TickMath.MAX_TICK - 1);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].topics[0] == IPoolManager.Swap.selector) {
                (,,,,, fee) = abi.decode(logs[i].data, (int128, int128, uint160, uint128, int24, uint24));
            }
        }
    }

    // ---------------------------------------------------------------- range math

    /// `t` rounded down (or up) to the tick spacing, 60.
    function _round(int256 t, bool up) internal pure returns (int24) {
        int256 f = t - (t % 60);
        if (t % 60 < 0) f -= 60;
        return int24(up && f != t ? f + 60 : f);
    }

    /// The most liquidity the mandate's inventory (idle plus the current position, at spot) can put in [lo, hi).
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
}
