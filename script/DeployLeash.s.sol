// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

// Unichain Sepolia (forge loads PRIVATE_KEY from .env, see .env.example):
//   forge script script/DeployLeash.s.sol --rpc-url unichain_sepolia --broadcast

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {Hooks} from "v4-core/libraries/Hooks.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {Leash} from "../src/Leash.sol";
import {HookMiner} from "./HookMiner.sol";

/// @notice Deploys Leash through the standard CREATE2 deployer at an address whose low bits encode
///         its permissions, and writes deployments/<chainId>.json.
contract DeployLeash is Script {
    /// Uniswap v4 PoolManager on Unichain Sepolia (chain 1301), per developers.uniswap.org v4 deployments.
    address constant UNICHAIN_SEPOLIA_POOL_MANAGER = 0x00B036B58a818B1BC34d502D3fE730Db729e62AC;

    function run() external virtual {
        address pm = vm.envOr("POOL_MANAGER", block.chainid == 1301 ? UNICHAIN_SEPOLIA_POOL_MANAGER : address(0));
        require(pm.code.length > 0, "no PoolManager on this chain: set POOL_MANAGER");

        vm.startBroadcast(vm.envUint("PRIVATE_KEY"));
        Leash leash = deployLeash(IPoolManager(pm));
        vm.stopBroadcast();

        string memory o = "deployment";
        vm.serializeUint(o, "chainId", block.chainid);
        vm.serializeUint(o, "block", block.number);
        vm.serializeAddress(o, "poolManager", pm);
        vm.writeJson(vm.serializeAddress(o, "leash", address(leash)), deploymentPath());
        console2.log("Leash:", address(leash));
        console2.log("Wrote", deploymentPath());
    }

    function deployLeash(IPoolManager pm) public returns (Leash leash) {
        bytes memory initCode = abi.encodePacked(type(Leash).creationCode, abi.encode(pm));
        (address mined, bytes32 salt) = HookMiner.find(CREATE2_FACTORY, hookFlags(), initCode);
        leash = new Leash{salt: salt}(pm); // forge routes salted creates through CREATE2_FACTORY
        require(address(leash) == mined, "hook address mismatch");
    }

    /// @notice Leash's flag bits, read from the contract itself so the address tracks new permissions.
    function hookFlags() public returns (uint160) {
        // getHookPermissions() is pure, but needs code to call: run it on Leash's runtime code at a scratch address.
        address scratch = address(uint160(uint256(keccak256("leash.hookFlags"))));
        vm.etch(scratch, vm.getDeployedCode("Leash.sol:Leash"));
        return flags(Leash(scratch).getHookPermissions());
    }

    function flags(Hooks.Permissions memory p) public pure returns (uint160 f) {
        if (p.beforeInitialize) f |= Hooks.BEFORE_INITIALIZE_FLAG;
        if (p.afterInitialize) f |= Hooks.AFTER_INITIALIZE_FLAG;
        if (p.beforeAddLiquidity) f |= Hooks.BEFORE_ADD_LIQUIDITY_FLAG;
        if (p.afterAddLiquidity) f |= Hooks.AFTER_ADD_LIQUIDITY_FLAG;
        if (p.beforeRemoveLiquidity) f |= Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG;
        if (p.afterRemoveLiquidity) f |= Hooks.AFTER_REMOVE_LIQUIDITY_FLAG;
        if (p.beforeSwap) f |= Hooks.BEFORE_SWAP_FLAG;
        if (p.afterSwap) f |= Hooks.AFTER_SWAP_FLAG;
        if (p.beforeDonate) f |= Hooks.BEFORE_DONATE_FLAG;
        if (p.afterDonate) f |= Hooks.AFTER_DONATE_FLAG;
        if (p.beforeSwapReturnDelta) f |= Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG;
        if (p.afterSwapReturnDelta) f |= Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG;
        if (p.afterAddLiquidityReturnDelta) f |= Hooks.AFTER_ADD_LIQUIDITY_RETURNS_DELTA_FLAG;
        if (p.afterRemoveLiquidityReturnDelta) f |= Hooks.AFTER_REMOVE_LIQUIDITY_RETURNS_DELTA_FLAG;
    }

    function deploymentPath() internal view returns (string memory) {
        return string.concat(vm.projectRoot(), "/deployments/", vm.toString(block.chainid), ".json");
    }
}
