// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

// Run through scripts/local.sh (fresh anvil). Anvil's public dev keys only, so it refuses any other chain.

import {console2} from "forge-std/console2.sol";
import {PoolManager} from "v4-core/PoolManager.sol";
import {PoolSwapTest} from "v4-core/test/PoolSwapTest.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {LPFeeLibrary} from "v4-core/libraries/LPFeeLibrary.sol";
import {FullMath} from "v4-core/libraries/FullMath.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {FixedPointMathLib} from "solmate/src/utils/FixedPointMathLib.sol";
import {Leash, Terms} from "../src/Leash.sol";
import {DeployLeash} from "./DeployLeash.s.sol";

/// @notice Fresh v4 + Leash on anvil with one live mandate: treasury (#0) deposited, managers #1 and #2
///         bid (#2 leads, #1's bond is claimable), auction still open. Writes deployments/31337.json.
contract Local is DeployLeash {
    using PoolIdLibrary for PoolKey;

    string constant MNEMONIC = "test test test test test test test test test test test junk";
    uint32 constant TREASURY = 0;
    uint32 constant MANAGER1 = 1;
    uint32 constant MANAGER2 = 2;
    uint32 constant SWAPPER = 3;

    uint256 public constant TKN_DEPOSIT = 100_000e18;
    uint256 public constant USDC_DEPOSIT = 200_000e6; // the deposit ratio sets the opening price: 1 TKN = 2 mUSDC
    uint256 public constant BID1 = 1_000e6;
    uint256 public constant BID2 = 1_500e6;

    PoolManager public manager;
    PoolSwapTest public swapRouter;
    MockERC20 public tkn;
    MockERC20 public usdc;
    Leash public leash;
    PoolKey public key;
    PoolId public id;
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
            Currency.wrap(address(t0)), Currency.wrap(address(t1)), LPFeeLibrary.DYNAMIC_FEE_FLAG, 60, IHooks(address(leash))
        );
        id = key.toId();
        uint160 sqrtPriceX96 = uint160(FixedPointMathLib.sqrt(FullMath.mulDiv(a1, 1 << 192, a0)));

        // ponytail: today's Terms/createMandate; the new contract adds TWAP/compliance terms and an initial Position.
        Terms memory t = Terms({
            stableIs0: usdcIs0,
            maxFee: 10_000, // 1%
            auctionEnd: uint40(block.timestamp + 10 minutes),
            epochLength: 1 hours,
            epochs: 3,
            minBond: BID1
        });
        t0.approve(address(leash), a0);
        t1.approve(address(leash), a1);
        leash.createMandate(key, sqrtPriceX96, t, a0, a1);
        vm.stopBroadcast();

        bid(MANAGER1, BID1);
        bid(MANAGER2, BID2); // outbids #1, whose bond becomes claimable via owed/claim
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

    function pk(uint32 i) public returns (uint256) {
        return vm.deriveKey(MNEMONIC, i);
    }

    function addr(uint32 i) public returns (address) {
        return vm.addr(pk(i));
    }
}
