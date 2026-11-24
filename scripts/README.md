# Scripts: Local Chain and Keeper Loop

> **Two bash wrappers: `local.sh` starts a fresh anvil with everything deployed, `keeper.sh` checkpoints and settles every mandate every minute.**

These are the shell side of the Foundry scripts in [`../script/`](../script/README.md). `local.sh` runs `script/Local.s.sol` once on a new anvil chain and exports the ABI the frontend compiles in; `keeper.sh` finds every mandate from the hook's logs and keeps each one with `cast`. Both `cd` to the repo root first, so they can be started from anywhere. They need `anvil`, `cast` and `forge` (Foundry) and `jq`.

## Files

| File | Runs | Purpose | Writes |
|---|---|---|---|
| [`local.sh`](local.sh) | `anvil`, `script/Local.s.sol:Local` | Fresh local chain with v4, mock tokens, Leash and one live mandate | `deployments/31337.json`, `deployments/abi/Leash.json` |
| [`keeper.sh`](keeper.sh) | `cast logs`, `cast call`, `cast send`, every `INTERVAL` seconds | Finds every mandate from `MandateCreated` logs, calls `checkpoint` and settles ended epochs for each live one | nothing |

## Folder Structure

```
scripts/
├── local.sh    # anvil at 127.0.0.1:8545, Local.s.sol, jq ABI export, then tails anvil's log until Ctrl-C
└── keeper.sh   # while true: (mine a block on anvil) -> scan new MandateCreated logs -> checkpoint/settle each -> sleep INTERVAL
```

## Variables

| Variable | Script | Default | Meaning |
|---|---|---|---|
| `RPC_URL` | `keeper.sh` | `https://unichain-sepolia-rpc.publicnode.com` | A URL or a `foundry.toml` alias; `http://127.0.0.1:8545` for the local chain |
| `INTERVAL` | `keeper.sh` | `60` | Seconds between rounds |
| `PRIVATE_KEY` | `keeper.sh` | `KEEPER_PRIVATE_KEY` if set, else anvil account #4 on chain 31337; required elsewhere unless `--dry-run` | Signer; needs gas only, since `checkpoint` and `settle` are open to anyone. Never printed |
| `CHUNK` | `keeper.sh` | `1000` | Blocks per `eth_getLogs` call. `sepolia.unichain.org` caps ranges at 1,000; drpc's free tier at 100 |
| `LOG_RPCS` | `keeper.sh` | `RPC_URL`, plus publicnode and `sepolia.unichain.org` on chain 1301 | RPCs tried in turn for each log chunk |

`local.sh` takes no variables. Its RPC is fixed at `http://127.0.0.1:8545` and every key comes from anvil's public mnemonic. Names are listed in [`../.env.example`](../.env.example); forge reads `.env` from the repo root.

## The Local Stack

Three pieces, in three terminals:

```bash
./scripts/local.sh          # 1. chain: anvil + Uniswap v4 + Leash + a seeded mandate
RPC_URL=http://127.0.0.1:8545 ./scripts/keeper.sh   # 2. keeper: checkpoint and settle every 60s
cd frontend && npm run dev  # 3. app: reads deployments/31337.json and deployments/abi/Leash.json
```

The app's "Local anvil" network (`frontend/src/app/chain.ts`, `NETS[31337]`) points at `http://127.0.0.1:8545` and the addresses in `deployments/31337.json`. With the chain running, `cd frontend && node --experimental-strip-types src/app/verify.ts` drives every write the app makes against it and checks the results on chain; it expects the seeded mandate still in its auction, so run it on a fresh `local.sh`. See [`../frontend/README.md`](../frontend/README.md).

