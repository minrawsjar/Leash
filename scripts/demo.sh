#!/usr/bin/env bash
# Narrated end-to-end Leash demo on a fresh local anvil (http://127.0.0.1:8545): post a mandate, auction,
# rebalance, the mispricing attack and why it fails, a clean epoch, a partial slash, close and claims.
# Every number printed is read back from the chain with cast. Deploy and "swap to tick X" run through
# script/Demo.s.sol; everything else is cast. Anvil's public dev keys only. Stops anvil on exit.
set -euo pipefail
cd "$(dirname "$0")/.."

RPC=http://127.0.0.1:8545
MN="test test test test test test test test test test test junk"
if cast chain-id --rpc-url $RPC >/dev/null 2>&1; then
  echo "Something is already listening on $RPC; stop it first (the demo needs a fresh chain)." >&2
  exit 1
fi
LOG=$(mktemp)
anvil >"$LOG" 2>&1 &
ANVIL=$!
trap 'kill $ANVIL 2>/dev/null; rm -f "$LOG" "$LOG.forge"' EXIT
until cast chain-id --rpc-url $RPC >/dev/null 2>&1; do
  kill -0 $ANVIL 2>/dev/null || { cat "$LOG"; exit 1; }
  sleep 0.2
done

# ---------------------------------------------------------------- helpers
for i in 0 1 2 3 4; do
  eval "PK$i=$(cast wallet private-key --mnemonic "$MN" --mnemonic-index $i)"
  eval "A$i=\$(cast wallet address --private-key \$PK$i)"
done
step() { echo; echo "[$1] $2"; }
say() { echo "    $*"; }
num() { awk '{print $1}'; } # cast prints "123 [1.23e2]"
call() { cast call --rpc-url $RPC "$@" | num; }
send() { # send <key> <to> <sig> args...: prints the tx hash, fails on a revert
  local k=$1; shift
  local r; r=$(cast send --rpc-url $RPC --private-key "$k" --json "$@")
  [ "$(jq -r .status <<<"$r")" = "0x1" ] || { echo "tx reverted: $*" >&2; exit 1; }
  jq -r .transactionHash <<<"$r"
}
now() { cast block latest -f timestamp --rpc-url $RPC; }
warp() { cast rpc evm_increaseTime "$1" --rpc-url $RPC >/dev/null; cast rpc evm_mine --rpc-url $RPC >/dev/null; }
big() { echo "$1" | BC_LINE_LENGTH=0 bc ${2:-}; } # 256-bit-safe arithmetic (bash ints are 64-bit)
floor60() { local t=$1 q=$(($1 / 60)); if [ $((t % 60)) -lt 0 ]; then q=$((q - 1)); fi; echo $((q * 60)); }
# expect_revert <Error> <from> <to> <sig> args...: the call must revert with that custom error
expect_revert() {
  local err=$1 from=$2; shift 2
  local sel out; sel=$(cast sig "$err()")
  if out=$(cast call --rpc-url $RPC --from "$from" "$@" 2>&1); then echo "expected $err, call succeeded" >&2; exit 1; fi
  grep -q "${sel#0x}" <<<"$out" || { echo "expected $err ($sel), got: $out" >&2; exit 1; }
  say "REVERTED $err() ($sel)"
}
fmt() { # fmt <amount> <token address>
  if [ "$(tr A-F a-f <<<"$2")" = "$(tr A-F a-f <<<"$USDC")" ]; then cast format-units "$1" 6; else cast format-units "$1" 18; fi
}
# forge_demo <calldata>: runs script/Demo.s.sol with that call, broadcast. Forge estimates gas in a simulation
# that can land in the same second as the last swap and skip the oracle write the mined tx makes: hence 3x.
forge_demo() {
  forge script script/Demo.s.sol:Demo --rpc-url $RPC --broadcast --slow --gas-estimate-multiplier 300 --sig "$1" >"$LOG.forge" 2>&1 \
    || { cat "$LOG.forge"; exit 1; }
}

