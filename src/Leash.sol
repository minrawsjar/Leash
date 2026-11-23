// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {BaseHook} from "./utils/BaseHook.sol";
import {Hooks} from "v4-core/libraries/Hooks.sol";
import {LPFeeLibrary} from "v4-core/libraries/LPFeeLibrary.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";
import {SqrtPriceMath} from "v4-core/libraries/SqrtPriceMath.sol";
import {FullMath} from "v4-core/libraries/FullMath.sol";
import {FixedPoint96} from "v4-core/libraries/FixedPoint96.sol";
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
    uint256 fees0; // LP fees collected but not yet settled; kept out of idle so they can't be redeployed
    uint256 fees1;
    int24 tickLower; // the hook's single position in this pool
    int24 tickUpper;
    uint128 liquidity;
    uint40 lastCheck; // compliance is accounted up to here
    uint16 settled; // epochs settled so far; settlement goes in order
    bool breached; // an epoch missed its uptime: bond slashed, manager fired
    bool closed;
    Terms terms;
}

struct TrackRecord {
    uint32 clean;
    uint32 breached;
}

struct EpochRecord {
    uint32 inSecs; // seconds the mandate was in compliance
    uint32 outSecs;
    uint128 fees0; // LP fees collected and attributed to this epoch
    uint128 fees1;
    bool settled;
    bool clean;
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
uint256 constant BPS = 10_000;
// ponytail: one checkpoint after a long quiet spell writes every epoch it spans (~22k gas each); the cap keeps that
// under a block. Upgrade: checkpoint in bounded chunks.
uint256 constant MAX_EPOCHS = 365;

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
    error SpotOffTwap();
    error Breached();
    error BadEpoch();

    event MandateCreated(PoolId indexed id, address indexed treasury, PoolKey key, uint256 amount0, uint256 amount1);
    event Bid(PoolId indexed id, address indexed bidder, uint256 amount);
    event Rebalanced(PoolId indexed id, int24 tickLower, int24 tickUpper, uint128 liquidity);
    event FeeSet(PoolId indexed id, uint24 fee);
    event EpochSettled(
        PoolId indexed id, uint256 indexed epoch, bool clean, uint256 pay0, uint256 pay1, uint256 slashed
    );
    event Closed(PoolId indexed id);

    mapping(PoolId => Mandate) internal _mandates;
    mapping(PoolId => Oracle) internal _oracles;
    mapping(PoolId => mapping(uint256 => EpochRecord)) internal _epochs;
    /// @notice Pull payments (outbid bonds, returned bonds, pay): owed[account][currency].
    mapping(address => mapping(Currency => uint256)) public owed;
    /// @notice Each manager's settled epochs, across all mandates.
    mapping(address => TrackRecord) public records;

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
        _checkpoint(key, _mandates[id]);
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

    /// @notice Epoch index at the current time: 0 before the auction ends, >= terms.epochs after the mandate ends.
    function currentEpoch(PoolKey calldata key) external view returns (uint256) {
        return _epochAt(_mandates[key.toId()]);
    }

    function epochRecord(PoolId id, uint256 epoch) external view returns (EpochRecord memory) {
        return _epochs[id][epoch];
    }

