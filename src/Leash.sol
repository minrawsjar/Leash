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
import {LeashOracle, Oracle, Obs} from "./LeashOracle.sol";

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
    uint24 minFee; // fee floor in pips, so every round trip through the pool costs something
    uint24 minHalfWidth; // the managed range always covers TWAP +- this many ticks; must exceed maxTickDeviation
    uint128 anchorLiquidity; // permanent full-range position the manager can't touch: liquidity at every price
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
    bool lastOk; // compliant at the last checkpoint or rebalance; starts true (see createMandate)
    bool breached; // fired: an epoch was out for twice its allowance, the whole bond went to the treasury
    bool closed;
    bool swept; // fees earned before the manager's first epoch went to the treasury
    uint40 lastRebalance; // timestamp of the last rebalance: at most one per block
    uint40 lastGrow; // timestamp of the last rebalance that grew the managed position
    Terms terms;
}

/// Measured in the first beforeSwap after the auction, while the sweep is still pending (see _sweep).
struct PreHire {
    uint128 fees0;
    uint128 fees1;
    bool taken;
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

uint256 constant BPS = 10_000;
// The managed position may grow only with spot within 2 ticks (0.02%) of the TWAP. Re-placing L at spot d ticks off
// fair loses the treasury at most ~L(d/20000)^2 when the price returns, while the trader moving it back pays
// ~L(d/20000) times the fee: at d <= 2 that's a loss for the trader at any fee >= 0.01%.
int256 constant MAX_GROW_GAP = 2;
// Nothing on-chain shows the TWAP is stale after a real move, and growing at a stale TWAP then trading to the market
// takes the difference from the treasury. So exposure grows slowly: at most 5% per rebalance, once per TWAP window.
// The extra loss per market move is bounded by that one step, not the whole inventory.
uint256 constant GROW_BPS = 500;
// The anchor must hold ~20% of the deposit's value (19%, so the audited 20% config passes after rounding): at 10%,
// drag-and-extract pays (re-audit R-4); at 20% it costs ~2x what it extracts.
uint256 constant MIN_ANCHOR_BPS = 1900;
bytes32 constant ANCHOR = bytes32(uint256(1)); // salt of the full-range anchor; the managed position uses 0
// ponytail: one checkpoint after a long quiet spell writes every epoch it spans (~23k gas each), and close() settles
// every unsettled epoch (~80k each). 104 (two years of weekly epochs) keeps both under the 2^24 per-transaction gas
// cap (EIP-7825). Upgrade: checkpoint and settle in bounded chunks.
uint256 constant MAX_EPOCHS = 104;
// Swap fee surcharge: +10 pips (0.001%) per tick of |spot - TWAP| beyond a 10-tick free band, up to maxFee. At 100
// ticks off (1%) that's +0.09%: a tenth of the deviation, so arbitrage back to fair still pays, while pushing or
// dragging the price costs more. Within 10 ticks (normal noise) traders pay the manager's fee.
int256 constant FEE_FREE_TICKS = 10;
uint256 constant FEE_PIPS_PER_TICK = 10;
// The smallest legal minBond: 2% of the deposit's value at the opening price.
uint256 constant MIN_BOND_BPS = 200;
// Whoever settles an epoch (other than the treasury) earns 10 bps of the treasury's share of its fees.
uint256 constant KEEPER_BPS = 10;

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
    error FeeTooLow();
    error TooShallow();
    error RangeMissesTwap();
    error SpotOffTwap();
    error SameBlock();
    error GrowTooFast();
    error ThinAnchor();
    error ThinBond();
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
    /// Fees the managed position had earned by the first swap after bidding closed, if a swap came before the sweep.
    mapping(PoolId => PreHire) internal _preHire;
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
        (, int24 tick,, uint24 fee) = poolManager.getSlot0(id);
        Oracle storage o = _oracles[id];
        LeashOracle.observe(o, tick);
        Mandate storage m = _mandates[id];
        // The first swap after bidding closes, while the sweep is pending: what the managed position has earned so
        // far is all pre-hire (fees accrue only in swaps), so measure it for _sweep before this swap adds more.
        PreHire storage p = _preHire[id];
        if (!m.swept && !p.taken && block.timestamp >= m.terms.auctionEnd) {
            p.taken = true;
            (p.fees0, p.fees1) = LeashOracle.pendingFees(poolManager, id, address(this), m.tickLower, m.tickUpper);
        }
        _checkpoint(key, m);
        // This swap's fee: the manager's fee (slot0's stored lpFee, set by setFee in [minFee, maxFee]) plus
        // FEE_PIPS_PER_TICK for every tick spot sits beyond FEE_FREE_TICKS from the TWAP, capped at maxFee. Pushing
        // the price off the TWAP, or trading while it is off, pays the treasury more; at the TWAP it is the set fee.
        int256 gap = int256(tick) - LeashOracle.twap(o, tick, m.terms.twapWindow);
        if (gap < 0) gap = -gap;
        if (gap > FEE_FREE_TICKS) {
            uint256 f = fee + uint256(gap - FEE_FREE_TICKS) * FEE_PIPS_PER_TICK;
            fee = f > m.terms.maxFee ? m.terms.maxFee : uint24(f);
        }
        return (this.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, fee | LPFeeLibrary.OVERRIDE_FEE_FLAG);
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
        // Both currencies must be deployed contracts: SafeTransferLib treats a call to an address without code
        // (native ETH's address(0), or a token not deployed yet) as a successful transfer, which would credit a
        // deposit or bond that never arrived.
        if (
            address(key.hooks) != address(this) || key.fee != LPFeeLibrary.DYNAMIC_FEE_FLAG
                || Currency.unwrap(key.currency0).code.length == 0 || Currency.unwrap(key.currency1).code.length == 0
        ) {
            revert NotLeashPool();
        }
        // The auction outlasts one TWAP window, so the oracle holds a full window before the manager can act.
        if (
            t.auctionEnd < block.timestamp + t.twapWindow || t.twapWindow == 0 || t.epochLength == 0 || t.epochs == 0
                || t.epochs > MAX_EPOCHS || t.maxFee > LPFeeLibrary.MAX_LP_FEE || t.minFee > t.maxFee
                || t.minLiquidity == 0 || t.uptimeBps > BPS || t.managerFeeBps > BPS || t.startStableBps > BPS
                || t.endStableBps > BPS || t.maxTickDeviation >= t.minHalfWidth || t.anchorLiquidity == 0
        ) revert BadTerms();
        id = key.toId();
        int24 tick = poolManager.initialize(key, sqrtPriceX96); // reverts if the pool already exists
        poolManager.updateDynamicLPFee(key, t.maxFee); // dynamic-fee pools start at 0
        Oracle storage o = _oracles[id];
        (o.obs[0], o.count, o.open) = (Obs(uint32(block.timestamp), tick, 0), 1, tick);

