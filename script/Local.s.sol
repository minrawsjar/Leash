// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

// Run through scripts/local.sh (fresh anvil). Anvil's public dev keys only, so it refuses any other chain.

import {console2} from "forge-std/console2.sol";
import {PoolManager} from "v4-core/PoolManager.sol";
import {PoolSwapTest} from "v4-core/test/PoolSwapTest.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {LPFeeLibrary} from "v4-core/libraries/LPFeeLibrary.sol";
import {FullMath} from "v4-core/libraries/FullMath.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";
import {SwapParams} from "v4-core/types/PoolOperation.sol";
import {LiquidityAmounts} from "v4-periphery/src/libraries/LiquidityAmounts.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {FixedPointMathLib} from "solmate/src/utils/FixedPointMathLib.sol";
import {Leash, Terms, Position} from "../src/Leash.sol";
import {DeployLeash} from "./DeployLeash.s.sol";

/// @notice Fresh v4 + Leash on anvil with one live mandate: treasury (#0) deposited with half its inventory
///         in the opening position, managers #1 and #2 bid (#2 leads, #1's bond is claimable), swapper #3
///         traded a little (oracle observations, LP fees), auction still open. Writes deployments/31337.json.
contract Local is DeployLeash {
    using PoolIdLibrary for PoolKey;

    string constant MNEMONIC = "test test test test test test test test test test test junk";
    uint32 constant TREASURY = 0;
    uint32 constant MANAGER1 = 1;
    uint32 constant MANAGER2 = 2;
    uint32 constant SWAPPER = 3;

    uint256 public constant TKN_DEPOSIT = 100_000e18;
    uint256 public constant USDC_DEPOSIT = 200_000e6; // the deposit ratio sets the opening price: 1 TKN = 2 mUSDC
    uint256 public constant BID1 = 10_000e6; // the minimum bond: 2.5% of the 400,000 mUSDC deposit (MIN_BOND_BPS is 2%)
    uint256 public constant BID2 = 12_000e6;

    PoolManager public manager;
    PoolSwapTest public swapRouter;
    MockERC20 public tkn;
    MockERC20 public usdc;
    Leash public leash;
    PoolKey public key;
    PoolId public id;
    uint160 public openSqrtPriceX96;
    uint256 public deployBlock;

    function run() external override {
        require(block.chainid == 31337, "local anvil only");
        deployStack();
        writeDeployment();
        console2.log("PoolManager:", address(manager));
        console2.log("PoolSwapTest:", address(swapRouter));
        console2.log("TKN:", address(tkn));
        console2.log("mUSDC:", address(usdc));
        console2.log("Leash:", address(leash));
        console2.log("PoolId:", vm.toString(PoolId.unwrap(id)));
        console2.log("Wrote", deploymentPath());
    }

    function deployStack() public {
        deployBlock = block.number;
        vm.startBroadcast(pk(TREASURY));
        manager = new PoolManager(addr(TREASURY));
        swapRouter = new PoolSwapTest(manager);
        tkn = new MockERC20("Treasury Token", "TKN", 18);
        usdc = new MockERC20("Mock USDC", "mUSDC", 6);
        leash = deployLeash(manager);
        for (uint32 i; i <= SWAPPER; i++) {
            tkn.mint(addr(i), 1_000_000e18);
            usdc.mint(addr(i), 1_000_000e6);
        }

        bool usdcIs0 = address(usdc) < address(tkn);
        (MockERC20 t0, MockERC20 t1) = usdcIs0 ? (usdc, tkn) : (tkn, usdc);
        (uint256 a0, uint256 a1) = usdcIs0 ? (USDC_DEPOSIT, TKN_DEPOSIT) : (TKN_DEPOSIT, USDC_DEPOSIT);
        key = PoolKey(
            Currency.wrap(address(t0)),
            Currency.wrap(address(t1)),
            LPFeeLibrary.DYNAMIC_FEE_FLAG,
            60,
            IHooks(address(leash))
        );
        id = key.toId();
        openSqrtPriceX96 = uint160(FixedPointMathLib.sqrt(FullMath.mulDiv(a1, 1 << 192, a0)));
        Position memory p = initialPosition(a0, a1);
        t0.approve(address(leash), a0);
        t1.approve(address(leash), a1);
        leash.createMandate(key, openSqrtPriceX96, terms(usdcIs0, p.liquidity, anchorLiquidity(a0, a1)), a0, a1, p);
        vm.stopBroadcast();

        bid(MANAGER1, BID1);
        bid(MANAGER2, BID2); // outbids #1, whose bond becomes claimable via owed/claim
        trade();
    }

    /// Half of each deposit in a +-1200 tick (~12%) range around the opening price. A fifth goes to the full-range
    /// anchor (see anchorLiquidity) and the remaining ~30% stays idle.
    function initialPosition(uint256 a0, uint256 a1) internal view returns (Position memory p) {
        int24 base = TickMath.getTickAtSqrtPrice(openSqrtPriceX96) / 60 * 60;
        (p.tickLower, p.tickUpper) = (base - 1200, base + 1200);
        p.liquidity = LiquidityAmounts.getLiquidityForAmounts(
            openSqrtPriceX96,
            TickMath.getSqrtPriceAtTick(p.tickLower),
            TickMath.getSqrtPriceAtTick(p.tickUpper),
            a0 / 2,
            a1 / 2
        );
    }

    /// A fifth of each deposit across the full range: the anchor holds ~20% of the inventory's value.
    function anchorLiquidity(uint256 a0, uint256 a1) internal view returns (uint128) {
        return LiquidityAmounts.getLiquidityForAmounts(
            openSqrtPriceX96,
            TickMath.getSqrtPriceAtTick(TickMath.minUsableTick(60)),
            TickMath.getSqrtPriceAtTick(TickMath.maxUsableTick(60)),
            a0 / 5,
            a1 / 5
        );
    }

    function terms(bool usdcIs0, uint128 liquidity, uint128 anchor) internal view returns (Terms memory) {
        return Terms({
            stableIs0: usdcIs0,
            maxFee: 10_000, // 1%
            auctionEnd: uint40(block.timestamp + 10 minutes), // must outlast twapWindow
            epochLength: 1 hours,
            epochs: 3,
            minBond: BID1,
            twapWindow: 120,
            maxTickDeviation: 100,
            minLiquidity: liquidity / 2,
            uptimeBps: 9500,
            managerFeeBps: 3000,
            startStableBps: 6000, // inventory opens at 50% stablecoin by value, so it starts on pace
            endStableBps: 8000,
            minFee: 500, // 0.05%: every round trip through the pool costs at least this
            minHalfWidth: 200, // >= 2x maxTickDeviation: a pushed spot can reach at most half way to the range's edge
            anchorLiquidity: anchor // full range, ~20% of the deposits' value
        });
    }

    /// A few small trades by #3, so the oracle has observations and the position has earned fees.
    function trade() internal {
        vm.startBroadcast(pk(SWAPPER));
        tkn.approve(address(swapRouter), type(uint256).max);
        usdc.approve(address(swapRouter), type(uint256).max);
        swap(usdc, 1_000e6); // buy TKN
        swap(tkn, 300e18); // sell TKN
        swap(usdc, 500e6);
        vm.stopBroadcast();
    }

    /// Exact-input swap of `amount` of `tokenIn`, no price limit.
    function swap(MockERC20 tokenIn, uint256 amount) internal {
        bool zeroForOne = Currency.unwrap(key.currency0) == address(tokenIn);
        uint160 limit = zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1;
        swapRouter.swap(
            key, SwapParams(zeroForOne, -int256(amount), limit), PoolSwapTest.TestSettings(false, false), ""
        );
    }

    function bid(uint32 who, uint256 amount) internal {
        vm.startBroadcast(pk(who));
        usdc.approve(address(leash), amount);
        leash.bid(key, amount);
        vm.stopBroadcast();
    }

    function writeDeployment() internal {
        string memory pool = "pool";
        vm.serializeAddress(pool, "currency0", Currency.unwrap(key.currency0));
        vm.serializeAddress(pool, "currency1", Currency.unwrap(key.currency1));
        vm.serializeUint(pool, "fee", key.fee);
        vm.serializeInt(pool, "tickSpacing", key.tickSpacing);
        vm.serializeAddress(pool, "hooks", address(key.hooks));
        pool = vm.serializeBytes32(pool, "id", PoolId.unwrap(id));

        string memory accounts = "accounts";
        vm.serializeAddress(accounts, "treasury", addr(TREASURY));
        vm.serializeAddress(accounts, "manager1", addr(MANAGER1));
        vm.serializeAddress(accounts, "manager2", addr(MANAGER2));
        accounts = vm.serializeAddress(accounts, "swapper", addr(SWAPPER));

        string memory o = "deployment";
        vm.serializeUint(o, "chainId", block.chainid);
        vm.serializeUint(o, "block", deployBlock);
        vm.serializeAddress(o, "poolManager", address(manager));
        vm.serializeAddress(o, "swapRouter", address(swapRouter));
        vm.serializeAddress(o, "leash", address(leash));
        vm.serializeAddress(o, "tkn", address(tkn));
        vm.serializeAddress(o, "usdc", address(usdc));
        vm.serializeString(o, "pool", pool);
        vm.writeJson(vm.serializeString(o, "accounts", accounts), deploymentPath());
    }

    /// The public `key` getter returns a tuple; this returns the struct.
    function poolKey() external view returns (PoolKey memory) {
        return key;
    }

    function pk(uint32 i) public pure returns (uint256) {
        return vm.deriveKey(MNEMONIC, i);
    }

    function addr(uint32 i) public pure returns (address) {
        return vm.addr(pk(i));
    }
}