    /// @notice The mandate's state right now, as the next checkpoint will judge it.
    function compliance(PoolKey calldata key)
        external
        view
        returns (bool inRange, bool deep, bool onPace, uint16 stableBps)
    {
        return _compliance(key, _mandates[key.toId()]);
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
                || t.epochs > MAX_EPOCHS || t.maxFee > LPFeeLibrary.MAX_LP_FEE || t.minLiquidity == 0 || t.uptimeBps > BPS
                || t.managerFeeBps > BPS || t.startStableBps > BPS || t.endStableBps > BPS
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

        (uint256 a0, uint256 a1) = (m.idle0 + m.fees0, m.idle1 + m.fees1);
        (m.idle0, m.idle1, m.fees0, m.fees1) = (0, 0, 0, 0);
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
    ///         Refused while the spot price is pushed away from the TWAP, so a manager can't sandwich the treasury.
    function rebalance(PoolKey calldata key, int24 tickLower, int24 tickUpper, uint128 liquidity) external {
        Mandate storage m = _active(key);
        PoolId id = key.toId();
        int24 twap = _twap(id, m.terms.twapWindow);
        (, int24 spot,,) = poolManager.getSlot0(id);
        int256 gap = int256(spot) - twap;
        if ((gap < 0 ? -gap : gap) > int256(uint256(m.terms.maxTickDeviation))) revert SpotOffTwap();
        _checkpoint(key, m);
        (uint256 f0, uint256 f1) = _place(key, m, twap, tickLower, tickUpper, liquidity);
        EpochRecord storage r = _epochs[id][_epochAt(m)];
        (r.fees0, r.fees1) = (r.fees0 + uint128(f0), r.fees1 + uint128(f1));
        emit Rebalanced(id, tickLower, tickUpper, liquidity);
    }

    function setFee(PoolKey calldata key, uint24 fee) external {
        Mandate storage m = _active(key);
        if (fee > m.terms.maxFee) revert FeeTooHigh();
        _checkpoint(key, m);
        poolManager.updateDynamicLPFee(key, fee);
        emit FeeSet(key.toId(), fee);
    }

    // ---------------------------------------------------------------- anyone

    /// @notice Judges a finished epoch, in order. Clean: the manager earns managerFeeBps of its LP fees.
    ///         Missed uptime: the whole bond goes to the treasury and the manager is fired.
    function settle(PoolKey calldata key, uint256 epoch) external {
        Mandate storage m = _live(key);
        if (m.manager == address(0)) revert NotActive();
        if (m.breached) revert Breached();
        if (epoch != m.settled || epoch >= m.terms.epochs) revert BadEpoch();
        _settle(key, m, epoch);
    }

    function claim(Currency c) external {
        uint256 a = owed[msg.sender][c];
        owed[msg.sender][c] = 0;
        _push(c, msg.sender, a);
    }

    function _settle(PoolKey calldata key, Mandate storage m, uint256 e) internal {
        if (block.timestamp < m.terms.auctionEnd + (e + 1) * m.terms.epochLength) revert NotEnded();
        _checkpoint(key, m);
        PoolId id = key.toId();
        EpochRecord storage r = _epochs[id][e];
        // Poke the position to collect its fees. ponytail: fees are booked when collected, so a late settle books
        // some of epoch e+1's fees to e. Settle promptly, or snapshot fee growth at epoch boundaries if it matters.
        (uint256 f0, uint256 f1) = _move(key, m, m.tickLower, m.tickUpper, m.liquidity);
        (uint256 fees0, uint256 fees1) = (r.fees0 + f0, r.fees1 + f1);
        (r.fees0, r.fees1, r.settled) = (uint128(fees0), uint128(fees1), true);
        r.clean = uint256(r.inSecs) * BPS >= uint256(m.terms.uptimeBps) * (uint256(r.inSecs) + r.outSecs);
        m.settled = uint16(e + 1);

        uint256 pay0;
        uint256 pay1;
        uint256 slashed;
        if (r.clean) {
            (pay0, pay1) = (fees0 * m.terms.managerFeeBps / BPS, fees1 * m.terms.managerFeeBps / BPS);
            owed[m.manager][key.currency0] += pay0;
            owed[m.manager][key.currency1] += pay1;
            records[m.manager].clean++;
        } else {
            (slashed, m.bond, m.breached) = (m.bond, 0, true);
            owed[m.treasury][_stable(key, m)] += slashed;
            records[m.manager].breached++;
        }
        // The treasury keeps the rest of the fees as inventory.
        (m.fees0, m.fees1) = (m.fees0 - fees0, m.fees1 - fees1);
        (m.idle0, m.idle1) = (m.idle0 + fees0 - pay0, m.idle1 + fees1 - pay1);
        emit EpochSettled(id, e, r.clean, pay0, pay1, slashed);
    }

    // ---------------------------------------------------------------- compliance

    /// Credits the time since the last check to the epochs it spans, all in or all out of compliance. The position
    /// and inventory only change at swaps and manager actions, which checkpoint first; the TWAP drifts in between,
    /// so each interval is judged by its state at the end. Time before epoch 0 or after the mandate is ignored.
    function _checkpoint(PoolKey calldata key, Mandate storage m) internal {
        uint256 start = m.terms.auctionEnd;
        uint256 from = m.lastCheck > start ? m.lastCheck : start;
        uint256 to = block.timestamp < _end(m) ? block.timestamp : _end(m);
        if (to <= from || m.manager == address(0) || m.breached || m.closed) return;
        m.lastCheck = uint40(to);
        (bool inRange, bool deep, bool onPace,) = _compliance(key, m);
        bool ok = inRange && deep && onPace;

        mapping(uint256 => EpochRecord) storage book = _epochs[key.toId()];
        uint256 len = m.terms.epochLength;
        for (uint256 e = (from - start) / len; from < to; e++) {
            uint256 next = start + (e + 1) * len;
            uint32 secs = uint32((next < to ? next : to) - from);
            if (ok) book[e].inSecs += secs;
            else book[e].outSecs += secs;
            from += secs;
        }
    }

    /// In range: the TWAP is inside the position. Deep: liquidity at the floor. On pace: the stablecoin share of
    /// inventory (idle + position, valued at the TWAP) is within the glide path.
    function _compliance(PoolKey calldata key, Mandate storage m)
        internal
        view
        returns (bool inRange, bool deep, bool onPace, uint16 stableBps)
    {
        int24 twap = _twap(key.toId(), m.terms.twapWindow);
        inRange = m.tickLower <= twap && twap < m.tickUpper;
        deep = m.liquidity >= m.terms.minLiquidity;

        uint160 p = TickMath.getSqrtPriceAtTick(twap);
        uint160 lo = TickMath.getSqrtPriceAtTick(m.tickLower);
        uint160 hi = TickMath.getSqrtPriceAtTick(m.tickUpper);
        (uint256 a0, uint256 a1) = (m.idle0, m.idle1);
        if (p < hi) a0 += SqrtPriceMath.getAmount0Delta(p > lo ? p : lo, hi, m.liquidity, false);
        if (p > lo) a1 += SqrtPriceMath.getAmount1Delta(lo, p < hi ? p : hi, m.liquidity, false);
        uint256 v0 = FullMath.mulDiv(FullMath.mulDiv(a0, p, FixedPoint96.Q96), p, FixedPoint96.Q96); // in currency1
        if (v0 + a1 > 0) stableBps = uint16(FullMath.mulDiv(m.terms.stableIs0 ? v0 : a1, BPS, v0 + a1));
        onPace = stableBps <= _glide(m);
    }

    /// Max stablecoin share now: linear from startStableBps at epoch 0 to endStableBps at the mandate's end.
    function _glide(Mandate storage m) internal view returns (uint256) {
        (uint256 start, uint256 end) = (m.terms.auctionEnd, _end(m));
        uint256 t = block.timestamp < start ? 0 : (block.timestamp > end ? end : block.timestamp) - start;
        (uint256 a, uint256 b) = (m.terms.startStableBps, m.terms.endStableBps);
        return b >= a ? a + (b - a) * t / (end - start) : a - (a - b) * t / (end - start);
    }

    function _epochAt(Mandate storage m) internal view returns (uint256) {
        return block.timestamp < m.terms.auctionEnd ? 0 : (block.timestamp - m.terms.auctionEnd) / m.terms.epochLength;
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
    function _place(PoolKey calldata key, Mandate storage m, int24 twap, int24 lo, int24 hi, uint128 liq)
        internal
        returns (uint256, uint256)
    {
        if (liq < m.terms.minLiquidity) revert TooShallow();
        if (twap < lo || twap >= hi) revert RangeMissesTwap();
        return _move(key, m, lo, hi, liq);
    }

    /// Replaces the position (or, given the same one, just collects its fees). Returns the fees collected.
    function _move(PoolKey calldata key, Mandate storage m, int24 lo, int24 hi, uint128 liq)
        internal
        returns (uint256 f0, uint256 f1)
    {
        bytes memory data = abi.encode(key, m.tickLower, m.tickUpper, m.liquidity, lo, hi, liq);
        (BalanceDelta d, BalanceDelta fees) = abi.decode(poolManager.unlock(data), (BalanceDelta, BalanceDelta));
        (f0, f1) = (uint128(fees.amount0()), uint128(fees.amount1()));
        // Fees wait outside idle until settled. Underflow here reverts the whole move: a position can't use more
        // than this mandate's inventory (not bonds, other mandates, or unsettled fees).
        m.idle0 = _apply(m.idle0, d.amount0() - fees.amount0());
        m.idle1 = _apply(m.idle1, d.amount1() - fees.amount1());
        (m.fees0, m.fees1) = (m.fees0 + f0, m.fees1 + f1);
        (m.tickLower, m.tickUpper, m.liquidity) = (lo, hi, liq);
    }

    function unlockCallback(bytes calldata data) external onlyPoolManager returns (bytes memory) {
        (PoolKey memory key, int24 oldLo, int24 oldHi, uint128 oldLiq, int24 lo, int24 hi, uint128 liq) =
            abi.decode(data, (PoolKey, int24, int24, uint128, int24, int24, uint128));

        bool poke = lo == oldLo && hi == oldHi && liq == oldLiq; // zero-liquidity update: collect fees only
        BalanceDelta d; // principal plus fees
        BalanceDelta fees;
        if (oldLiq > 0) {
            (d, fees) = poolManager.modifyLiquidity(
                key, ModifyLiquidityParams(oldLo, oldHi, poke ? int256(0) : -int256(uint256(oldLiq)), 0), ""
            );
        }
        if (liq > 0 && !poke) {
            (BalanceDelta added,) =
                poolManager.modifyLiquidity(key, ModifyLiquidityParams(lo, hi, int256(uint256(liq)), 0), "");
            d = d + added;
        }
        _resolve(key.currency0, d.amount0());
        _resolve(key.currency1, d.amount1());
        return abi.encode(d, fees);
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
        if (m.breached) revert Breached();
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
