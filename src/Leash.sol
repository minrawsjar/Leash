// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {BaseHook} from "./utils/BaseHook.sol";
import {Hooks} from "v4-core/libraries/Hooks.sol";
import {LPFeeLibrary} from "v4-core/libraries/LPFeeLibrary.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {BalanceDelta} from "v4-core/types/BalanceDelta.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary} from "v4-core/types/BeforeSwapDelta.sol";
import {ModifyLiquidityParams, SwapParams} from "v4-core/types/PoolOperation.sol";
import {ERC20} from "solmate/src/tokens/ERC20.sol";
import {SafeTransferLib} from "solmate/src/utils/SafeTransferLib.sol";

struct Terms {
    bool stableIs0; // which pool currency is the stablecoin; bonds are paid in it
    uint24 maxFee; // fee cap in pips; the manager can never set a higher fee
    uint40 auctionEnd; // bidding closes and epoch 0 starts
    uint32 epochLength; // seconds
    uint16 epochs;
    uint256 minBond;
    uint32 twapWindow; // seconds
    uint24 maxTickDeviation; // rebalance only while |spot - TWAP| <= this many ticks
    uint128 minLiquidity; // the position can never be smaller (depth floor)
    uint16 uptimeBps; // share of each epoch that must be in compliance
    uint16 managerFeeBps; // manager's share of a clean epoch's LP fees
    uint16 startStableBps; // pace glide path: max stablecoin share of inventory value at epoch 0 start...
    uint16 endStableBps; // ...and at mandate end, linear in between
}

struct Position {
    int24 tickLower;
    int24 tickUpper;
    uint128 liquidity;
}

struct Mandate {
    address treasury;
    address manager; // highest bidder; can act only after auctionEnd
    uint256 bond;
    uint256 idle0; // treasury inventory held by the hook, outside the position
    uint256 idle1;
    int24 tickLower; // the hook's single position in this pool
    int24 tickUpper;
    uint128 liquidity;
    bool closed;
    Terms terms;
}

/// One observation per block with a swap: the tick in force since the previous one, and the running sum.
struct Obs {
    uint32 time;
    int24 tick;
    int56 tickCumulative;
}

// ponytail: fixed 1024 observations. A pool swapped every block on 1s blocks holds ~17 min of history, less than
// a 30-min window, and the TWAP silently shortens to what is held. Upgrade: v3-style growable cardinality.
uint256 constant OBS = 1024;

struct Oracle {
    uint16 index; // newest
    uint16 count;
    Obs[OBS] obs;
}

