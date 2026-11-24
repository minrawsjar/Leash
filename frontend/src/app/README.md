# App: The Leash dApp at /app

> **React 19, TypeScript and viem, no backend. Deployed on Vercel at [leash-khaki.vercel.app/app](https://leash-khaki.vercel.app/app), reading Unichain Sepolia.**

Every Leash mandate on the hook, live, and every write a treasury, a manager or a keeper makes. A treasury posts a mandate from a term sheet (by hand or drafted by the AI assistant). Managers bid a first-loss bond in the auction. The winner rebalances and sets the fee from the manager console, with every guard the hook applies shown as a live check before signing. Anyone can checkpoint and settle; the treasury closes; everyone claims what they are owed. The app reads all of it from the chain over public RPC and signs through the browser wallet. The contract it talks to is documented in [../../../src/README.md](../../../src/README.md); its addresses are in [../../../deployments/README.md](../../../deployments/README.md). The project-level setup is in [../../README.md](../../README.md).

## Routes

The app is one page at `/app`. Everything after it is a hash route, read by `useHash` in [`App.tsx`](App.tsx), so routes never reach the server.

| Route | Screen | Who uses it |
|---|---|---|
| `#/` (or no hash) | **Explorer**: search, network stats, "Create your own mandate", latest mandates, latest activity, every mandate with filters | Everyone |
| `#/create` | **Post a mandate**: the AI assistant panel, then the term sheet in five sections, beside a sticky review with the exact call | Treasury |
| `#/create/ai` | The same screen, with focus moved to the assistant's text box | Treasury, from the explorer's "Draft it with AI" |
| `#/m/<poolId>` | A mandate's **Dashboard** (the default tab) | Everyone |
| `#/m/<poolId>/dashboard` | Stats, live chart, compliance and glide bar, ledger, epochs, activity, terms | Everyone |
| `#/m/<poolId>/auction` | Leading bond, the bid form while open (or the result), bid history, claimable refunds | Managers |
| `#/m/<poolId>/manage` | **Manager console**: range picker, size, every rebalance guard as a check, the fee | The hired manager |
| `#/m/<poolId>/settle` | **Settle and claim**: checkpoint, settle the next epoch, close, claim, track records | Keepers, treasury, everyone owed |

An unknown tab renders the dashboard. A pool id with no `MandateCreated` event on the chosen network says so ("No mandate with pool id … on Unichain Sepolia"). Changing the hash scrolls to the top.

The network comes from, in order: `?chain=<id>` in the URL, the last choice saved in `localStorage` under `leash.chain`, then the host (31337 on `localhost` or `127.*`, otherwise 1301). Choosing a network in the top bar saves it, drops `?chain` from the URL, and remounts `<main>` (`key={net.id}`) so no state leaks from one chain to the other.

## Networks

Both are defined in `NETS` in [`chain.ts`](chain.ts). Addresses come from the deployment files, imported at build time.

| Id | Name | RPC | Explorer | Deployment |
|---|---|---|---|---|
| `1301` | Unichain Sepolia | `VITE_UNICHAIN_RPC` if set, then `unichain-sepolia-rpc.publicnode.com`, `unichain-sepolia.drpc.org`, `sepolia.unichain.org`, as a viem `fallback` | [unichain-sepolia.blockscout.com](https://unichain-sepolia.blockscout.com) | `deployments/1301.json`: `leash`, `poolManager`, `block` (the hook's deploy block). plus `deployments/1301-tokens.json` merged in (`tkn`, `usdc`), so the create form opens with TKN and mUSDC filled in |
| `31337` | Local anvil | `http://127.0.0.1:8545` only | none (transaction links render as plain hashes) | `deployments/31337.json`, written by `./scripts/local.sh`: also `tkn`, `usdc`, `swapRouter`, the seeded pool and the dev accounts |

The wallet is asked to switch to the chosen network when it signs (`wallet_switchEthereumChain`), and to add it if it does not know it (`wallet_addEthereumChain`, error 4902). The top bar's account chip turns to a warning while the wallet sits on another chain.

## Where Every Number Comes From

`S` below is a mandate snapshot from `snapshot()` in [`chain.ts`](chain.ts): one call that reads, in parallel, `mandate(id)`, the latest block, slot0, `twapTick(key)`, `currentEpoch(key)`, `compliance(key)` and both tokens' metadata. Floats derived from ticks are for display; the chain decides every check.

### Explorer (`#/`)

| On screen | Source |
|---|---|
| Mandates posted | Count of `MandateCreated` events from the hook |
| Live now | Mandates whose status (below) is `auction` or `active` |
| Bonds at stake | Sum of `mandate(id).bond` over mandates with a manager that are not closed, grouped by stablecoin symbol |
| Managers hired | Distinct non-zero `mandate(id).manager` |
| Hook events | Count of every Leash event since the deploy block |
| Latest block | The block number `getBlock()` returned with the newest mandate's snapshot |
| Latest mandates (6) | Newest `MandateCreated` events; the stablecoin deposit is the event's `amount0` or `amount1`; the age is that block's timestamp (`getBlock`, cached) against chain time |
| Latest activity (8) | The newest Leash events of any kind, in words by `describe()` |
| Each row: pair, spacing | `MandateCreated.key` and each token's `symbol` |
| Each row: status pill | `statusOf()`: `closed` and `breached` flags from `mandate(id)`, then chain time against `terms.auctionEnd`, then whether `manager` is zero, then chain time against `auctionEnd + epochLength × epochs` |
| Each row: bond | `mandate(id).bond` (a dash before anyone bids) |
| Each row: "Bidding closes" / epoch | `terms.auctionEnd` against chain time; `currentEpoch(key)`; `mandate(id).settled` |
| Each row: three dots | `compliance(key)`: in range, deep enough, on pace (grey when the mandate is not live) |
| Each row: ends | `auctionEnd + epochLength × epochs` against chain time |

### Dashboard (`#/m/<id>`)

| On screen | Source |
|---|---|
| Spot | slot0's `sqrtPriceX96`, read from PoolManager storage with `extsload` (the `pools` mapping at slot 6), squared and scaled by the two tokens' decimals. Not the tick: the tick is floored and would show 2 as 1.9998 |
| TWAP | `twapTick(key)`, converted to stablecoin per token |
| Bond at stake | `mandate(id).bond` |
| Swap fee, and its band | slot0's `lpFee`; `terms.minFee` and `terms.maxFee` |
| Countdown | `terms.auctionEnd`, or the end of epoch `currentEpoch + 1`, against chain time; after the mandate, `mandate(id).settled` of `terms.epochs` |
| Chart | Spot tick, TWAP tick and the manager's `tickLower`/`tickUpper`, one sample per new block; backfilled once from 40 past blocks by reading slot0, `twapTick` and `mandate` at each `blockNumber`. The "must cover" band is TWAP ± `terms.minHalfWidth` |
| Compliance now: in range, depth, pace | `compliance(key)`: `inRange`, `deep`, `onPace`, `stableBps` |
| Depth multiple | `mandate(id).liquidity / terms.minLiquidity` |
| Glide cap | `glideAt()`: the same straight line `Leash._glide` computes from `startStableBps` to `endStableBps` over the mandate |
| Fee check | slot0's `lpFee` inside `terms.minFee … terms.maxFee` |
| Compliance booked up to | `mandate(id).lastCheck` and `lastOk` |
| Ledger: idle | `mandate(id).idle0`, `idle1` |
| Ledger: managed position, anchor | Token amounts of `mandate(id).liquidity` over `[tickLower, tickUpper)` and of `terms.anchorLiquidity` over the full range, at the TWAP tick (`amountsAt`) |
| Ledger: fees collected, unsettled | `mandate(id).fees0`, `fees1` |
| Ledger: inventory value | Idle + position + anchor, valued at the TWAP |
| Epochs | `epochRecord(id, e)` for every epoch: `inSecs`, `outSecs`, `fees0`, `fees1`, `settled`, `clean`; the uptime cut line at `terms.uptimeBps` |
| Activity | Leash events whose `id` is this pool, newest 30, ages from each block's timestamp |
| Terms | `mandate(id).terms`, fixed at creation |

### Auction (`#/m/<id>/auction`)

| On screen | Source |
|---|---|
| Leading or winning bond, and by whom | `mandate(id).bond` and `manager` |
| Their track record | `records(manager)`: clean and breached epochs across every mandate |
| Bidding closes in | `terms.auctionEnd` against chain time |
| Minimum bond, next bid must exceed | `terms.minBond`; `bond + 1` once someone leads |
| Bid history | `Bid` events for this pool: `bidder`, `amount` |
| Who can claim what | `owed(bidder, stable)` for every bidder |
| Your claimable balance | `owed(you, stable)` |

`owed` is per account across every mandate on the hook, not per mandate, and the screen says so.

### Manager console (`#/m/<id>/manage`)

| On screen | Source |
|---|---|
| Spot, TWAP, current range on the picker | slot0 tick, `twapTick(key)`, `mandate(id).tickLower`/`tickUpper` |
| Spot–TWAP gap | `abs(spot tick − TWAP tick)` against `terms.maxTickDeviation` |
| Floor, growth cap | `terms.minLiquidity`; `liquidity × 1.05` (`GROW_BPS` = 500) |
| Next growth allowed in | `mandate(id).lastGrow + terms.twapWindow` against chain time |
| Fits the inventory | The current position's token amounts at spot plus `idle0`/`idle1`, against what the new range needs (a float estimate; the simulation is exact) |
| Last rebalance, last growth | `mandate(id).lastRebalance`, `lastGrow` |
| Fee now | slot0's `lpFee` |

### Settle and claim (`#/m/<id>/settle`)

| On screen | Source |
|---|---|
| Booked up to | `mandate(id).lastCheck` |
| Next epoch to settle and when | `mandate(id).settled`; `auctionEnd + (settled + 1) × epochLength` |
| So far in and out | `epochRecord(id, settled)` |
| When close opens | Nobody hired: `auctionEnd`. Hired: the mandate's end. Breached: now |
| Your claimable, per token | `owed(you, currency0)`, `owed(you, currency1)` |
| Your track record | `records(you)` |
| Manager's track record and claimable | `records(manager)`, `owed(manager, currency0/1)` |

### Post a mandate (`#/create`)

| On screen | Source |
|---|---|
| Token symbol and decimals under each address | `getCode` (to tell a contract from an empty address), then `symbol` and `decimals` |
| "Your wallet holds less than this" | `balanceOf(you)` on each token |
| "A mandate already exists … use tick spacing N" | `mandate(poolId(key))` for this key; if taken, the same for spacings 60, 10, 30, 100, 200, 1, 20, 50, 120 until one is free |
| Bidding closes | Chain time from `getBlock()` plus the auction length |
| Opening tick, stablecoin share, anchor share, every problem | `plan()` in [`plan.ts`](plan.ts), from the form and the token metadata |

## How Reads Work

### Clients and transports

`client(net)` in [`chain.ts`](chain.ts) builds one viem public client per network and caches it.

- **Fallback across public RPCs.** On Unichain Sepolia the transport is `fallback([...])` over the RPC list in the table above, each an `http()` transport with `retryCount: 2` and `retryDelay: 400` ms. Public testnet RPCs rate-limit per IP; a refused or failed request moves to the next one. Anvil uses one plain `http()` transport.
- **Batching.** Every `http()` transport has `batch: true`, so the reads one screen fires together (a snapshot is eight) go out as one JSON-RPC batch POST.
- **Multicall.** The client sets `batch: { multicall: true }`, and `viemChain()` gives Unichain Sepolia the standard Multicall3 address (`0xcA11…CA11`), so reads made in the same tick are aggregated into one `eth_call`. The local anvil chain has no Multicall3, so there viem falls back to plain `eth_call`s, which the JSON-RPC batching above still packs into one request.
- **`pollingInterval`:** 2000 ms on Unichain, 1000 ms on anvil. This is how often `waitForTransactionReceipt` asks for a receipt.

### Events: incremental `getLogs`

`leashLogs(net)` returns every Leash event since the deploy block, decoded with the ABI and sorted by block and log index.

1. A module-level cache, `scanned`, keeps per network the raw logs already read and the last block scanned (`to`). The first call starts at `deployments/<id>.json`'s `block`.
2. Each call reads the head block and asks only for `[to + 1, head]` with one `eth_getLogs` filtered to the hook's address.
3. If the node refuses the range (many public nodes cap it), it steps through the same range 1,000 blocks at a time.
4. The new logs are appended, `to` moves to the head, and the whole list is decoded with `parseEventLogs(…, strict: false)`.

So the first load scans the hook's history once, and every later poll costs a block-number call and one small `getLogs`. Blockscout's API is not used for logs: it rate-limits and was being read as "no events". `Net.logsApi` is still set on 1301, but only as the flag that selects the slower polling below.

### Other caches

- **Token metadata** (`token()`): one promise per network and address, never refetched. A token that has no `symbol` shows the first six characters of its address; no `decimals` falls back to 18.
- **Block timestamps** (`blockTime()`): one promise per network and block, since a block never changes.

### Polling

`usePoll(load, ms, deps)` in [`ui.tsx`](ui.tsx) runs `load` at once, then every `ms`, and again whenever a dependency changes. It keeps the last good value and the last error, so a failed refresh shows a banner over the last data rather than blanking the screen. Every action button bumps a shared counter (`refresh`) after a write, which re-runs the polls that depend on it.

| What | Unichain Sepolia | Anvil |
|---|---|---|
| Event log (explorer and mandate page) | 20 s | 5 s |
| Mandate snapshot | 6 s | 3 s |
| Epoch records | 6 s | 6 s |
| Owed balances (auction, settle) | 6 s | 6 s |
| Manager track record | 8–10 s | 8–10 s |
| Create form: token metadata, balances, pool taken | 8 s | 8 s |
| Activity block timestamps | 15 s (mandate), 30 s (explorer) | same |

**Paused while hidden.** Each tick checks `document.hidden` and does nothing while the tab is in the background, so an idle tab spends no RPC quota. The next tick after the tab is shown again refreshes.

**Countdowns between polls.** `useClock()` re-renders once a second, and `chainNow(s)` is the snapshot's block timestamp plus the wall-clock time since it was read. On anvil, which mines only when asked, chain time is `max(last block timestamp, wall clock)`, both in `snapshot()` and when the create form computes `auctionEnd`.

## How Writes Work

Every write is a plain function in [`actions.ts`](actions.ts) over a context `{ pub, wallet, account, leash }`. In the browser, `wallet.ctx(net)` in [`wallet.ts`](wallet.ts) builds it from the injected wallet, switching chains first; in [`verify.ts`](verify.ts) it is built from anvil's dev mnemonic. The same functions run in both.

1. **Approve only if needed.** `approve()` reads `allowance(account, leash)` and sends an `approve` for the exact amount only when the allowance is short. `createMandate` may approve both tokens (up to three signatures in all); `bid` may approve the stablecoin (up to two).
2. **Simulate first.** `call()` runs `simulateContract` before asking the wallet to sign. A revert is caught here and costs no gas.
3. **Retry the simulation after an approval.** Public RPCs sit behind load balancers. Right after an approval lands, the node that answers the simulation can be a block behind and still see the old allowance, and the simulation fails with `TRANSFER_FROM_FAILED`. When an approval was just sent, `call()` retries a failure that mentions `TRANSFER_FROM_FAILED` or `allowance` up to five more times, 1.5 s apart, before believing it.
4. **Send and wait.** The simulated request is sent with `writeContract`, then `waitForTransactionReceipt`. A receipt with a failed status throws "The transaction reverted on-chain."
5. **Report.** The `Act` button in [`ui.tsx`](ui.tsx) shows "Waiting for wallet…" while busy, then "Done" with an explorer link, or the error in one plain sentence from `explain()`, and bumps the refresh counter.

The writes: `createMandate`, `bid`, `rebalance`, `setFee`, `checkpoint`, `settle`, `close`, `claim`. There is also `approveMax` (not used by the screens).

### Reverts in plain words

`explain()` turns any wallet or revert error into one sentence:

- **Rejected in the wallet:** "You rejected the request in your wallet."
- **A Leash custom error** (`LowBid`, `SpotOffTwap`, `RangeMissesTwap`, `TooShallow`, `GrowTooFast`, `ThinAnchor`, `BadEpoch`, `NotEnded`, and the rest): a sentence that names the rule, from the `WORDS` table.
- **A v4-core error** (`PoolAlreadyInitialized`, `TickMisaligned`, `CurrenciesOutOfOrderOrEqual`, …): `chain.ts` adds their signatures to the ABI so they decode; each has a sentence too.
- **`WrappedError`:** a hook revert wrapped by the PoolManager. The inner reason is decoded and explained instead.
- **Arithmetic underflow (`Panic(0x11)`):** the position needs more tokens than the mandate holds idle.
- **`Error(string)` with `TRANSFER_FROM_FAILED`:** check your balance and allowance.
- **Insufficient funds:** not enough ETH for gas on this network.
- Anything else: the error name, or viem's short message.

## Files

### `App.tsx`

The shell. Picks the network (`pickNet`), holds the wallet (`useWallet`), parses the hash into route segments (`useHash`), and provides `AppCtx` (`net`, `wallet`, `bump`) to every screen. Renders the floating top bar (the mark links home with `../`; Mandates, Post a mandate, About; the network select; the account chip or Connect), the routed screen, and a footer with the network, the hook's short address and a "Verified source" link to Blockscout.

### `Index.tsx`

The explorer at `#/`. One poll reads the event log and a snapshot of every mandate (newest first); a second poll fetches block timestamps for the rows on screen.

- **Search** takes a pool id (opens it), a transaction hash (opens the mandate any event in that transaction belongs to), or an address (filters the list to mandates where it is the treasury or the manager, shown as a removable chip, and scrolls to the list). Otherwise: "No mandate, transaction or address matches that."
- **Stats:** mandates, live now, bonds at stake, managers hired, hook events, latest block.
- **"Create your own mandate"** card with "Post a mandate" (`#/create`) and "Draft it with AI" (`#/create/ai`).
- **Latest mandates** (6) and **Latest activity** (8) panels. Clicking a treasury address filters the list by it.
- **All mandates** with filter chips: All, Live (auction or active), Mine (treasury or manager is the connected account; disabled without a wallet), Closed.

It also exports `STATUS`, the label for each status, used by the mandate page.

### `Mandate.tsx`

One mandate, four tabs. `MandatePage` polls the log (to find the pool's key from `MandateCreated`), the snapshot, and the epoch records, then renders the header (pair, status, treasury, manager, "(you)" when it is the connected account) and the tab.

- **Dashboard:** five stats (spot, TWAP, bond, fee, countdown), the chart, compliance now with the glide bar, the ledger, the epoch timeline (each epoch's in and out seconds as a bar with the uptime cut line; Clean, Breached, Ended · settle, In progress, Upcoming), the activity feed and the terms. `useSamples` keeps up to 400 chart samples and backfills 40 once per mandate (`backfill`: every 30 blocks when there is room, so about the last 20 minutes on 1-second blocks; a block that a public node cannot serve historically is skipped).
- **Auction:** the leading bond with the leader's track record; while open, the bid form with "Leader + 1" (or "Minimum") and "+10%" presets and a live reason when the amount is too low; once closed, the result. Bid history, who can claim what, and a Claim button for your own balance.
- **Manager console:** a range picker drawn around the TWAP (the must-cover band, the max-gap band, the current range, the new range, spot and TWAP marks); a half-width slider snapped to the tick spacing, or exact lower and upper ticks; size as a percentage of the current position, with Floor, Keep size and +5% presets that pin the exact bigint so they land on the contract's bounds. Every guard `rebalance` applies is a live check (active, connected as the manager, spot–TWAP gap, ticks on the grid, covers TWAP ± minHalfWidth, spot strictly inside, at or above the floor, fits the inventory; when growing: spot within 2 ticks, at most +5%, a TWAP window since the last growth). The button stays disabled with the first failing check as its reason. The fee card takes a percentage or a slider inside the band.
- **Settle and claim:** Checkpoint (anyone), Settle the next epoch (anyone, in order, with the epoch's uptime so far), Close (treasury only; moved to the top once it is the next thing to do), Claim per token, and the manager's track record.

### `Create.tsx`

The term sheet at `#/create`. A treasury fills five numbered sections: 01 Inventory, 02 Auction and bond, 03 Rules the manager must follow, 04 Pay and pace, 05 Opening position. Every field and section has an ⓘ that opens a native popover (`popovertarget`) with what it is, a typical value, and what goes wrong at either end. "Start from" applies a preset (Demo · 3 × 1 hour, or Quarter · 12 × 1 week).

Each field shows its problem from `plan()` beside it in rose, or one derived fact (ticks as ≈ %, fees in pips, the auction's closing time, the anchor's share of value). The sticky review on the right lists the deposit and terms, every problem as a link that focuses its field, warnings, "Every createMandate check passes" when they do, and the exact `createMandate` call under "Exact call". On top of the plan's checks the screen adds two of its own: the pool is already taken (with a free tick spacing to switch to), and the wallet holds less than the deposit.

"Approve and post mandate" re-reads chain time at the moment of signing, re-runs `plan()` with it, and refuses to send if any problem remains. On success it opens the new mandate's dashboard.

The **Assist** panel at the top posts `{ requirements, context }` to `/api/draft`, where `context` is the form's current token addresses, symbols, decimals and price. The draft goes through `applyDraft()` and then the same `plan()` checks as typing. Only fields the draft actually changed are marked in mint with the model's one-line reason; editing a field by hand removes its mark. Assumptions and open questions are listed under the panel. If the drafter is down or has no key, the panel shows the reason and the form works by hand. Three example chips fill the box with different shapes of request. See [../../api/README.md](../../api/README.md).

### `Chart.tsx`

A live SVG of spot, TWAP and the manager's range over time, sized to its container with a `ResizeObserver`. The y axis is stablecoin per token (the tick axis is inverted when the stablecoin is `currency0`). The range is a band that steps when the manager rebalances; the "must cover" band (TWAP ± minHalfWidth) is drawn across the plot. The frame fits the price action and the must-cover band, and pulls in a range edge only if it is close; otherwise the band runs off the plot and the legend gives its bounds. One sample is padded to a flat line, so a quiet pool still draws. It has an `aria-label` with the current spot, TWAP and range.

### `plan.ts`

Pure: no React, no network. It also runs in `verify.ts` and `api/draft.test.ts`.

- **`Form`**: the form in the units people think in (whole tokens, hours, minutes, %, a price).
- **`PRESETS`** (demo, quarter) and **`defaultForm()`**: the demo preset with 100,000 tokens, 200,000 stablecoin at a price of 2, spacing 60, ±12% range, 50% position, 20% anchor.
- **`plan(form, hook, token, stable, now)`** returns `createMandate`'s arguments (the pool key with the dynamic-fee flag, its pool id, `sqrtPriceX96`, `Terms`, `amount0`/`amount1` sorted by address, the opening position) plus `openTick`, the opening stablecoin share, the anchor's share of value, `problems` (every one, in order), `at` (the first problem per field), `owner` (which field each problem belongs to) and `warnings`. It checks everything `createMandate` checks, in words: each `BadTerms` bound, `ThinAnchor` (the anchor must hold 19% of the deposit's value), the opening range covering the opening price ± minHalfWidth, the price limits, and the depth floor. Warnings cover a deposit that opens above the starting stablecoin cap, and 100% uptime. A paired check (gap against half-width) gets a short, field-specific message on each field.
- **`applyDraft(form, draft)`** writes the assistant's draft into the form: only fields it set, addresses only when they are well-formed, numbers only when finite. It returns the new form and the reason per field.

### `actions.ts`

Every write, the approval helper, the simulate-retry-send-wait path, and `explain()`. Covered under [How Writes Work](#how-writes-work).

### `chain.ts`

No DOM, so `verify.ts` imports it under plain `node`.

- **Networks and ABI:** `NETS`, `viemChain()`, `leashAbi` (the deployed ABI plus v4-core errors).
- **Clients:** `client()`, covered under [How Reads Work](#how-reads-work).
- **Types mirroring `Leash.sol`:** `Key`, `Terms`, `Mandate`, `EpochRecord`; and constants that must match the contract: `DYNAMIC_FEE`, `GROW_BPS` (500), `MAX_GROW_GAP` (2), `MIN_ANCHOR_BPS` (1900), `MAX_EPOCHS` (104), `MAX_LP_FEE` (1,000,000).
- **Derived state:** `poolId()`, `statusOf()`, `endOf()`, `epochAt()`, `glideAt()`.
- **Price math (floats, display only):** `priceAt()`, `amountsAt()`, `liquidityFor()`, `tickOfRaw()`, `minTick()`, `maxTick()`.
- **Reads:** `slot0()` via `extsload`, `leashLogs()`, `token()`, `snapshot()`, `chainNow()`, `epochRecords()`, `owed()`, `trackRecord()`, `mandatesFrom()`, `blockTime()`.
- **Words and formatting:** `describe()` (one event as a sentence with a colour for its dot), `fmt`, `fmtNum`, `fmtLiq` (raw liquidity in compact scientific notation), `fmtPrice` (five significant digits), `feePct` (pips to %), `pct` (bps to %), `dur`, `ago`, `short`.

### `wallet.ts`

`useWallet()` over `window.ethereum`. On mount it reads `eth_accounts` and `eth_chainId` without prompting and follows `accountsChanged` and `chainChanged`. `connect()` asks for accounts. `ctx(net)` asks for accounts if needed, switches the wallet to the network (adding it if the wallet does not know it), and returns a viem wallet client on that chain with the shared public client. With no injected wallet it says so: "No browser wallet found. Install one (MetaMask, Rabby, …) to sign transactions."

### `ui.tsx`

Shared pieces: `AppCtx` and `useApp`; `Ticker` (a number that rolls to its new value over 700 ms, and jumps under reduced motion); `Dot` and `Check` (ok, bad or idle, each with an `aria-label` that says yes, no or n/a); `TxLink`; `Act` (the button that runs a write and reports it, with `aria-busy` and a polite live region); `Stat`; `usePoll`; `useClock`.

### `verify.ts`

Drives every write the app makes against a fresh `./scripts/local.sh` chain, through the same functions the screens call (`actions.ts`, `plan.ts`), and checks each result on-chain. It uses anvil's public dev mnemonic and the test client to move time forward. It covers: outbidding, the outbid refund and its claim; `plan()` flagging a thin anchor and `createMandate` refusing it; a real mandate on a new pool and the same pool twice; rebalance refused for a non-manager, a too-narrow range, below the floor and +10% growth, then accepted, then +5% growth, then a second growth in one window refused; `setFee` above the cap and below the floor refused, then accepted; settling early and out of order refused, then a clean settle and the track record; close by the manager and before the end refused, then close, the ledger emptied and the manager's claim; checkpoint after close refused. Each refusal is also checked against the sentence `explain()` gives.

```bash
./scripts/local.sh                                   # from the repo root, in its own terminal
cd frontend && node --experimental-strip-types src/app/verify.ts
```

It needs the seeded mandate still in its auction, so run it on a fresh chain. It prints one line per check and ends with "all writes verified" or the number that failed.

### `app.css`

Every rule is nested under `.lx`, so nothing leaks into the landing page. It uses the tokens from `../theme.css` and adds three tints (mint, violet, rose). Pill buttons, quiet small text, 800-weight uppercase headings. A phone breakpoint stacks the stats two to a row and the ledger rows vertically. Under `prefers-reduced-motion: reduce` every animation and transition inside `.lx` is turned off.

### `BRIEF.md`

The working brief for the app: the screens, the term sheet's visual and wording rules, the assistant's rules, how it is verified, rules learned while building it, and open problems. Read it before changing the create screen or the assistant.

## Rules the App Keeps

- **Nothing simulated.** Every number on screen is a contract view, a PoolManager storage slot or an event. There is no backend and no mock data.
- **No keys in the bundle.** The app holds no secrets. It signs only through the person's own wallet. The drafter's key lives on the server ([../../api/README.md](../../api/README.md)).
- **Simulate before signing.** A write that would revert is refused before the wallet opens, with the reason in plain words.
- **Checks before the button.** The create form and the manager console show every check the contract will make, at the field it belongs to, and keep the button disabled until they pass. The contract stays the authority; the checks only save a wasted signature.
- **Say what is global.** `owed` and track records are per account across the whole hook, and the screens label them that way.
- **Spare the public RPCs.** One cached incremental log scan, batched requests, slower polling on testnet, no polling while the tab is hidden.
