// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

// Superseded by scripts/keeper.sh, which discovers every mandate from MandateCreated logs and applies the same rules
// with cast. Kept for test/Settle.t.sol (keep()) and as a one-pool round for a deployments file that has a `pool`
// key (31337.json). Signs with KEEPER_PRIVATE_KEY; on the local chain it defaults to anvil account #4.

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {Leash, Mandate, EpochRecord} from "../src/Leash.sol";

/// @notice Keeper for the pool in deployments/<chainId>.json: checkpoints compliance, then settles every ended,
///         unsettled epoch in order. It decides with views only, never try/catch: forge still broadcasts a call
///         that reverted in a try.
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
        keep(Leash(address(key.hooks)), key);
        vm.stopBroadcast();
    }

    /// @notice One keeper round: checkpoint compliance (and the first round after the auction sweeps
    ///         pre-mandate fees to the treasury), then settle ended epochs in order.
    /// @return checkpointed whether checkpoint() was called
    /// @return n how many epochs were settled
    function keep(Leash leash, PoolKey memory key) public returns (bool checkpointed, uint256 n) {
        PoolId id = key.toId();
        Mandate memory m = leash.mandate(id);
        if (m.treasury == address(0) || m.closed) {
            console2.log("Skip: no mandate, or closed");
            return (false, 0);
        }
        uint256 start = m.terms.auctionEnd;
        if (block.timestamp < start) {
            console2.log("Auction still open");
            return (false, 0);
        }

        // Each interval between checkpoints books "in" only if compliant at both ends, so call it every round
        // until the whole mandate is booked, or while fees await their sweep. Not gated on block.timestamp:
        // on an idle chain the simulated block is stale, while the tx itself lands at the real time.
        uint256 end = start + uint256(m.terms.epochLength) * m.terms.epochs;
        if (!m.swept || (m.manager != address(0) && !m.breached && m.lastCheck < end)) {
            leash.checkpoint(key);
            checkpointed = true;
            (bool inRange, bool deep, bool onPace, uint16 stableBps) = leash.compliance(key);
            console2.log(
                string.concat(
                    "Checkpoint: ",
                    inRange && deep && onPace ? "compliant" : "OUT of compliance",
                    " (inRange ", vm.toString(inRange), ", deep ", vm.toString(deep), ", onPace ", vm.toString(onPace),
                    ", stable ", vm.toString(stableBps), " bps)"
                )
            );
        }
        if (m.manager == address(0)) {
            console2.log("No manager: nothing to settle");
            return (checkpointed, 0);
        }

        uint256 ended = leash.currentEpoch(key); // every epoch before the current one has ended
        if (ended > m.terms.epochs) ended = m.terms.epochs;
        // settle() demands e == m.settled, and a breach stops the mandate: re-read it after each one.
        while (!m.breached && m.settled < ended) {
            uint256 e = m.settled;
            leash.settle(key, e);
            EpochRecord memory r = leash.epochRecord(id, e);
            console2.log(
                string.concat(
                    "Settled epoch ", vm.toString(e), r.clean ? ": clean" : ": BREACH, bond slashed",
                    " (in ", vm.toString(r.inSecs), "s, out ", vm.toString(r.outSecs), "s, fees ",
                    vm.toString(r.fees0), " / ", vm.toString(r.fees1), ")"
                )
            );
            m = leash.mandate(id);
            n++;
        }
        if (m.breached) console2.log("Mandate breached: nothing more to settle");
        else if (n == 0) console2.log("Nothing to settle; epochs settled so far:", m.settled);
    }
}