Accounts (anvil's default mnemonic `test test test test test test test test test test test junk`):

| Index | Role |
|---|---|
| #0 | Treasury; deploys everything and posts the mandate |
| #1 | Manager, bid 10,000 mUSDC, outbid (bond claimable) |
| #2 | Manager, bid 12,000 mUSDC, leads the auction |
| #3 | Swapper; made three small trades |
| #4 | Keeper (`keeper.sh` default signer) |

Timeline of the seeded mandate: the auction closes 10 minutes after deploy, then three 1-hour epochs. Skip ahead on anvil with:

```bash
cast rpc evm_increaseTime 600 --rpc-url http://127.0.0.1:8545 && cast rpc evm_mine --rpc-url http://127.0.0.1:8545
```

### local.sh

1. **Refuses a busy port.** If `cast chain-id --rpc-url http://127.0.0.1:8545` answers, it prints `Something is already listening on ...` and exits 1. `Local.s.sol` needs a fresh chain: its addresses in `31337.json` are the deterministic nonce-0 addresses of account #0.
2. **Starts anvil** in the background with its output going to a temp file, and sets an `EXIT` trap that kills background jobs and removes the log. It polls `cast chain-id` every 0.2 s until anvil answers; if anvil dies first, it prints the log and exits.
3. **Spaces block timestamps** with `cast rpc anvil_setBlockTimestampInterval 1`. Anvil would otherwise stamp a burst of blocks with the same second, and Leash's oracle keeps one observation per second, so the swapper's three trades would collapse into one observation.
4. **Deploys** with `forge script script/Local.s.sol:Local --rpc-url http://127.0.0.1:8545 --broadcast --slow`. `--slow` sends each transaction after the previous one is mined. This writes `deployments/31337.json` (contents in [`../script/README.md`](../script/README.md#localsol)).
5. **Restores normal timestamps** with `cast rpc anvil_removeBlockTimestampInterval`.
6. **Exports the ABI**: `jq .abi out/Leash.sol/Leash.json > deployments/abi/Leash.json`. The forge run in step 4 has just compiled, so this is the ABI of the code now on the chain.
7. **Prints a summary** (RPC, files, accounts, timeline, the skip-ahead command) and tails anvil's log until Ctrl-C, which stops anvil through the trap.

Local runs are throwaway: forge's records under `broadcast/Local.s.sol/31337/` are gitignored. `deployments/31337.json` is committed, and a fresh `local.sh` reproduces the same addresses, so the file only changes when `Local.s.sol` or Leash's bytecode changes (Leash's address depends on its init code through CREATE2).

### keeper.sh

```bash
./scripts/keeper.sh --dry-run --once                  # testnet, read-only: print what one round would send
PRIVATE_KEY=0x... ./scripts/keeper.sh                 # testnet, every 60 s
RPC_URL=http://127.0.0.1:8545 ./scripts/keeper.sh     # local, signer anvil #4
INTERVAL=30 ./scripts/keeper.sh --once                # one round, then exit
```

`--dry-run` makes no `cast send` and needs no key; it prints each call as `would send: cast send <leash> "<sig>" <args>`. In a dry run every ended epoch is listed, since a breach can't be known without sending the earlier settle. `--once` exits after one round.

On start it reads the chain id from the RPC, then `leash` and `block` from `deployments/<chainId>.json`. Each round:

1. **On chain 31337 only** (and not in a dry run), mines one block (`cast rpc evm_mine`): an idle anvil's latest timestamp goes stale, and the keeper reads the time from it.
2. **Scans for new mandates.** `cast logs` for `MandateCreated(bytes32,address,(address,address,uint24,int24,address),uint256,uint256)` at the Leash address, from the deploy block (later rounds: from the last block scanned) to the head, in `CHUNK`-block pieces. Each piece tries every RPC in `LOG_RPCS`, twice over. Public RPCs refuse wide ranges, and publicnode answers some ranges with `pruned history unavailable` while `sepolia.unichain.org` serves them. A piece no RPC answers ends the scan for this round; the next round resumes there. The log's data is the `PoolKey` (5 static words) and the two amounts, so the key is sliced straight out of it (its hash is the indexed pool id, `topics[1]`).
3. **Keeps each mandate**, with the rules of `Settle.keep()` (see [`../script/README.md`](../script/README.md#settlesol)), reading state with `cast call`:
   - `mandate(bytes32)`: skip if closed (or unknown); skip while `latest block time < terms.auctionEnd`.
   - `checkpoint(PoolKey)` if the pre-mandate fees are not swept yet, or there is a manager, no breach and `lastCheck` is before the mandate's end.
   - No manager: stop. Otherwise `currentEpoch(PoolKey)` capped at `terms.epochs` is the count of ended epochs, and `settle(PoolKey,uint256)` is sent for `e = settled, settled + 1, ...`, re-reading `breached` after each.
4. A failed read or send is printed and retried next round; it does not stop the loop. Sleeps `INTERVAL` seconds.

`cast send` waits for each receipt, so settles go out in order. The key reaches `cast` as `--private-key`, which other local users can see in the process list; run it on a machine you trust. `script/Settle.s.sol` is the older one-pool version of the same round, kept for `test/Settle.t.sol` and for a deployments file with a `pool` key (`31337.json`).

Dry run against Unichain Sepolia (one mandate so far, already closed):

```
[23:29:27] keeper on chain 1301, leash 0xbB07E2C8C163063C602A2D00ddc97d5FacE76880, logs from block 68691824, dry run
[23:29:33] found mandate 0x137826902a9552c220d2ebfb7c7d7d615c127a5d7087fda73794a6a5992964b6 (0x2E8D07593389DDB1d84421D41e1d5fe120DCd99C,0xd010B2D159a9F43Ce22CDD038c7CC6BfBb2aaE3E,8388608,60,0xbB07E2C8C163063C602A2D00ddc97d5FacE76880)
[23:29:40] round: 1 mandate(s), logs scanned to 68690740
  0x137826902a9552c220d2ebfb7c7d7d615c127a5d7087fda73794a6a5992964b6
    closed: skip
```

## What the Keeper Is For

Leash judges a manager by time in compliance, and it only measures time when something calls into it. `checkpoint` and `settle` are public (`src/Leash.sol`, section "anyone"); nothing on chain calls them by itself. The keeper is that caller. It holds no privilege and no funds beyond gas: if it stops, anyone can run the same calls.

**Checkpoint cadence.** `_checkpoint` credits the seconds since the previous check (`lastCheck`) to the epochs they span, all in or all out of compliance. Compliant means the TWAP is inside the managed range (`inRange`), the position's liquidity is at or above `minLiquidity` (`deep`), and the stablecoin share of the inventory is within the glide path (`onPace`). Because the TWAP drifts between checks, an interval counts as in only if the mandate was compliant at **both** ends (`ok = okNow && m.lastOk`). Waiting out a bad stretch and checkpointing once the TWAP is back still books that stretch as out. The comment on `_checkpoint` puts the error at "at most one interval per change of state". Every swap and every manager action also checkpoints, but a quiet pool has neither, so the `checkpoint` docstring says "keepers call it every minute or so". That is the 60 s default here: the shorter the interval, the closer the booked in/out seconds are to the truth.

**The first round after the auction.** Swap fees the position earned before the manager's first epoch belong to the treasury. `beforeSwap` cannot unlock the PoolManager to collect them, so the first `checkpoint`, rebalance or settle after `auctionEnd` sweeps them into idle (`_sweep`). Fees from swaps between `auctionEnd` and that call also go to the treasury, underpaying the manager by `managerFeeBps` of them; per the `_sweep` comment, "a keeper calling checkpoint() at auctionEnd closes the gap". The same applies to epoch 0: `createMandate` sets `lastOk = true` so the first interval is judged by its end alone, and a checkpoint at `auctionEnd` makes that interval empty. `keeper.sh` (like `Settle.s.sol`) therefore checkpoints whenever `!m.swept`.

**Settle cadence.** `settle(key, e)` judges a finished epoch: `clean` if `inSecs * 10000 >= uptimeBps * (inSecs + outSecs)`. A clean epoch credits the manager `managerFeeBps` of the fees collected and, on the last epoch, frees the bond to the manager. A dirty one slashes the whole bond to the treasury and marks the mandate breached. Epochs must be settled in order (`epoch == m.settled`), only after they end. Fees are booked when collected, so a late settle books some of epoch `e+1`'s fees to `e` (the `ponytail` note in `_settle`: "Settle promptly"). The keeper settles every ended epoch on the first round after it ends.

**Gas bound.** One checkpoint after a long quiet spell writes every epoch the gap spans (about 23k gas each), and `close()` settles every unsettled epoch (about 80k each). `MAX_EPOCHS = 104` keeps both under the 2^24 per-transaction gas cap (EIP-7825), per the comment above that constant. A keeper that runs every minute never gets near it.
