# Scripts: Local Chain and Keeper Loop

> **Two bash wrappers: `local.sh` starts a fresh anvil with everything deployed, `keeper.sh` checkpoints and settles every minute.**

These are the shell side of the Foundry scripts in [`../script/`](../script/README.md). `local.sh` runs `script/Local.s.sol` once on a new anvil chain and exports the ABI the frontend compiles in; `keeper.sh` runs `script/Settle.s.sol` in a loop. Both `cd` to the repo root first, so they can be started from anywhere. They need `anvil`, `cast` and `forge` (Foundry); `local.sh` also needs `jq`.

## Files

| File | Runs | Purpose | Writes |
|---|---|---|---|
| [`local.sh`](local.sh) | `anvil`, `script/Local.s.sol:Local` | Fresh local chain with v4, mock tokens, Leash and one live mandate | `deployments/31337.json`, `deployments/abi/Leash.json` |
| [`keeper.sh`](keeper.sh) | `script/Settle.s.sol:Settle`, every `INTERVAL` seconds | Calls `checkpoint` and settles ended epochs for the pool in `deployments/<chainId>.json` | nothing (forge's broadcast records only) |

## Folder Structure

```
scripts/
├── local.sh    # anvil at 127.0.0.1:8545, Local.s.sol, jq ABI export, then tails anvil's log until Ctrl-C
└── keeper.sh   # while true: (mine a block on anvil) -> forge script Settle.s.sol --broadcast -> sleep INTERVAL
```

## Variables

| Variable | Script | Default | Meaning |
|---|---|---|---|
| `RPC_URL` | `keeper.sh` | `http://127.0.0.1:8545` | A URL or a `foundry.toml` alias, e.g. `unichain_sepolia` |
| `INTERVAL` | `keeper.sh` | `60` | Seconds between rounds |
| `KEEPER_PRIVATE_KEY` | `keeper.sh` (read by `Settle.s.sol`) | anvil account #4 on chain 31337; required elsewhere | Signer; needs gas only, since `checkpoint` and `settle` are open to anyone |

`local.sh` takes no variables. Its RPC is fixed at `http://127.0.0.1:8545` and every key comes from anvil's public mnemonic. Names are listed in [`../.env.example`](../.env.example); forge reads `.env` from the repo root.

## The Local Stack

Three pieces, in three terminals:

```bash
./scripts/local.sh          # 1. chain: anvil + Uniswap v4 + Leash + a seeded mandate
./scripts/keeper.sh         # 2. keeper: checkpoint and settle every 60s
cd frontend && npm run dev  # 3. app: reads deployments/31337.json and deployments/abi/Leash.json
```

The app's "Local anvil" network (`frontend/src/app/chain.ts`, `NETS[31337]`) points at `http://127.0.0.1:8545` and the addresses in `deployments/31337.json`. With the chain running, `cd frontend && node --experimental-strip-types src/app/verify.ts` drives every write the app makes against it and checks the results on chain; it expects the seeded mandate still in its auction, so run it on a fresh `local.sh`. See [`../frontend/README.md`](../frontend/README.md).

Accounts (anvil's default mnemonic `test test test test test test test test test test test junk`):

| Index | Role |
|---|---|
| #0 | Treasury; deploys everything and posts the mandate |
| #1 | Manager, bid 1,000 mUSDC, outbid (bond claimable) |
| #2 | Manager, bid 1,500 mUSDC, leads the auction |
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
./scripts/keeper.sh                                   # local, every 60 s, signer anvil #4
INTERVAL=30 ./scripts/keeper.sh                       # shorter rounds
RPC_URL=unichain_sepolia ./scripts/keeper.sh          # testnet, signer KEEPER_PRIVATE_KEY from .env
```

Each round:

1. Prints `[HH:MM:SS] keeper run`.
2. **On chain 31337 only**, mines one block (`cast rpc evm_mine`). Forge simulates at the latest block's timestamp and sizes gas from that simulation. An idle anvil mines no blocks, so that timestamp goes stale; a `checkpoint` that then lands at the real time books more time than was simulated and runs out of gas. A live chain produces blocks on its own, so this is skipped there.
3. Runs `forge script script/Settle.s.sol:Settle --rpc-url "$RPC" --broadcast --slow`, and prints only the `== Logs ==` block, the `ONCHAIN EXECUTION COMPLETE` line and any error lines. What one round does is in [`../script/README.md`](../script/README.md#settlesol).
4. `|| true`: a failed round (an RPC hiccup, a gas estimate) does not stop the loop; the next round retries.
5. Sleeps `INTERVAL` seconds.

On Unichain Sepolia the round reads `deployments/1301.json`, which has no `pool` key today, so it logs `No pool in ...` and sends nothing. Add the mandate's `pool` object (same shape as in `31337.json`) to keep a testnet mandate.

## What the Keeper Is For

Leash judges a manager by time in compliance, and it only measures time when something calls into it. `checkpoint` and `settle` are public (`src/Leash.sol`, section "anyone"); nothing on chain calls them by itself. The keeper is that caller. It holds no privilege and no funds beyond gas: if it stops, anyone can run the same calls.

**Checkpoint cadence.** `_checkpoint` credits the seconds since the previous check (`lastCheck`) to the epochs they span, all in or all out of compliance. Compliant means the TWAP is inside the managed range (`inRange`), the position's liquidity is at or above `minLiquidity` (`deep`), and the stablecoin share of the inventory is within the glide path (`onPace`). Because the TWAP drifts between checks, an interval counts as in only if the mandate was compliant at **both** ends (`ok = okNow && m.lastOk`). Waiting out a bad stretch and checkpointing once the TWAP is back still books that stretch as out. The comment on `_checkpoint` puts the error at "at most one interval per change of state". Every swap and every manager action also checkpoints, but a quiet pool has neither, so the `checkpoint` docstring says "keepers call it every minute or so". That is the 60 s default here: the shorter the interval, the closer the booked in/out seconds are to the truth.

**The first round after the auction.** Swap fees the position earned before the manager's first epoch belong to the treasury. `beforeSwap` cannot unlock the PoolManager to collect them, so the first `checkpoint`, rebalance or settle after `auctionEnd` sweeps them into idle (`_sweep`). Fees from swaps between `auctionEnd` and that call also go to the treasury, underpaying the manager by `managerFeeBps` of them; per the `_sweep` comment, "a keeper calling checkpoint() at auctionEnd closes the gap". The same applies to epoch 0: `createMandate` sets `lastOk = true` so the first interval is judged by its end alone, and a checkpoint at `auctionEnd` makes that interval empty. `Settle.s.sol` therefore checkpoints whenever `!m.swept`.

**Settle cadence.** `settle(key, e)` judges a finished epoch: `clean` if `inSecs * 10000 >= uptimeBps * (inSecs + outSecs)`. A clean epoch credits the manager `managerFeeBps` of the fees collected and, on the last epoch, frees the bond to the manager. A dirty one slashes the whole bond to the treasury and marks the mandate breached. Epochs must be settled in order (`epoch == m.settled`), only after they end. Fees are booked when collected, so a late settle books some of epoch `e+1`'s fees to `e` (the `ponytail` note in `_settle`: "Settle promptly"). The keeper settles every ended epoch on the first round after it ends.

**Gas bound.** One checkpoint after a long quiet spell writes every epoch the gap spans (about 23k gas each), and `close()` settles every unsettled epoch (about 80k each). `MAX_EPOCHS = 104` keeps both under the 2^24 per-transaction gas cap (EIP-7825), per the comment above that constant. A keeper that runs every minute never gets near it.
