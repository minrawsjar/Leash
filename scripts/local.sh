#!/usr/bin/env bash
# Local dev chain for the frontend: a fresh anvil at http://127.0.0.1:8545 with Uniswap v4, two mock
# tokens, Leash and one live mandate (script/Local.s.sol). Writes deployments/31337.json and
# deployments/abi/Leash.json, then streams anvil's log. Ctrl-C stops anvil.
set -euo pipefail
cd "$(dirname "$0")/.."

RPC=http://127.0.0.1:8545
if cast chain-id --rpc-url $RPC >/dev/null 2>&1; then
  echo "Something is already listening on $RPC; stop it first (this script needs a fresh chain)." >&2
  exit 1
fi

LOG=$(mktemp)
anvil >"$LOG" 2>&1 &
ANVIL=$!
trap 'kill $(jobs -p) 2>/dev/null; rm -f "$LOG"' EXIT
until cast chain-id --rpc-url $RPC >/dev/null 2>&1; do
  kill -0 $ANVIL 2>/dev/null || { cat "$LOG"; exit 1; }
  sleep 0.2
done

# Anvil stamps a burst of blocks with the same second; space them 1s apart so the swapper's trades
# land in separate seconds and reach Leash's oracle (one observation per second).
cast rpc anvil_setBlockTimestampInterval 1 --rpc-url $RPC >/dev/null
forge script script/Local.s.sol:Local --rpc-url $RPC --broadcast --slow
cast rpc anvil_removeBlockTimestampInterval --rpc-url $RPC >/dev/null
mkdir -p deployments/abi
jq .abi out/Leash.sol/Leash.json >deployments/abi/Leash.json

cat <<EOF

Leash local chain ready at $RPC (chain 31337). Addresses: deployments/31337.json, ABI: deployments/abi/Leash.json
Accounts (anvil's default mnemonic): #0 treasury, #1 and #2 managers (#2 leads the auction), #3 swapper.
Auction closes 10 min after deploy; epochs are 1 hour x 3. Skip ahead with:
  cast rpc evm_increaseTime 600 --rpc-url $RPC && cast rpc evm_mine --rpc-url $RPC
Streaming anvil's log below. Ctrl-C stops the chain.

EOF
tail -n 0 -f "$LOG" &
wait $ANVIL
