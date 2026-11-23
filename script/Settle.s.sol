// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

// Run through scripts/keeper.sh. Signs with KEEPER_PRIVATE_KEY; on the local chain it defaults to anvil account #4.

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {Leash, Mandate, EpochRecord} from "../src/Leash.sol";

/// @notice Keeper: settles every ended, unsettled epoch of the pool in deployments/<chainId>.json, in order.
///         It decides with views only, never try/catch: forge still broadcasts a call that reverted in a try.
contract Settle is Script {
    using PoolIdLibrary for PoolKey;

    string constant MNEMONIC = "test test test test test test test test test test test junk";

    function run() external {
        string memory path = string.concat(vm.projectRoot(), "/deployments/", vm.toString(block.chainid), ".json");
        string memory json = vm.readFile(path);
        if (!vm.keyExistsJson(json, ".pool")) {
            console2.log("No pool in", path);
            return;
        }
        PoolKey memory key = PoolKey(
            Currency.wrap(vm.parseJsonAddress(json, ".pool.currency0")),
            Currency.wrap(vm.parseJsonAddress(json, ".pool.currency1")),
            uint24(vm.parseJsonUint(json, ".pool.fee")),
            int24(vm.parseJsonInt(json, ".pool.tickSpacing")),
            IHooks(vm.parseJsonAddress(json, ".pool.hooks"))
        );
        uint256 pk = vm.envOr("KEEPER_PRIVATE_KEY", block.chainid == 31337 ? vm.deriveKey(MNEMONIC, 4) : 0);
        require(pk != 0, "set KEEPER_PRIVATE_KEY");

        vm.startBroadcast(pk);
        settleEnded(Leash(address(key.hooks)), key);
        vm.stopBroadcast();
    }

    /// @return n how many epochs were settled
    function settleEnded(Leash leash, PoolKey memory key) public returns (uint256 n) {
        PoolId id = key.toId();
        Mandate memory m = leash.mandate(id);
        if (m.treasury == address(0) || m.manager == address(0) || m.closed) {
            console2.log("Skip: no mandate, no manager, or closed");
            return 0;
        }
        uint256 ended = leash.currentEpoch(key); // every epoch before the current one has ended
        if (ended > m.terms.epochs) ended = m.terms.epochs;

        // settle() demands e == m.settled, and a breach stops the mandate: re-read it after each one.
        while (!m.breached && m.settled < ended) {
            uint256 e = m.settled;
            leash.settle(key, e);
            EpochRecord memory r = leash.epochRecord(id, e);
            console2.log(
                string.concat("Settled epoch ", vm.toString(e), r.clean ? ": clean, manager paid" : ": BREACH, bond slashed")
            );
            m = leash.mandate(id);
            n++;
        }
        if (m.breached) console2.log("Mandate breached: nothing more to settle");
        else if (n == 0) console2.log("Nothing to settle; epochs settled so far:", m.settled);

        // PHASE 2: call leash.checkpoint(key) here on every run, once the contract exposes it.
    }
}
