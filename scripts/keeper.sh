#!/usr/bin/env bash
# Keeper: every INTERVAL seconds (default 60), checkpoints compliance for the pool in deployments/<chainId>.json
# and settles every ended, unsettled epoch (script/Settle.s.sol). Compliance is booked per interval between
# checkpoints, so keep INTERVAL short. Signs with KEEPER_PRIVATE_KEY, which defaults to anvil
# account #4 on the local chain. RPC_URL defaults to the local chain; use RPC_URL=unichain_sepolia for testnet.
set -euo pipefail
cd "$(dirname "$0")/.."

RPC=${RPC_URL:-http://127.0.0.1:8545}
INTERVAL=${INTERVAL:-60}
while true; do
  echo "[$(date +%T)] keeper run"
  # Forge simulates at the latest block's time and sizes gas from that. An idle anvil mines no blocks, so that
  # time goes stale and a checkpoint that books real time runs out of gas: mine one first, as a live chain would.
  [ "$(cast chain-id --rpc-url "$RPC" 2>/dev/null)" = 31337 ] && cast rpc evm_mine --rpc-url "$RPC" >/dev/null
  # A failed run (RPC hiccup, gas) is retried next round rather than stopping the keeper.
  forge script script/Settle.s.sol:Settle --rpc-url "$RPC" --broadcast --slow 2>&1 \
    | sed -n '/== Logs ==/,/^$/p;/ONCHAIN EXECUTION COMPLETE/p;/[Ee]rror/p' || true
  sleep "$INTERVAL"
done