# ---------------------------------------------------------------- 0. deploy
step 0 "Fresh anvil: Uniswap v4 PoolManager, swap router, TKN (18 dec) and mUSDC (6 dec), Leash hook (mined address)"
forge_demo "deploy()"
addr() { grep "ADDR $1 " "$LOG.forge" | awk '{print $3}'; }
ROUTER=$(addr router); LEASH=$(addr leash); TKN=$(addr tkn); USDC=$(addr usdc); PM=$(addr pm)
if [[ "$(tr A-F a-f <<<"$USDC")" < "$(tr A-F a-f <<<"$TKN")" ]]; then C0=$USDC C1=$TKN S0=mUSDC S1=TKN; else C0=$TKN C1=$USDC S0=TKN S1=mUSDC; fi
KEY="($C0,$C1,8388608,60,$LEASH)"
KT="(address,address,uint24,int24,address)"
ID=$(cast keccak "$(cast abi-encode "f$KT" "$C0" "$C1" 8388608 60 "$LEASH")")
SLOT0=$(cast keccak "$(cast abi-encode "f(bytes32,uint256)" "$ID" 6)") # PoolManager pools mapping, slot 6
say "Leash hook  $LEASH (low bits 0x$(printf %04x $((16#${LEASH: -4} & 0x3FFF))) = beforeInitialize|beforeAddLiquidity|beforeSwap)"
say "PoolManager $PM   router $ROUTER"
say "pool        $S0/$S1, dynamic fee, tick spacing 60, id $ID"
say "accounts    #0 treasury $A0, #1 manager $A1, #2 manager $A2, #3 trader $A3, #4 keeper $A4"

