#!/usr/bin/env bash
# Keeper for every Leash mandate on a chain. Discovers mandates from the hook's MandateCreated logs (leash address
# and start block from deployments/<chainId>.json), then every INTERVAL seconds, for each live mandate: calls
# checkpoint(key) and settles every ended, unsettled epoch in order. Decides with view calls only (cast call),
# the same rules as script/Settle.s.sol's keep(), which it supersedes.
#
#   ./scripts/keeper.sh [--dry-run] [--once]
#
#   RPC_URL      default https://unichain-sepolia-rpc.publicnode.com (a URL or a foundry.toml alias)
#   PRIVATE_KEY  signer, needs gas only (KEEPER_PRIVATE_KEY also accepted; anvil #4 on 31337). Never printed.
#   INTERVAL     seconds between rounds, default 60. Compliance is booked per interval, so keep it short.
#   CHUNK        blocks per eth_getLogs call, default 1000 (sepolia.unichain.org's cap; drpc's free tier is 100)
#   LOG_RPCS     space-separated RPCs tried in turn for each log chunk; default RPC_URL, plus the public
#                Unichain Sepolia RPCs on 1301 (publicnode answers "pruned history" for some ranges)
set -euo pipefail
cd "$(dirname "$0")/.."

DRY=0 ONCE=0
for a in "$@"; do
  case $a in
    --dry-run) DRY=1 ;;
    --once) ONCE=1 ;;
    *) echo "usage: $0 [--dry-run] [--once]" >&2; exit 2 ;;
  esac
done