/// @notice Treasury market-making mandates. The hook owns all liquidity in its pools;
///         the manager can only move it and set the fee, never withdraw it.
contract Leash is BaseHook, IUnlockCallback {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;
    using SafeTransferLib for ERC20;

    error HookOnly();
    error NotLeashPool();
    error BadTerms();
    error NoMandate();
    error MandateClosed();
    error AuctionClosed();
    error LowBid();
    error NotManager();
    error NotActive();
    error NotTreasury();
    error NotEnded();
    error FeeTooHigh();
    error TooShallow();
    error RangeMissesTwap();

    event MandateCreated(PoolId indexed id, address indexed treasury, PoolKey key, uint256 amount0, uint256 amount1);
    event Bid(PoolId indexed id, address indexed bidder, uint256 amount);
    event Rebalanced(PoolId indexed id, int24 tickLower, int24 tickUpper, uint128 liquidity);
    event FeeSet(PoolId indexed id, uint24 fee);
    event Closed(PoolId indexed id);

    mapping(PoolId => Mandate) internal _mandates;
    mapping(PoolId => Oracle) internal _oracles;
    /// @notice Pull payments (outbid bonds, returned bonds, pay): owed[account][currency].
    mapping(address => mapping(Currency => uint256)) public owed;

    constructor(IPoolManager pm) BaseHook(pm) {}

    function getHookPermissions() public pure override returns (Hooks.Permissions memory p) {
        p.beforeInitialize = true;
        p.beforeAddLiquidity = true;
        p.beforeSwap = true;
    }

    // Only the hook may create Leash pools or add liquidity to them. Its own calls skip these hooks.
    function _beforeInitialize(address, PoolKey calldata, uint160) internal pure override returns (bytes4) {
        revert HookOnly();
    }

    function _beforeAddLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, bytes calldata)
        internal
        pure
        override
        returns (bytes4)
    {
        revert HookOnly();
    }

    function _beforeSwap(address, PoolKey calldata key, SwapParams calldata, bytes calldata)
        internal
        override
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        PoolId id = key.toId();
        (, int24 tick,,) = poolManager.getSlot0(id);
        _observe(_oracles[id], tick);
        return (this.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
    }

    // ---------------------------------------------------------------- views

    function mandate(PoolId id) external view returns (Mandate memory) {
        return _mandates[id];
    }

    function twapTick(PoolKey calldata key) external view returns (int24) {
        PoolId id = key.toId();
        return _twap(id, _mandates[id].terms.twapWindow);
    }

    // ---------------------------------------------------------------- treasury

    /// @notice Creates the pool, deposits the treasury's inventory, places its initial position and opens the
    ///         bond auction. The pool is never empty: an empty pool's price can be pushed for free and held
    ///         until the TWAP follows; liquidity around the TWAP makes that cost capital and invites arbitrage.
    function createMandate(
        PoolKey calldata key,
        uint160 sqrtPriceX96,
        Terms calldata t,
        uint256 amount0,
        uint256 amount1,
        Position calldata initial
    ) external returns (PoolId id) {
        // Native ETH is rejected: SafeTransferLib treats calls to address(0) as successful transfers.
        if (address(key.hooks) != address(this) || key.fee != LPFeeLibrary.DYNAMIC_FEE_FLAG || key.currency0.isAddressZero()) {
            revert NotLeashPool();
        }
        // The auction outlasts one TWAP window, so the oracle holds a full window before the manager can act.
        if (
            t.auctionEnd < block.timestamp + t.twapWindow || t.twapWindow == 0 || t.epochLength == 0 || t.epochs == 0
                || t.maxFee > LPFeeLibrary.MAX_LP_FEE || t.minLiquidity == 0
        ) revert BadTerms();
        id = key.toId();
        int24 tick = poolManager.initialize(key, sqrtPriceX96); // reverts if the pool already exists
        poolManager.updateDynamicLPFee(key, t.maxFee); // dynamic-fee pools start at 0
        Oracle storage o = _oracles[id];
        (o.obs[0], o.count) = (Obs(uint32(block.timestamp), tick, 0), 1);

        Mandate storage m = _mandates[id];
        m.treasury = msg.sender;
        m.idle0 = amount0;
        m.idle1 = amount1;
        m.terms = t;
        _pull(key.currency0, msg.sender, amount0);
        _pull(key.currency1, msg.sender, amount1);
        _place(key, m, tick, initial.tickLower, initial.tickUpper, initial.liquidity);
        emit MandateCreated(id, msg.sender, key, amount0, amount1);
    }

    /// @notice Ends the mandate: pulls the liquidity back and returns all inventory to the treasury.
    function close(PoolKey calldata key) external {
        Mandate storage m = _live(key);
        if (msg.sender != m.treasury) revert NotTreasury();
        // With no winning bidder, the treasury can leave as soon as the auction ends.
        if (block.timestamp < (m.manager == address(0) ? m.terms.auctionEnd : _end(m))) revert NotEnded();

        m.closed = true;
        _move(key, m, 0, 0, 0);
        if (m.manager != address(0)) owed[m.manager][_stable(key, m)] += m.bond;
        m.bond = 0;

        (uint256 a0, uint256 a1) = (m.idle0, m.idle1);
        (m.idle0, m.idle1) = (0, 0);
        _push(key.currency0, m.treasury, a0);
        _push(key.currency1, m.treasury, a1);
        emit Closed(key.toId());
    }

    // ---------------------------------------------------------------- managers

    /// @notice Highest bond when the auction ends wins the mandate. Outbid bonds become claimable.
    function bid(PoolKey calldata key, uint256 amount) external {
        Mandate storage m = _live(key);
        if (block.timestamp >= m.terms.auctionEnd) revert AuctionClosed();
        if (amount < m.terms.minBond || amount <= m.bond) revert LowBid();

        Currency stable = _stable(key, m);
        if (m.manager != address(0)) owed[m.manager][stable] += m.bond;
        (m.manager, m.bond) = (msg.sender, amount);
        _pull(stable, msg.sender, amount);
        emit Bid(key.toId(), msg.sender, amount);
    }

    /// @notice Moves the treasury's liquidity to a new range. Funds only ever move between the hook and the pool.
    function rebalance(PoolKey calldata key, int24 tickLower, int24 tickUpper, uint128 liquidity) external {
        Mandate storage m = _active(key);
        _place(key, m, _twap(key.toId(), m.terms.twapWindow), tickLower, tickUpper, liquidity);
        emit Rebalanced(key.toId(), tickLower, tickUpper, liquidity);
    }

    function setFee(PoolKey calldata key, uint24 fee) external {
        Mandate storage m = _active(key);
        if (fee > m.terms.maxFee) revert FeeTooHigh();
        poolManager.updateDynamicLPFee(key, fee);
        emit FeeSet(key.toId(), fee);
    }

    // ---------------------------------------------------------------- anyone

    function claim(Currency c) external {
        uint256 a = owed[msg.sender][c];
        owed[msg.sender][c] = 0;
        _push(c, msg.sender, a);
    }

    // ---------------------------------------------------------------- oracle

    /// Called before every swap with the pre-swap tick, at most once per block, so a price pushed and
    /// returned within one block never enters the TWAP.
    function _observe(Oracle storage o, int24 tick) internal {
        Obs memory last = o.obs[o.index];
        if (last.time == block.timestamp) return;
        uint16 i = uint16((o.index + 1) % OBS);
        o.obs[i] = Obs(uint32(block.timestamp), tick, last.tickCumulative + int56(tick) * int56(uint56(block.timestamp - last.time)));
        o.index = i;
        if (o.count < OBS) o.count++;
    }

    /// Time-weighted tick over the last `window` seconds, or over all history held if that is shorter.
    function _twap(PoolId id, uint32 window) internal view returns (int24 tick) {
        Oracle storage o = _oracles[id];
        (, int24 spot,,) = poolManager.getSlot0(id);
        Obs memory last = o.obs[o.index];
        uint256 oldest = o.count < OBS ? 0 : (o.index + 1) % OBS;
        Obs memory first = o.obs[oldest];

        uint256 target = block.timestamp > window ? block.timestamp - window : 0;
        if (target < first.time) target = first.time;
        if (target == block.timestamp) return first.tick; // all history is this block: the tick it opened at

        int56 cumThen;
        if (target >= last.time) {
            cumThen = last.tickCumulative + int56(spot) * int56(uint56(target - last.time));
        } else {
            uint256 lo; // binary search: obs[lo].time <= target < obs[hi].time
            uint256 hi = o.count - 1;
            while (hi - lo > 1) {
                uint256 mid = (lo + hi) / 2;
                if (o.obs[(oldest + mid) % OBS].time <= target) lo = mid;
                else hi = mid;
            }
            Obs memory a = o.obs[(oldest + lo) % OBS];
            cumThen = a.tickCumulative + int56(o.obs[(oldest + hi) % OBS].tick) * int56(uint56(target - a.time));
        }
        // Extrapolate to now with the spot tick, as v3 does: any swap this block already wrote an observation at now.
        int56 cumNow = last.tickCumulative + int56(spot) * int56(uint56(block.timestamp - last.time));
        int56 dt = int56(uint56(block.timestamp - target));
        tick = int24((cumNow - cumThen) / dt);
        if (cumNow < cumThen && (cumNow - cumThen) % dt != 0) tick--; // round toward negative infinity
    }

    // ---------------------------------------------------------------- liquidity

    /// Every position must hold at least the depth floor and straddle the TWAP.
    function _place(PoolKey calldata key, Mandate storage m, int24 twap, int24 lo, int24 hi, uint128 liq) internal {
        if (liq < m.terms.minLiquidity) revert TooShallow();
        if (twap < lo || twap >= hi) revert RangeMissesTwap();
        _move(key, m, lo, hi, liq);
    }

    function _move(PoolKey calldata key, Mandate storage m, int24 lo, int24 hi, uint128 liq) internal {
        bytes memory data = abi.encode(key, m.tickLower, m.tickUpper, m.liquidity, lo, hi, liq);
        BalanceDelta d = abi.decode(poolManager.unlock(data), (BalanceDelta));
        // Underflow here reverts the whole move: a position can't use more than this mandate's inventory.
        m.idle0 = _apply(m.idle0, d.amount0());
        m.idle1 = _apply(m.idle1, d.amount1());
        (m.tickLower, m.tickUpper, m.liquidity) = (lo, hi, liq);
    }

    function unlockCallback(bytes calldata data) external onlyPoolManager returns (bytes memory) {
        (PoolKey memory key, int24 oldLo, int24 oldHi, uint128 oldLiq, int24 lo, int24 hi, uint128 liq) =
            abi.decode(data, (PoolKey, int24, int24, uint128, int24, int24, uint128));

        BalanceDelta d; // removal returns principal plus earned fees, which stay treasury inventory
        if (oldLiq > 0) {
            (d,) = poolManager.modifyLiquidity(key, ModifyLiquidityParams(oldLo, oldHi, -int256(uint256(oldLiq)), 0), "");
        }
        if (liq > 0) {
            (BalanceDelta added,) =
                poolManager.modifyLiquidity(key, ModifyLiquidityParams(lo, hi, int256(uint256(liq)), 0), "");
            d = d + added;
        }
        _resolve(key.currency0, d.amount0());
        _resolve(key.currency1, d.amount1());
        return abi.encode(d);
    }

    function _resolve(Currency c, int128 amount) internal {
        if (amount < 0) {
            poolManager.sync(c);
            ERC20(Currency.unwrap(c)).safeTransfer(address(poolManager), uint128(-amount));
            poolManager.settle();
        } else if (amount > 0) {
            poolManager.take(c, address(this), uint128(amount));
        }
    }

    // ---------------------------------------------------------------- helpers

    function _live(PoolKey calldata key) internal view returns (Mandate storage m) {
        m = _mandates[key.toId()];
        if (m.treasury == address(0)) revert NoMandate();
        if (m.closed) revert MandateClosed();
    }

    function _active(PoolKey calldata key) internal view returns (Mandate storage m) {
        m = _live(key);
        if (msg.sender != m.manager) revert NotManager();
        if (block.timestamp < m.terms.auctionEnd || block.timestamp >= _end(m)) revert NotActive();
    }

    function _end(Mandate storage m) internal view returns (uint256) {
        return uint256(m.terms.auctionEnd) + uint256(m.terms.epochLength) * m.terms.epochs;
    }

    function _stable(PoolKey calldata key, Mandate storage m) internal view returns (Currency) {
        return m.terms.stableIs0 ? key.currency0 : key.currency1;
    }

    function _apply(uint256 bal, int128 d) internal pure returns (uint256) {
        return d < 0 ? bal - uint128(-d) : bal + uint128(d);
    }

    function _pull(Currency c, address from, uint256 amount) internal {
        if (amount > 0) ERC20(Currency.unwrap(c)).safeTransferFrom(from, address(this), amount);
    }

    function _push(Currency c, address to, uint256 amount) internal {
        if (amount > 0) ERC20(Currency.unwrap(c)).safeTransfer(to, amount);
    }
}