        Mandate storage m = _mandates[id];
        m.treasury = msg.sender;
        m.idle0 = amount0;
        m.idle1 = amount1;
        // Epoch 0 opens presumed compliant: the treasury's own position straddles the opening price and the manager
        // can't act before auctionEnd, so the first interval is judged by its end alone. A keeper checkpoint at
        // auctionEnd makes that interval empty.
        m.lastOk = true;
        m.terms = t;
        _pull(key.currency0, msg.sender, amount0);
        _pull(key.currency1, msg.sender, amount1);
        _place(key, m, tick, tick, initial.tickLower, initial.tickUpper, initial.liquidity);
        // The anchor puts liquidity at every price, so moving or holding the price anywhere costs capital and
        // invites arbitrage: that is what secures the TWAP. Funded from idle; only close removes it.
        ModifyLiquidityParams[2] memory ops;
        ops[0] = _anchorOp(key, int256(uint256(t.anchorLiquidity)));
        _modify(key, m, ops);
        _checkCover(key, sqrtPriceX96, t, amount0, amount1);
        emit MandateCreated(id, msg.sender, key, amount0, amount1);
    }

    /// @notice Ends the mandate: pulls the liquidity back and returns all inventory to the treasury. Open once the
    ///         auction ends with no bids, as soon as the manager is fired, or at the end, after settling every
    ///         remaining epoch here so a clean manager is always paid.
    function close(PoolKey calldata key) external {
        Mandate storage m = _live(key);
        if (msg.sender != m.treasury) revert NotTreasury();
        bool hired = m.manager != address(0);
        if (!m.breached && block.timestamp < (hired ? _end(m) : m.terms.auctionEnd)) revert NotEnded();
        while (hired && !m.breached && m.settled < m.terms.epochs) _settle(key, m, m.settled);

        m.closed = true;
        ModifyLiquidityParams[2] memory ops; // pull the managed position and the anchor; the anchor's fees ride along
        ops[0] = ModifyLiquidityParams(m.tickLower, m.tickUpper, -int256(uint256(m.liquidity)), 0);
        ops[1] = _anchorOp(key, -int256(uint256(m.terms.anchorLiquidity)));
        (m.tickLower, m.tickUpper, m.liquidity) = (0, 0, 0);
        _modify(key, m, ops);
        if (hired) owed[m.manager][_stable(key, m)] += m.bond; // what partial slashes left; zero if fired
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
        (, int24 spot,,) = poolManager.getSlot0(id);
        int24 twap = _guard(id, m, spot, liquidity);
        _sweep(key, m);
        _checkpoint(key, m);
        (uint256 f0, uint256 f1) = _place(key, m, twap, spot, tickLower, tickUpper, liquidity);
        EpochRecord storage r = _epochs[id][_epochAt(m)];
        (r.fees0, r.fees1) = (r.fees0 + uint128(f0), r.fees1 + uint128(f1));
        m.lastOk = _ok(key, m); // the next interval starts from the fixed position
        emit Rebalanced(id, tickLower, tickUpper, liquidity);
    }

    /// Rebalance guards; returns the TWAP.
    function _guard(PoolId id, Mandate storage m, int24 spot, uint128 liquidity) internal returns (int24 twap) {
        // The TWAP can't see within a block, so one rebalance per block. Growth is also refused once the price has
        // moved this block (a manager could push it and grow liquidity behind the push). Shrinking or re-ranging
        // at the same size is symmetric, so an in-block move doesn't block it: a one-tick nudge can't veto repairs.
        Oracle storage o = _oracles[id];
        bool grow = liquidity > m.liquidity;
        if (m.lastRebalance == block.timestamp || (grow && o.obs[o.index].time == block.timestamp && spot != o.open)) {
            revert SameBlock();
        }
        m.lastRebalance = uint40(block.timestamp);
        twap = _twap(id, m.terms.twapWindow);
        int256 gap = int256(spot) - twap;
        if (gap < 0) gap = -gap;
        if (gap > int256(uint256(m.terms.maxTickDeviation))) revert SpotOffTwap();
        if (grow) {
            // A sandwich only pays if the position is bigger on the way back than on the way out: growth needs
            // spot at the TWAP, and is rate-limited because the TWAP may lag a real move (see GROW_BPS).
            if (gap > MAX_GROW_GAP) revert SpotOffTwap();
            if (
                block.timestamp < uint256(m.lastGrow) + m.terms.twapWindow
                    || liquidity > uint256(m.liquidity) * (BPS + GROW_BPS) / BPS
            ) revert GrowTooFast();
            m.lastGrow = uint40(block.timestamp);
        }
    }

    function setFee(PoolKey calldata key, uint24 fee) external {
        Mandate storage m = _active(key);
        if (fee > m.terms.maxFee) revert FeeTooHigh();
        if (fee < m.terms.minFee) revert FeeTooLow();
        _checkpoint(key, m);
        poolManager.updateDynamicLPFee(key, fee);
        emit FeeSet(key.toId(), fee);
    }

    // ---------------------------------------------------------------- anyone

    /// @notice Accounts compliance up to now. Anyone may call; keepers call it every minute or so, since each
    ///         interval between checkpoints is booked in compliance only if it was compliant at both ends.
    function checkpoint(PoolKey calldata key) external {
        Mandate storage m = _live(key);
        _sweep(key, m);
        _checkpoint(key, m);
    }

    /// @notice Judges a finished epoch, in order. Clean: the manager earns managerFeeBps of its LP fees.
    ///         Missed uptime: part of the bond goes to the treasury, in proportion to the time out beyond the
    ///         allowance; at twice the allowance the whole bond goes and the manager is fired. The caller (unless
    ///         the treasury) earns KEEPER_BPS of the treasury's share of the epoch's fees.
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
        _sweep(key, m);
        _checkpoint(key, m);
        PoolId id = key.toId();
        EpochRecord storage r = _epochs[id][e];
        // Poke the position to collect its fees. ponytail: fees are booked when collected, so a late settle books
        // some of epoch e+1's fees to e. Settle promptly, or snapshot fee growth at epoch boundaries if it matters.
        (uint256 fees0, uint256 fees1) = _move(key, m, m.tickLower, m.tickUpper, m.liquidity);
        (fees0, fees1) = (r.fees0 + fees0, r.fees1 + fees1);
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
            // Partial slash: out-of-compliance time beyond the allowance, as a share of the allowance (both x BPS),
            // takes that share of the bond. Out for twice the allowance (or any out with none allowed) takes all of
            // it and fires the manager. ponytail: the share is of the bond left, so repeated misses shrink it
            // geometrically; store the winning bond and slash shares of that if repeat offenders matter.
            uint256 allowed = (BPS - m.terms.uptimeBps) * (uint256(r.inSecs) + r.outSecs);
            uint256 over = uint256(r.outSecs) * BPS - allowed; // > 0: not clean means out * BPS > allowed
            m.breached = over >= allowed;
            slashed = m.breached ? m.bond : m.bond * over / allowed;
            m.bond -= slashed;
            owed[m.treasury][_stable(key, m)] += slashed;
            records[m.manager].breached++;
        }
        // The last epoch, unless the manager was fired, frees what is left of the bond to the manager, so it never
        // depends on the treasury closing.
        if (e + 1 == m.terms.epochs && !m.breached) {
            owed[m.manager][_stable(key, m)] += m.bond;
            m.bond = 0;
        }
        // The treasury keeps the rest of the fees as inventory, less a keeper bounty for whoever settled (not the
        // treasury itself, which includes close()). Paid once per epoch, from the treasury's share only.
        (m.fees0, m.fees1) = (m.fees0 - fees0, m.fees1 - fees1);
        (fees0, fees1) = (fees0 - pay0, fees1 - pay1);
        if (msg.sender != m.treasury) {
            (uint256 k0, uint256 k1) = (fees0 * KEEPER_BPS / BPS, fees1 * KEEPER_BPS / BPS);
            owed[msg.sender][key.currency0] += k0;
            owed[msg.sender][key.currency1] += k1;
            (fees0, fees1) = (fees0 - k0, fees1 - k1);
        }
        (m.idle0, m.idle1) = (m.idle0 + fees0, m.idle1 + fees1);
        emit EpochSettled(id, e, r.clean, pay0, pay1, slashed);
    }

    // ---------------------------------------------------------------- compliance

    /// Credits the time since the last check to the epochs it spans, all in or all out of compliance. The TWAP
    /// drifts between checkpoints, so an interval counts as in only if the mandate was compliant at both ends:
    /// waiting out a bad stretch and checkpointing once the TWAP is back still books it out. Over-books by at most
    /// one interval per change of state. Time before epoch 0 or after the mandate is ignored.
    function _checkpoint(PoolKey calldata key, Mandate storage m) internal {
        uint256 start = m.terms.auctionEnd;
        uint256 from = m.lastCheck > start ? m.lastCheck : start;
        uint256 to = block.timestamp < _end(m) ? block.timestamp : _end(m);
        if (to <= from || m.manager == address(0) || m.breached || m.closed) return;
        m.lastCheck = uint40(to);
        bool okNow = _ok(key, m);
        bool ok = okNow && m.lastOk;
        m.lastOk = okNow;

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

    /// Fees the position earned before the manager's first epoch are the treasury's. beforeSwap can't unlock, so
    /// the first checkpoint(), rebalance or settle after the auction collects them straight into idle; only fees
    /// collected after that are booked to epochs. ponytail: fees from swaps between auctionEnd and that call go to
    /// the treasury too (the manager is underpaid by managerFeeBps of them, never overpaid); a keeper calling
    /// checkpoint() at auctionEnd closes the gap.
    /// Fees earned before the manager's first epoch go to the treasury. The sweep runs at the first checkpoint,
    /// rebalance or settle after the auction; if a swap came first, its beforeSwap measured them (fees accrue only
    /// in swaps, and the position can't change before the sweep), and the epoch keeps the rest of what is collected.
    function _sweep(PoolKey calldata key, Mandate storage m) internal {
        if (m.swept || block.timestamp < m.terms.auctionEnd) return;
        m.swept = true;
        (uint256 f0, uint256 f1) = _move(key, m, m.tickLower, m.tickUpper, m.liquidity);
        PreHire storage p = _preHire[key.toId()];
        if (p.taken) {
            // Collected beyond the measured pre-hire fees: earned since the auction, booked to the first unsettled
            // epoch (the earliest that can have earned it), as rebalance and settle book what they collect.
            (uint256 k0, uint256 k1) = (f0 > p.fees0 ? f0 - p.fees0 : 0, f1 > p.fees1 ? f1 - p.fees1 : 0);
            EpochRecord storage r = _epochs[key.toId()][m.settled];
            (r.fees0, r.fees1) = (r.fees0 + uint128(k0), r.fees1 + uint128(k1));
            (f0, f1) = (f0 - k0, f1 - k1);
        }
        (m.fees0, m.fees1, m.idle0, m.idle1) = (m.fees0 - f0, m.fees1 - f1, m.idle0 + f0, m.idle1 + f1);
    }

    function _ok(PoolKey calldata key, Mandate storage m) internal view returns (bool) {
        (bool inRange, bool deep, bool onPace,) = _compliance(key, m);
        return inRange && deep && onPace;
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

        stableBps = _stableBps(key, m, TickMath.getSqrtPriceAtTick(twap));
        onPace = stableBps <= _glide(m);
    }

    /// Stablecoin share of the inventory (idle + managed position + anchor), all valued at sqrt price p.
    function _stableBps(PoolKey calldata key, Mandate storage m, uint160 p) internal view returns (uint16) {
        (uint256 a0, uint256 a1) = _amounts(p, m.tickLower, m.tickUpper, m.liquidity);
        (uint256 b0, uint256 b1) = m.closed
            ? (0, 0)
            : _amounts(
                p,
                TickMath.minUsableTick(key.tickSpacing),
                TickMath.maxUsableTick(key.tickSpacing),
                m.terms.anchorLiquidity
            );
        (a0, a1) = (a0 + b0 + m.idle0, a1 + b1 + m.idle1);
        uint256 v0 = _value(a0, 0, p); // in currency1
        return v0 + a1 == 0 ? 0 : uint16(FullMath.mulDiv(m.terms.stableIs0 ? v0 : a1, BPS, v0 + a1));
    }

    /// The anchor must hold at least MIN_ANCHOR_BPS, and minBond at least MIN_BOND_BPS, of the deposit's value at
    /// the opening price (all in currency1).
    function _checkCover(PoolKey calldata key, uint160 p, Terms calldata t, uint256 amount0, uint256 amount1)
        internal
        pure
    {
        (uint256 a0, uint256 a1) = _amounts(
            p, TickMath.minUsableTick(key.tickSpacing), TickMath.maxUsableTick(key.tickSpacing), t.anchorLiquidity
        );
        uint256 v = _value(amount0, amount1, p);
        if (_value(a0, a1, p) * BPS < v * MIN_ANCHOR_BPS) revert ThinAnchor();
        if ((t.stableIs0 ? _value(t.minBond, 0, p) : t.minBond) * BPS < v * MIN_BOND_BPS) revert ThinBond();
    }

    /// a0 + a1 valued in currency1 at sqrt price p.
    function _value(uint256 a0, uint256 a1, uint160 p) internal pure returns (uint256) {
        return FullMath.mulDiv(FullMath.mulDiv(a0, p, FixedPoint96.Q96), p, FixedPoint96.Q96) + a1;
    }

    /// Token amounts of `liq` over [lo, hi) at sqrt price p.
    function _amounts(uint160 p, int24 lo, int24 hi, uint128 liq) internal pure returns (uint256 a0, uint256 a1) {
        (uint160 l, uint160 h) = (TickMath.getSqrtPriceAtTick(lo), TickMath.getSqrtPriceAtTick(hi));
        if (p < h) a0 = SqrtPriceMath.getAmount0Delta(p > l ? p : l, h, liq, false);
        if (p > l) a1 = SqrtPriceMath.getAmount1Delta(l, p < h ? p : h, liq, false);
    }

    /// Max stablecoin share now: linear from startStableBps at epoch 0 to endStableBps at the mandate's end.
    function _glide(Mandate storage m) internal view returns (uint256) {
        (uint256 start, uint256 end) = (m.terms.auctionEnd, _end(m));
        uint256 t = block.timestamp < start ? 0 : (block.timestamp > end ? end : block.timestamp) - start;
        (uint256 a, uint256 b) = (m.terms.startStableBps, m.terms.endStableBps);
        return b >= a ? a + (b - a) * t / (end - start) : a - (a - b) * t / (end - start);
    }

    function _twap(PoolId id, uint32 window) internal view returns (int24) {
        (, int24 spot,,) = poolManager.getSlot0(id);
        return LeashOracle.twap(_oracles[id], spot, window);
    }

    function _epochAt(Mandate storage m) internal view returns (uint256) {
        return block.timestamp < m.terms.auctionEnd ? 0 : (block.timestamp - m.terms.auctionEnd) / m.terms.epochLength;
    }

    // ---------------------------------------------------------------- liquidity

    /// Every managed position holds at least the depth floor, covers TWAP +- minHalfWidth and has spot strictly
    /// inside. The width caps how much inventory can be concentrated in the band between a pushed spot and the
    /// TWAP (at most maxTickDeviation, less than half the width), so a push can't sell the whole side off-price.
    function _place(PoolKey calldata key, Mandate storage m, int24 twap, int24 spot, int24 lo, int24 hi, uint128 liq)
        internal
        returns (uint256, uint256)
    {
        if (liq < m.terms.minLiquidity) revert TooShallow();
        int256 w = int256(uint256(m.terms.minHalfWidth));
        if (lo > twap - w || hi < twap + w || spot <= lo || spot >= hi) revert RangeMissesTwap();
        return _move(key, m, lo, hi, liq);
    }

    /// Replaces the managed position (or, given the same one, just collects its fees). Returns the fees collected.
    function _move(PoolKey calldata key, Mandate storage m, int24 lo, int24 hi, uint128 liq)
        internal
        returns (uint256, uint256)
    {
        bool poke = lo == m.tickLower && hi == m.tickUpper && liq == m.liquidity; // zero-liquidity update
        ModifyLiquidityParams[2] memory ops; // an op with tickLower == tickUpper is skipped (no old or no new position)
        ops[0] = ModifyLiquidityParams(m.tickLower, m.tickUpper, poke ? int256(0) : -int256(uint256(m.liquidity)), 0);
        if (!poke) ops[1] = ModifyLiquidityParams(lo, hi, int256(uint256(liq)), 0);
        (m.tickLower, m.tickUpper, m.liquidity) = (lo, hi, liq);
        return _modify(key, m, ops);
    }

    function _anchorOp(PoolKey calldata key, int256 delta) internal pure returns (ModifyLiquidityParams memory) {
        return ModifyLiquidityParams(
            TickMath.minUsableTick(key.tickSpacing), TickMath.maxUsableTick(key.tickSpacing), delta, ANCHOR
        );
    }

    /// Runs the ops in one unlock and books the result. Collected fees wait outside idle until settled (or, at
    /// close, go to the treasury). Underflow here reverts the whole call: positions can't use more than this
    /// mandate's inventory (not bonds, other mandates, or unsettled fees).
    function _modify(PoolKey calldata key, Mandate storage m, ModifyLiquidityParams[2] memory ops)
        internal
        returns (uint256 f0, uint256 f1)
    {
        (BalanceDelta d, BalanceDelta fees) =
            abi.decode(poolManager.unlock(abi.encode(key, ops)), (BalanceDelta, BalanceDelta));
        (f0, f1) = (uint128(fees.amount0()), uint128(fees.amount1()));
        m.idle0 = _apply(m.idle0, d.amount0() - fees.amount0());
        m.idle1 = _apply(m.idle1, d.amount1() - fees.amount1());
        (m.fees0, m.fees1) = (m.fees0 + f0, m.fees1 + f1);
    }

    function unlockCallback(bytes calldata data) external onlyPoolManager returns (bytes memory) {
        (PoolKey memory key, ModifyLiquidityParams[2] memory ops) =
            abi.decode(data, (PoolKey, ModifyLiquidityParams[2]));
        BalanceDelta d; // principal plus fees
        BalanceDelta fees;
        for (uint256 i; i < 2; i++) {
            if (ops[i].tickLower == ops[i].tickUpper) continue;
            (BalanceDelta di, BalanceDelta fi) = poolManager.modifyLiquidity(key, ops[i], "");
            (d, fees) = (d + di, fees + fi);
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