RPC=${RPC_URL:-https://unichain-sepolia-rpc.publicnode.com}
INTERVAL=${INTERVAL:-60}
CHUNK=${CHUNK:-1000}
CHAIN=$(cast chain-id --rpc-url "$RPC")
DEP=deployments/$CHAIN.json
[ -f "$DEP" ] || { echo "no $DEP" >&2; exit 1; }
LEASH=$(jq -r .leash "$DEP")
FROM=$(jq -r .block "$DEP")
if [ "$CHAIN" = 1301 ]; then
  LOG_RPCS=${LOG_RPCS:-"$RPC https://unichain-sepolia-rpc.publicnode.com https://sepolia.unichain.org"}
else
  LOG_RPCS=${LOG_RPCS:-$RPC}
fi

PK=${PRIVATE_KEY:-${KEEPER_PRIVATE_KEY:-}}
if [ -z "$PK" ] && [ "$CHAIN" = 31337 ]; then
  PK=$(cast wallet private-key --mnemonic "test test test test test test test test test test test junk" --mnemonic-index 4)
fi
[ -n "$PK" ] || [ "$DRY" = 1 ] || { echo "set PRIVATE_KEY (or use --dry-run)" >&2; exit 1; }

KEY_T='(address,address,uint24,int24,address)'
TOPIC=$(cast keccak "MandateCreated(bytes32,address,$KEY_T,uint256,uint256)")
MANDATE="mandate(bytes32)((address,address,uint256,uint256,uint256,uint256,uint256,int24,int24,uint128,uint40,uint16,bool,bool,bool,bool,uint40,uint40,(bool,uint24,uint40,uint32,uint16,uint256,uint32,uint24,uint128,uint16,uint16,uint16,uint16,uint24,uint24,uint128)))"

IDS=() KEYS=()  # pool ids and their PoolKey tuples, e.g. (0xc0,0xc1,8388608,60,0xhook); bash 3.2 has no maps
SCANNED=$((FROM - 1))

log() { echo "[$(date +%T)] $*"; }

# Each pool's log data is its PoolKey (5 words) then amount0, amount1: all static, so slice words.
word() { echo "${1:$((64 * $2)):64}"; }
addr() { cast to-check-sum-address "0x${1:24}"; }

# Fetch MandateCreated logs from SCANNED+1 to head in CHUNK-block pieces. A chunk no RPC answers ends the scan
# there; the next round resumes from it.
scan() {
  local head f t r out ok
  head=$(cast block-number --rpc-url "$RPC") || return 1
  for ((f = SCANNED + 1; f <= head; f += CHUNK)); do
    t=$((f + CHUNK - 1)); ((t > head)) && t=$head
    ok=0
    for r in $LOG_RPCS $LOG_RPCS; do  # two passes over the list
      if out=$(cast logs --json --rpc-url "$r" --from-block "$f" --to-block "$t" --address "$LEASH" "$TOPIC" 2>/dev/null); then
        ok=1; break
      fi
    done
    if [ "$ok" = 0 ]; then log "logs $f-$t: no RPC answered, retrying next round"; return; fi
    while read -r id data; do
      [ -n "$id" ] || continue
      IDS+=("$id")
      KEYS+=("($(addr "$(word "$data" 0)"),$(addr "$(word "$data" 1)"),$((16#$(word "$data" 2))),$((16#$(word "$data" 3))),$(addr "$(word "$data" 4)"))")
      log "found mandate $id ${KEYS[${#KEYS[@]} - 1]}"
    done < <(jq -r '.[] | "\(.topics[1]) \(.data[2:])"' <<<"$out")
    SCANNED=$t
  done
}

send() {  # send <sig> <args...>
  if [ "$DRY" = 1 ]; then
    echo "    would send: cast send $LEASH \"$1\" ${*:2}"
    return 0
  fi
  if cast send --rpc-url "$RPC" --private-key "$PK" "$LEASH" "$@" >/dev/null 2>&1; then
    echo "    sent: $1 ${*:2}"
  else
    echo "    FAILED: $1 ${*:2} (retried next round)"
    return 1
  fi
}

# One mandate: the same decisions as Settle.s.sol's keep().
keep() {
  local id=$1 key=$2 m now end ended e
  # Called from an || list, where set -e is off: every read checks itself, so a failed read sends nothing.
  m=$(cast call --json --rpc-url "$RPC" "$LEASH" "$MANDATE" "$id" | jq -c '.[0]') && [ -n "$m" ] || return 1
  # Fields: 0 treasury, 1 manager, 10 lastCheck, 11 settled, 13 breached, 14 closed, 15 swept, 18 terms.
  # Terms: 2 auctionEnd, 3 epochLength, 4 epochs.
  read -r treasury manager lastCheck settled breached closed swept auctionEnd epochLength epochs < <(
    jq -r '[.[0], .[1], .[10], .[11], .[13], .[14], .[15], .[18][2], .[18][3], .[18][4]] | @tsv' <<<"$m")
  local zero=0x0000000000000000000000000000000000000000
  echo "  $id"
  if [ "$treasury" = "$zero" ] || [ "$closed" = true ]; then echo "    closed: skip"; return; fi
  now=$(cast block latest -f timestamp --rpc-url "$RPC") || return 1
  if ((now < auctionEnd)); then echo "    auction open for $((auctionEnd - now))s: skip"; return; fi

  # Checkpoint every round until the whole term is booked, or while pre-mandate fees await their sweep.
  end=$((auctionEnd + epochLength * epochs))
  if [ "$swept" = false ] || { [ "$manager" != "$zero" ] && [ "$breached" = false ] && ((lastCheck < end)); }; then
    send "checkpoint($KEY_T)" "$key" || return 0
  fi
  if [ "$manager" = "$zero" ]; then echo "    no manager: nothing to settle"; return; fi

  ended=$(cast call --rpc-url "$RPC" "$LEASH" "currentEpoch($KEY_T)(uint256)" "$key") || return 1
  ((ended > epochs)) && ended=$epochs
  # settle() demands e == m.settled and stops at a breach: re-read the mandate after each one.
  for ((e = settled; e < ended; e++)); do
    [ "$breached" = false ] || break
    send "settle($KEY_T,uint256)" "$key" "$e" || return 0
    [ "$DRY" = 1 ] && continue
    breached=$(cast call --json --rpc-url "$RPC" "$LEASH" "$MANDATE" "$id" | jq -r '.[0][13]') || return 1
    [ "$breached" = false ] || echo "    epoch $e breached: bond slashed, mandate stopped"
  done
  [ "$breached" = true ] && echo "    breached: nothing more to settle"
  ((settled >= ended)) && echo "    nothing to settle (settled $settled of $epochs, current epoch $ended)"
  return 0
}

log "keeper on chain $CHAIN, leash $LEASH, logs from block $FROM$([ "$DRY" = 1 ] && echo ', dry run')"
while true; do
  # An idle anvil mines no blocks, so its latest timestamp goes stale: mine one first, as a live chain would.
  [ "$CHAIN" = 31337 ] && [ "$DRY" = 0 ] && cast rpc evm_mine --rpc-url "$RPC" >/dev/null
  scan || log "log scan failed, retrying next round"
  log "round: ${#IDS[@]} mandate(s), logs scanned to $SCANNED"
  for ((i = 0; i < ${#IDS[@]}; i++)); do
    keep "${IDS[$i]}" "${KEYS[$i]}" || echo "    read failed, retrying next round"
  done
  [ "$ONCE" = 1 ] && break
  sleep "$INTERVAL"
done