MSIG="mandate(bytes32)(address,address,uint256,uint256,uint256,uint256,uint256,int24,int24,uint128,uint40,uint16,bool,bool,bool,bool,uint40,uint40,bool,uint24,uint40,uint32,uint16,uint256,uint32,uint24,uint128,uint16,uint16,uint16,uint16,uint24,uint24,uint128)"
mandate() { M=($(call "$LEASH" "$MSIG" "$ID")); } # M[0] treasury .. M[18] terms.stableIs0 .. M[33] anchorLiquidity
spot() { local w; w=$(cast call --rpc-url $RPC "$PM" "extsload(bytes32)(bytes32)" "$SLOT0"); local v=$((16#${w:20:6})); [ $v -ge 8388608 ] && v=$((v - 16777216)); echo $v; }
twap() { call "$LEASH" "twapTick($KT)(int24)" "$KEY"; }
owed() { call "$LEASH" "owed(address,address)(uint256)" "$1" "$2"; }
bal() { call "$1" "balanceOf(address)(uint256)" "$2"; }
epoch() { E=($(call "$LEASH" "epochRecord(bytes32,uint256)(uint32,uint32,uint128,uint128,bool,bool)" "$ID" "$1")); } # in out fees0 fees1 settled clean
comp() { C=($(call "$LEASH" "compliance($KT)(bool,bool,bool,uint16)" "$KEY")); echo "inRange=${C[0]} deep=${C[1]} onPace=${C[2]} stable=$((C[3] / 100)).$(printf %02d $((C[3] % 100)))%"; }
keeper() { send "$PK4" "$LEASH" "checkpoint($KT)" "$KEY" >/dev/null; }
swapto() { # swapto <account> <tick>: prints the Swap event's tick and fee
  forge_demo "$(cast calldata "swapTo(address,$KT,uint32,int24)" "$ROUTER" "$KEY" "$1" "$2")"
  local tx; tx=$(cast block latest --json --rpc-url $RPC | jq -r '.transactions[-1]')
  swapfee "$tx"
}
SWAP_TOPIC=$(cast keccak "Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)")
swapfee() { # swapfee <tx>: SWAP_TICK and SWAP_FEE (pips) from the PoolManager's Swap event
  local data; data=$(cast receipt "$1" --json --rpc-url $RPC | jq -r --arg t "$SWAP_TOPIC" '.logs[] | select(.topics[0] == $t) | .data')
  local d; d=($(cast decode-abi "f()(int128,int128,uint160,uint128,int24,uint24)" "$data" | num))
  SWAP_TICK=${d[4]}; SWAP_FEE=${d[5]}
}
signed() { case $1 in -*) echo "-$(cast format-units "${1#-}" $2)";; *) echo "+$(cast format-units "$1" $2)";; esac; }
pips() { echo "$1 pips ($(($1 / 10000)).$(printf %02d $(($1 % 10000 / 100)))%)"; } # 1 pip = 0.0001%

# ---------------------------------------------------------------- 1. post a mandate
step 1 "Treasury #0 posts a mandate: deposits inventory into a pool only the hook can touch"
say "first try, minBond 4,000 mUSDC (1% of the deposit), rehearsed against the chain:"
say "REVERTED ThinBond() ($(cast sig "ThinBond()")): $(grep THINBOND "$LOG.forge" | sed 's/^ *THINBOND //')"
say "second try, minBond 10,000 mUSDC (2.5%, over the 2% floor): accepted"
mandate
say "deposit     $(cast format-units "$(big "10^24 - $(bal $TKN $A0)")" 18) TKN + $(cast format-units "$(big "10^12 - $(bal $USDC $A0)")" 6) mUSDC (out of the treasury's 1,000,000 of each)"
say "terms       fee $(pips ${M[31]}) .. $(pips ${M[19]}), ${M[22]} epochs x $((M[21] / 60)) min, minBond $(fmt ${M[23]} $USDC) mUSDC"
say "            uptime ${M[27]} bps, manager share ${M[28]} bps of LP fees, TWAP window ${M[24]} s"
say "            rebalance only within ${M[25]} ticks of TWAP, range must cover TWAP +- ${M[32]}, stablecoin glide ${M[29]} -> ${M[30]} bps"
say "position    [${M[7]}, ${M[8]}) liquidity ${M[9]}, plus full-range anchor ${M[33]} (min ${M[26]})"
say "auction     ends at $(date -r ${M[20]} +%H:%M:%S) ($((M[20] - $(now))) s from now)"

# ---------------------------------------------------------------- 2. auction
step 2 "Two managers bid bonds for the right to run it"
send "$PK1" "$LEASH" "bid($KT,uint256)" "$KEY" 10000000000 >/dev/null
say "#1 bids 10,000 mUSDC"
send "$PK2" "$LEASH" "bid($KT,uint256)" "$KEY" 12000000000 >/dev/null
say "#2 bids 12,000 mUSDC"
expect_revert LowBid "$A1" "$LEASH" "bid($KT,uint256)" "$KEY" 11000000000
say "   (#1 tries 11,000: not above the lead)"
mandate
say "leader      ${M[1]} (#2), bond $(fmt ${M[2]} $USDC) mUSDC held by the hook"
say "owed(#1)    $(fmt $(owed $A1 $USDC) $USDC) mUSDC: the outbid bond is claimable now"

# ---------------------------------------------------------------- 3. auction ends, manager rebalances
step 3 "Auction ends; keeper #4 checkpoints; manager #2 sets its fee and re-ranges"
warp $((M[20] - $(now) + 1))
keeper
send "$PK2" "$LEASH" "setFee($KT,uint24)" "$KEY" 3000 >/dev/null
say "setFee(3000): $(pips 3000) (the terms allow $(pips ${M[31]}) .. $(pips ${M[19]}))"
TW=$(twap); B=$(floor60 "$TW"); LIQ=${M[9]}
send "$PK2" "$LEASH" "rebalance($KT,int24,int24,uint128)" "$KEY" $((B - 360)) $((B + 420)) "$LIQ" >/dev/null
mandate
say "rebalance   [${M[7]}, ${M[8]}) liquidity ${M[9]} around TWAP $TW (spot $(spot)); a narrower range, same depth"
say "idle        $(fmt ${M[3]} $C0) $S0 + $(fmt ${M[4]} $C1) $S1 back in the hook"
say "compliance  $(comp)"

# ---------------------------------------------------------------- 4. the attack
step 4 "THE ATTACK: the manager pushes the price off fair value, re-ranges at the fake price, trades back"
TW=$(twap)
swapto 2 $((TW - 150))
say "4a #2 sells into the pool: spot $(spot), TWAP $(twap) (it lags, ${M[24]} s window, truncated at 50 ticks/s)"
say "   that swap paid $(pips $SWAP_FEE): spot started at the TWAP, so just the set fee"
SP=$(spot); B=$(floor60 "$SP")
say "4b #2 re-ranges around the fake price, [$((B - 360)), $((B + 420))):"
expect_revert SpotOffTwap "$A2" "$LEASH" "rebalance($KT,int24,int24,uint128)" "$KEY" $((B - 360)) $((B + 420)) "$LIQ"
say "   |spot - TWAP| = $(($(twap) - SP)) > maxTickDeviation ${M[25]}"
GAP=$(($(twap) - $(spot)))
swapto 2 $(($(spot) - 100))
say "4c #2 pushes 100 ticks further while spot is $GAP ticks off the TWAP: fee charged $(pips $SWAP_FEE)"
say "   = set fee 3000 + 10 pips x ($(((SWAP_FEE - 3000) / 10 + 10)) - 10) ticks off the TWAP at that block, beyond the 10-tick free band (cap: maxFee)"
say "   the price is the manager's own: pushing it off fair value pays the treasury more on every swap"
GAP=$(($(twap) - $(spot)))
swapto 3 "$(twap)"
say "4d trader #3 arbitrages back to the TWAP from $GAP ticks off: fee $(pips $SWAP_FEE), under the ~$((GAP / 100)).$(printf %02d $((GAP % 100)))% mispricing it closes"
warp 150; keeper
say "   150 s later: spot $(spot), TWAP $(twap)"
say "4e same block: #2 nudges the price, then grows the position 4% behind the nudge (one block, automine off)"
mandate; TW=$(twap); B=$(floor60 "$TW")
cast rpc evm_setAutomine false --rpc-url $RPC >/dev/null
N=$(cast nonce "$A2" --rpc-url $RPC)
[ "$(tr A-F a-f <<<"$C0")" = "$(tr A-F a-f <<<"$USDC")" ] && AMT=2000000000 || AMT=2000000000000000000000
TXA=$(cast send --rpc-url $RPC --private-key "$PK2" --async --nonce "$N" --gas-limit 1000000 "$ROUTER" \
  "swap($KT,(bool,int256,uint160),(bool,bool),bytes)" "$KEY" "(true,-$AMT,4295128740)" "(false,false)" 0x)
TXB=$(cast send --rpc-url $RPC --private-key "$PK2" --async --nonce $((N + 1)) --gas-limit 2000000 "$LEASH" \
  "rebalance($KT,int24,int24,uint128)" "$KEY" "${M[7]}" "${M[8]}" "$(big "${M[9]} * 104 / 100")")
cast rpc evm_mine --rpc-url $RPC >/dev/null
cast rpc evm_setAutomine true --rpc-url $RPC >/dev/null
RA=$(cast receipt "$TXA" --json --rpc-url $RPC); RB=$(cast receipt "$TXB" --json --rpc-url $RPC)
[ "$(jq -r .blockNumber <<<"$RA")" = "$(jq -r .blockNumber <<<"$RB")" ] || { echo "not one block" >&2; exit 1; }
[ "$(jq -r .status <<<"$RA")" = 0x1 ] && [ "$(jq -r .status <<<"$RB")" = 0x0 ] || { echo "unexpected statuses" >&2; exit 1; }
OUT=$(cast rpc debug_traceTransaction "$TXB" '{"tracer":"callTracer"}' --rpc-url $RPC | jq -r .output)
[ "$OUT" = "$(cast sig "SameBlock()")" ] || { echo "expected SameBlock, got $OUT" >&2; exit 1; }
say "   block $(($(jq -r .blockNumber <<<"$RA"))): nudge mined (status 1), grow REVERTED on chain with SameBlock() ($OUT)"
mandate
say "   position unchanged: [${M[7]}, ${M[8]}) liquidity ${M[9]}. The sandwich has no leg to stand on."

# ---------------------------------------------------------------- 5. clean epoch
step 5 "Epoch 0 ends clean; the keeper settles it"
mandate; END0=$((M[20] + M[21]))
while [ $(($(now) + 600)) -lt $END0 ]; do warp 600; keeper; done
warp $((END0 - $(now) + 1))
send "$PK4" "$LEASH" "settle($KT,uint256)" "$KEY" 0 >/dev/null
epoch 0
say "epoch 0     in ${E[0]} s, out ${E[1]} s, clean=${E[5]}; LP fees $(fmt ${E[2]} $C0) $S0 + $(fmt ${E[3]} $C1) $S1"
say "manager #2  owed $(fmt $(owed $A2 $C0) $C0) $S0 + $(fmt $(owed $A2 $C1) $C1) $S1 (30% of the epoch's fees)"
say "keeper #4   owed $(fmt $(owed $A4 $C0) $C0) $S0 + $(fmt $(owed $A4 $C1) $C1) $S1 (bounty: 10 bps of the treasury's 70%)"
say "treasury    keeps the rest as inventory"

# ---------------------------------------------------------------- 6. breach
step 6 "Epoch 1: the market drops 1,000 ticks and manager #2 is asleep"
mandate; BOND=${M[2]}
swapto 3 $(($(twap) - 1000))
say "trader #3 sells: spot $(spot), range [${M[7]}, ${M[8]}) (fee on that swap $(pips $SWAP_FEE))"
for i in $(seq 1 30); do
  warp 30; keeper; epoch 1
  say "  +$((i * 30))s  TWAP $(twap)  $(comp)  out so far ${E[1]} s"
  if [ "${E[1]}" -ge 240 ] && [ $(($(twap) - $(spot))) -le 100 ] && [ $(($(spot) - $(twap))) -le 100 ]; then break; fi
  [ $i -lt 30 ] || { echo "out time never reached 240 s" >&2; exit 1; }
done
TW=$(twap); B=$(floor60 "$TW")
send "$PK2" "$LEASH" "rebalance($KT,int24,int24,uint128)" "$KEY" $((B - 360)) $((B + 420)) "${M[9]}" >/dev/null
say "#2 wakes up and re-ranges to [$((B - 360)), $((B + 420))) around TWAP $TW: $(comp)"
mandate; END1=$((M[20] + 2 * M[21]))
while [ $(($(now) + 600)) -lt $END1 ]; do warp 600; keeper; done
warp $((END1 - $(now) + 1))
send "$PK4" "$LEASH" "settle($KT,uint256)" "$KEY" 1 >/dev/null
epoch 1; mandate
TOT=$((E[0] + E[1])); ALLOW=$(((10000 - M[27]) * TOT / 10000))
say "epoch 1     in ${E[0]} s, out ${E[1]} s, clean=${E[5]}; allowance $ALLOW s (5%), fired at $((2 * ALLOW)) s"
say "slash       bond $(fmt $BOND $USDC) -> $(fmt ${M[2]} $USDC) mUSDC: $(fmt $((BOND - M[2])) $USDC) to the treasury"
say "            = bond x (out - allowance) / allowance = $(((E[1] - ALLOW) * 100 / ALLOW))% ; breached (fired) = ${M[13]}"
say "owed(#0)    $(fmt $(owed $A0 $USDC) $USDC) mUSDC"

# ---------------------------------------------------------------- 7. close and claim
step 7 "Epoch 2 runs clean; the treasury closes and everyone claims"
END2=$((M[20] + 3 * M[21]))
while [ $(($(now) + 600)) -lt $END2 ]; do warp 600; keeper; done
warp $((END2 - $(now) + 1))
send "$PK0" "$LEASH" "close($KT)" "$KEY" >/dev/null
epoch 2; mandate
say "close()     settles epoch 2 (in ${E[0]} s, out ${E[1]} s, clean=${E[5]}), pulls both positions, returns all inventory; closed=${M[14]}"
say "records(#2) $(call "$LEASH" "records(address)(uint32,uint32)" "$A2" | tr '\n' ' ')(clean, missed)"
for who in 0 1 2 4; do
  for c in $C0 $C1; do
    eval "a=\$A$who k=\$PK$who"
    [ "$(owed $a $c)" = 0 ] || send "$k" "$LEASH" "claim(address)" "$c" >/dev/null
  done
done
say "claims sent; hook balance left: $(fmt $(bal $TKN $LEASH) $TKN) TKN, $(fmt $(bal $USDC $LEASH) $USDC) mUSDC"
echo
FINAL=$(spot)
# mUSDC per TKN at the final spot: 1.0001^tick scaled by the 18 vs 6 decimals, inverted if mUSDC is currency0
if [ "$C0" = "$TKN" ]; then PX=$(big "scale=40; e($FINAL * l(1.0001)) * 10^12" -l); else PX=$(big "scale=40; 10^12 / e($FINAL * l(1.0001))" -l); fi
say "final spot tick $FINAL: 1 TKN = $(printf %.4f "$PX") mUSDC"
printf "    %-12s %26s %16s %18s\n" "account" "TKN change" "mUSDC change" "net, in mUSDC"
for who in 0 1 2 3 4; do
  case $who in 0) r="#0 treasury";; 1) r="#1 manager";; 2) r="#2 manager";; 3) r="#3 trader";; 4) r="#4 keeper";; esac
  eval "a=\$A$who"
  if [ $who = 4 ]; then t0=0 u0=0; else t0="10^24" u0="10^12"; fi # minted 1,000,000 of each to #0-#3
  dt=$(big "$(bal $TKN $a) - $t0"); du=$(big "$(bal $USDC $a) - $u0")
  printf "    %-12s %26s %16s %+18.2f\n" "$r" "$(signed "$dt" 18)" "$(signed "$du" 6)" "$(big "scale=6; $dt * $PX / 10^18 + $du / 10^6" -l)"
done
say "(change against the 1,000,000 TKN + 1,000,000 mUSDC each of #0-#3 was minted; #4 started with none)"
say "(net marks every row at the final price; #2 sold TKN in the attack before the 10% drop, so its row is not just slash plus pay)"
echo
echo "Demo complete."
