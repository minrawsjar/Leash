// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {BaseHook} from "./utils/BaseHook.sol";
import {Hooks} from "v4-core/libraries/Hooks.sol";
import {LPFeeLibrary} from "v4-core/libraries/LPFeeLibrary.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {BalanceDelta} from "v4-core/types/BalanceDelta.sol";
import {ModifyLiquidityParams} from "v4-core/types/PoolOperation.sol";
import {ERC20} from "solmate/src/tokens/ERC20.sol";
import {SafeTransferLib} from "solmate/src/utils/SafeTransferLib.sol";

struct Terms {
    bool stableIs0; // which pool currency is the stablecoin; bonds are paid in it
    uint24 maxFee; // fee cap in pips; the manager can never set a higher fee
    uint40 auctionEnd; // bidding closes and epoch 0 starts
    uint32 epochLength; // seconds
    uint16 epochs;
    uint256 minBond;
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

/// @notice Treasury market-making mandates. The hook owns all liquidity in its pools;
///         the manager can only move it and set the fee, never withdraw it.
contract Leash is BaseHook, IUnlockCallback {
    using PoolIdLibrary for PoolKey;
    using SafeTransferLib for ERC20;

    error HookOnly();
    error NotLeashPool();
    error BadTerms();
    error NoMandate();
    error Closed();
    error AuctionClosed();
    error LowBid();
    error NotManager();
    error NotActive();
    error NotTreasury();
    error NotEnded();
    error FeeTooHigh();

    mapping(PoolId => Mandate) internal _mandates;
    /// @notice Pull payments (outbid bonds, returned bonds, pay): owed[account][currency].
    mapping(address => mapping(Currency => uint256)) public owed;

    constructor(IPoolManager pm) BaseHook(pm) {}

    function getHookPermissions() public pure override returns (Hooks.Permissions memory p) {
        p.beforeInitialize = true;
        p.beforeAddLiquidity = true;
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

    function mandate(PoolId id) external view returns (Mandate memory) {
        return _mandates[id];
    }

    // ---------------------------------------------------------------- treasury

    /// @notice Creates the pool, deposits the treasury's inventory and opens the bond auction.
    function createMandate(PoolKey calldata key, uint160 sqrtPriceX96, Terms calldata t, uint256 amount0, uint256 amount1)
        external
        returns (PoolId id)
    {
        // Native ETH is rejected: SafeTransferLib treats calls to address(0) as successful transfers.
        if (address(key.hooks) != address(this) || key.fee != LPFeeLibrary.DYNAMIC_FEE_FLAG || key.currency0.isAddressZero()) {
            revert NotLeashPool();
        }
        if (t.auctionEnd <= block.timestamp || t.epochLength == 0 || t.epochs == 0 || t.maxFee > LPFeeLibrary.MAX_LP_FEE) {
            revert BadTerms();
        }
        id = key.toId();
        poolManager.initialize(key, sqrtPriceX96); // reverts if the pool already exists
        poolManager.updateDynamicLPFee(key, t.maxFee); // dynamic-fee pools start at 0

        Mandate storage m = _mandates[id];
        m.treasury = msg.sender;
        m.idle0 = amount0;
        m.idle1 = amount1;
        m.terms = t;
        _pull(key.currency0, msg.sender, amount0);
        _pull(key.currency1, msg.sender, amount1);
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

        (uint256 a0, uint256 a1) = (m.idle0, m.idle1);
        (m.idle0, m.idle1) = (0, 0);
        _push(key.currency0, m.treasury, a0);
        _push(key.currency1, m.treasury, a1);
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
    }

    /// @notice Moves the treasury's liquidity to a new range. Funds only ever move between the hook and the pool.
    function rebalance(PoolKey calldata key, int24 tickLower, int24 tickUpper, uint128 liquidity) external {
        _move(key, _active(key), tickLower, tickUpper, liquidity);
    }

    function setFee(PoolKey calldata key, uint24 fee) external {
        Mandate storage m = _active(key);
        if (fee > m.terms.maxFee) revert FeeTooHigh();
        poolManager.updateDynamicLPFee(key, fee);
    }

    // ---------------------------------------------------------------- anyone

    function claim(Currency c) external {
        uint256 a = owed[msg.sender][c];
        owed[msg.sender][c] = 0;
        _push(c, msg.sender, a);
    }

    // ---------------------------------------------------------------- liquidity

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
        _settle(key.currency0, d.amount0());
        _settle(key.currency1, d.amount1());
        return abi.encode(d);
    }

    function _settle(Currency c, int128 amount) internal {
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
        if (m.closed) revert Closed();
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
