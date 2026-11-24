// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

// Testnet tokens for posting mandates on Unichain Sepolia: TKN (18 decimals) and mUSDC (6 decimals).
// Anyone can mint them (solmate's MockERC20 has an open mint): testnet only, worth nothing.
//   forge script script/Tokens.s.sol --rpc-url unichain_sepolia --broadcast
// Mint more to any wallet later (TO defaults to the key's own address):
//   TO=0x... forge script script/Tokens.s.sol:Faucet --rpc-url unichain_sepolia --broadcast
import {Script, console2} from "forge-std/Script.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";

contract Tokens is Script {
    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address me = vm.addr(pk); // not msg.sender: inside a script that is forge's default sender
        vm.startBroadcast(pk);
        MockERC20 tkn = new MockERC20("Leash Test Token", "TKN", 18);
        MockERC20 usdc = new MockERC20("Mock USDC", "mUSDC", 6);
        tkn.mint(me, 10_000_000e18);
        usdc.mint(me, 10_000_000e6);
        vm.stopBroadcast();

        string memory o = "tokens";
        vm.serializeUint(o, "chainId", block.chainid);
        vm.serializeAddress(o, "tkn", address(tkn));
        string memory json = vm.serializeAddress(o, "usdc", address(usdc));
        vm.writeJson(json, string.concat("deployments/", vm.toString(block.chainid), "-tokens.json"));
        console2.log("TKN  ", address(tkn));
        console2.log("mUSDC", address(usdc));
    }
}

/// Mints 1M TKN and 1M mUSDC to TO (default: the key's address) using deployments/<chainId>-tokens.json.
contract Faucet is Script {
    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address to = vm.envOr("TO", vm.addr(pk));
        string memory json = vm.readFile(string.concat("deployments/", vm.toString(block.chainid), "-tokens.json"));
        vm.startBroadcast(pk);
        MockERC20(vm.parseJsonAddress(json, ".tkn")).mint(to, 1_000_000e18);
        MockERC20(vm.parseJsonAddress(json, ".usdc")).mint(to, 1_000_000e6);
        vm.stopBroadcast();
        console2.log("minted 1M TKN + 1M mUSDC to", to);
    }
}
