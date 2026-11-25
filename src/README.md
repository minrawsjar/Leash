# Contracts: The Leash Hook

> **Solidity 0.8.26, Foundry, Cancun, optimizer 800 runs. 101 tests passing across 8 suites. Deployed on Unichain Sepolia (chain 1301), source verified.**

Everything Leash puts on chain is one contract, [`Leash.sol`](Leash.sol), plus the vendored v4 [`BaseHook`](utils/BaseHook.sol) it inherits from. One deployed hook serves any number of pools, one mandate per pool. A treasury deposits inventory and posts terms; managers bid a first-loss bond; the winner moves the liquidity and sets the fee inside those terms but can never withdraw it; the hook checks the terms on every swap and pays or slashes per epoch.

What the contract deliberately lacks:

- **No owner, admin, pause or upgrade path.** There is no `Ownable`, no privileged role and no proxy. The deployer has no rights after deployment.
- **No function that sends inventory to the manager.** The manager's two verbs, `rebalance` and `setFee`, take no recipient. A manager receives only its own bond back and its pay, both through `claim`.
- **No way for anyone else to add liquidity or create a Leash pool.** `beforeInitialize` and `beforeAddLiquidity` always revert; the hook's own calls skip its own callbacks.
- **No external oracle.** The TWAP is recorded by the hook itself in `beforeSwap`.
- **No native ETH.** Both currencies must be deployed ERC-20 contracts.

Runtime bytecode is **24,510 bytes**, 66 bytes under the EIP-170 limit (`forge build --sizes`). Any feature added here has to pay for itself in bytes.

## Deployed Contracts

From [`deployments/1301.json`](../deployments/1301.json) (deployed at block 68,664,352). Scripts and the frontend read that file; see [`../deployments/README.md`](../deployments/README.md).

| Contract | Address |
|---|---|
| **Leash** (hook, source verified) | [`0xA8e4A5CECA23777aB7a6f07aE682845c891e2880`](https://unichain-sepolia.blockscout.com/address/0xA8e4A5CECA23777aB7a6f07aE682845c891e2880) |
| **PoolManager** (Uniswap v4, Unichain Sepolia) | [`0x00B036B58a818B1BC34d502D3fE730Db729e62AC`](https://unichain-sepolia.blockscout.com/address/0x00B036B58a818B1BC34d502D3fE730Db729e62AC) |

The hook address ends in `0x2880`. v4 reads a hook's permissions from the low 14 bits of its address, so the salt is mined (see [`../script/README.md`](../script/README.md), `HookMiner.sol`) until the address encodes exactly `beforeInitialize | beforeAddLiquidity | beforeSwap`.

## Index

| File | Lines | What it is |
|---|---|---|
| [`Leash.sol`](Leash.sol) | 722 | The hook: mandates, bond auction, hook-owned liquidity, the anchor, the TWAP oracle, compliance accounting, epoch settlement, close, pull payments. Also the `Terms`, `Position`, `Mandate`, `TrackRecord`, `EpochRecord`, `Obs` and `Oracle` structs and the file-level constants. |
| [`utils/BaseHook.sol`](utils/BaseHook.sol) | 272 | Vendored v4 `BaseHook`. The pinned v4-periphery no longer ships it. Validates the hook address against `getHookPermissions()` in the constructor, guards every callback with `onlyPoolManager`, and reverts `HookNotImplemented` for any callback whose permission is off. |

## Folder Structure

```
src/
├── Leash.sol            # the whole protocol, one contract
│   ├── structs          #   Terms (the mandate's rules), Position, Mandate (per-pool state and ledger),
│   │                    #   TrackRecord, EpochRecord (per-epoch in/out seconds and fees), Obs, Oracle
│   ├── constants        #   OBS, BPS, MAX_MOVE, MAX_GROW_GAP, GROW_BPS, MIN_ANCHOR_BPS, ANCHOR, MAX_EPOCHS
│   ├── hook callbacks   #   _beforeInitialize, _beforeAddLiquidity (both revert), _beforeSwap (oracle + checkpoint)
│   ├── views            #   mandate, twapTick, currentEpoch, epochRecord, compliance, owed, records
│   ├── treasury         #   createMandate, close
│   ├── managers         #   bid, rebalance (+ _guard), setFee
│   ├── anyone           #   checkpoint, settle, claim
│   ├── compliance       #   _checkpoint, _sweep, _ok, _compliance, _stableBps, _checkAnchor, _glide, _epochAt
│   ├── oracle           #   _observe, _truncate, _twap
│   ├── liquidity        #   _place, _move, _anchorOp, _modify, unlockCallback, _resolve
│   └── helpers          #   _live, _active, _end, _stable, _apply, _pull, _push
└── utils/
    └── BaseHook.sol     # vendored v4 BaseHook: address validation, onlyPoolManager, unimplemented callbacks revert
```

## v4 Callbacks

`getHookPermissions()` sets three flags: `BEFORE_INITIALIZE` (bit 13, `0x2000`), `BEFORE_ADD_LIQUIDITY` (bit 11, `0x800`) and `BEFORE_SWAP` (bit 7, `0x80`). Their sum is `0x2880`. The PoolManager calls only the callbacks whose bit is set; the rest are never called, and if called directly they revert `HookNotImplemented` (or `NotPoolManager` for any caller but the PoolManager).

| Callback | Leash (`0x2880`) |
|---|---|
| `beforeInitialize` | **Always reverts `HookOnly`.** Only the hook can create a Leash pool, because v4 skips a hook's callback when the hook itself is `msg.sender` (`createMandate` calls `initialize`). Every Leash pool therefore has a mandate. |
| `afterInitialize` | not called |
| `beforeAddLiquidity` | **Always reverts `HookOnly`.** Nobody but the hook can add liquidity, so the pool's book is exactly the treasury's managed position plus the anchor. Depth and inventory mix are read directly, not estimated. |
| `afterAddLiquidity` | not called |
| `beforeRemoveLiquidity`, `afterRemoveLiquidity` | not called. Only the hook owns positions, so only the hook can remove them. |
| `beforeSwap` | **Records the oracle and checkpoints compliance.** Reads the pre-swap tick, writes at most one observation per block (`_observe`), then books the time since the last check (`_checkpoint`). Returns `(selector, ZERO_DELTA, 0)`: no delta, no fee override. It never reverts on mandate state, so swaps never brick (see below). |
| `afterSwap` | not called. Compliance is judged against the TWAP, and the TWAP uses the pre-swap tick, so there is nothing to do after. |
| `beforeDonate`, `afterDonate` | not called |
| Return-delta flags (`beforeSwapReturnDelta`, `afterSwapReturnDelta`, `afterAddLiquidityReturnDelta`, `afterRemoveLiquidityReturnDelta`) | off. The hook never takes or gives tokens inside a swap. |

The hook also implements `IUnlockCallback.unlockCallback`, guarded by `onlyPoolManager`, to run its own liquidity changes (see [Liquidity and the ledger](#liquidity-and-the-ledger)).

`test_hookAddressEncodesExactlyItsPermissions` (in [`../test/Deploy.t.sol`](../test/Deploy.t.sol)) checks the deployed address's low 14 bits equal these flags and runs v4-core's own `Hooks.validateHookPermissions`.

## External Functions

| Function | Who may call | When | What it does |
|---|---|---|---|
| `createMandate(key, sqrtPriceX96, terms, amount0, amount1, initial)` | anyone; the caller becomes the treasury | once per pool key | Checks the key and terms, initializes the pool at `sqrtPriceX96`, sets the dynamic fee to `maxFee`, seeds the oracle, pulls `amount0`/`amount1`, places the `initial` position, adds the full-range anchor and checks the anchor is at least ~20% of the deposit. Returns the `PoolId`. |
| `bid(key, amount)` | anyone | before `auctionEnd` | Must be at least `minBond` and strictly above the current bond. Pulls `amount` of the stablecoin; the previous high bidder's bond goes to `owed`. |
| `rebalance(key, tickLower, tickUpper, liquidity)` | the winning manager | `auctionEnd <= now < end`, not breached | Passes `_guard` (same-block, TWAP deviation, growth rules), sweeps pre-hire fees, checkpoints, replaces the managed position, books the collected fees to the current epoch, and starts the next interval from the new position's compliance. |
| `setFee(key, fee)` | the winning manager | same as `rebalance` | `minFee <= fee <= maxFee`. Checkpoints, then `poolManager.updateDynamicLPFee`. |
| `checkpoint(key)` | anyone (keepers) | mandate exists and is not closed | Sweeps pre-hire fees if due, then books the time since the last check. A no-op if nothing is due. |
| `settle(key, epoch)` | anyone (keepers) | a manager exists, not breached, `epoch == settled`, the epoch has ended | Judges one epoch, in order: pay the manager `managerFeeBps` of the epoch's fees, or slash the whole bond to the treasury and fire the manager. Settling the last epoch clean frees the bond to the manager. |
| `close(key)` | the treasury | no bids: after `auctionEnd`; hired: after the mandate's end; any time after a breach | Settles every remaining epoch (so a clean manager is paid first), removes the managed position and the anchor, credits any remaining bond to the manager, and transfers all inventory plus unsettled fees to the treasury. |
| `claim(currency)` | anyone, for their own balance | any time | Pays out `owed[msg.sender][currency]` and zeroes it. |
| `unlockCallback(data)` | the PoolManager only | inside the hook's own `unlock` | Runs up to two `modifyLiquidity` ops and settles or takes the net delta. |
| `mandate(id)` | view | | The full `Mandate` struct, including terms and ledger. |
| `twapTick(key)` | view | | The TWAP over `twapWindow`, exactly as the next rebalance or checkpoint will see it. |
| `currentEpoch(key)` | view | | 0 before `auctionEnd`; `>= epochs` after the end. |
| `epochRecord(id, epoch)` | view | | `inSecs`, `outSecs`, `fees0`, `fees1`, `settled`, `clean`. |
| `compliance(key)` | view | | `(inRange, deep, onPace, stableBps)` as the next checkpoint will judge them. |
| `owed(account, currency)` | view | | Pull-payment balance: outbid bonds, returned bonds, pay, slashed bonds for the treasury. |
| `records(manager)` | view | | `TrackRecord`: settled epochs `clean` and `breached`, across every mandate. |
| `getHookPermissions()` | view (pure) | | The three flags above. |
| `poolManager()` | view | | The immutable PoolManager (from `ImmutableState`). |

Events: `MandateCreated`, `Bid`, `Rebalanced`, `FeeSet`, `EpochSettled(id, epoch, clean, pay0, pay1, slashed)`, `Closed`. The frontend reads its history from these ([`../frontend/README.md`](../frontend/README.md)).

## Custom Errors

| Error | Triggered by |
|---|---|
| `HookOnly` | `beforeInitialize` or `beforeAddLiquidity` from anyone but the hook itself: an outsider creating a pool with this hook, or adding liquidity to a Leash pool. |
| `NotLeashPool` | `createMandate` with a key whose `hooks` isn't this contract, whose fee isn't `DYNAMIC_FEE_FLAG`, or whose currency (either one) has no code. Native ETH (`address(0)`) and undeployed tokens fail here. |
| `BadTerms` | `createMandate` with any of: `auctionEnd < now + twapWindow`, `twapWindow == 0`, `epochLength == 0`, `epochs == 0`, `epochs > 104`, `maxFee > 1_000_000`, `minFee > maxFee`, `minLiquidity == 0`, any bps term above 10,000, `maxTickDeviation >= minHalfWidth`, `anchorLiquidity == 0`. |
| `ThinAnchor` | `createMandate` with an anchor worth less than 19% of the deposit's value at the opening price. |
| `NoMandate` | Any mandate call on a pool with no mandate. |
| `MandateClosed` | Any mandate call after `close`. |
| `AuctionClosed` | `bid` at or after `auctionEnd`. |
| `LowBid` | `bid` below `minBond`, or not strictly above the current bond. |
| `NotManager` | `rebalance` or `setFee` from anyone but the current high bidder. |
| `NotActive` | `rebalance`/`setFee` before `auctionEnd` or at/after the mandate's end; `settle` on a mandate with no manager. |
| `NotTreasury` | `close` from anyone but the treasury. |
| `NotEnded` | `close` too early; `settle` of an epoch that hasn't ended. |
| `FeeTooHigh` / `FeeTooLow` | `setFee` above `maxFee` / below `minFee`. |
| `TooShallow` | A placement (`createMandate`'s initial position or `rebalance`) below `minLiquidity`. |
| `RangeMissesTwap` | A placement that doesn't reach `TWAP - minHalfWidth` and `TWAP + minHalfWidth`, or doesn't have spot strictly inside. |
| `SpotOffTwap` | `rebalance` while `abs(spot - TWAP) > maxTickDeviation`; or a growing rebalance while the gap exceeds `MAX_GROW_GAP` (2 ticks). |
| `SameBlock` | A second `rebalance` in one block; or a growing rebalance after the price moved in this block. |
| `GrowTooFast` | A growing rebalance within one `twapWindow` of the last growth, or by more than 5%. |
| `Breached` | `rebalance`, `setFee` or `settle` after the manager was slashed. |
| `BadEpoch` | `settle` of an epoch other than the next unsettled one, or past the last. |
| `HookNotImplemented` (BaseHook) | Any callback whose permission bit is off. |
| `NotPoolManager` (ImmutableState) | Any callback or `unlockCallback` from anyone but the PoolManager. |

A rebalance that needs more inventory than the mandate has reverts with Solidity's arithmetic underflow (`stdError.arithmeticError`) in `_apply`, not a custom error. That is deliberate: the ledger subtraction is the check.

## Constants

| Constant | Value | Why |
|---|---|---|
| `OBS` | 1,024 | Oracle ring-buffer size, one observation per block with a swap. Fixed, not growable: a pool swapped every block on 1-second blocks holds about 17 minutes, and a longer window silently shortens to what is held. Marked `ponytail:` in the source with the upgrade path (v3-style growable cardinality). |
| `BPS` | 10,000 | Basis-point denominator for every `*Bps` term. |
| `MAX_MOVE` | 50 ticks per second | The oracle's recorded tick moves at most this far per second from the previous observation. A genuine 30% crash is reflected within about a minute; a price parked anywhere for one 12-second block moves the recorded tick at most 600 ticks and a 30-minute TWAP at most 4. |
| `MAX_GROW_GAP` | 2 ticks | Growth needs spot within 0.02% of the TWAP. Re-placing L at d ticks off fair loses the treasury at most about L(d/20000)² when the price returns, while the trader moving it back pays about L(d/20000) times the fee; at d <= 2 that is a loss for the trader at any fee >= 0.01%. |
| `GROW_BPS` | 500 (5%) | Growth per rebalance, at most once per TWAP window. Nothing on chain shows the TWAP is stale after a real move, so exposure grows slowly and the extra loss per market move is bounded by one step, not the whole inventory (re-audit High-1). |
| `MIN_ANCHOR_BPS` | 1,900 (19%) | The anchor must hold about 20% of the deposit's value; 19% so the audited 20% configuration passes after rounding. At 10%, drag-and-extract paid (re-audit Medium-2 / R-4). |
| `ANCHOR` | `bytes32(1)` | Position salt of the full-range anchor. The managed position uses salt 0, so the two never collide. |
| `MAX_EPOCHS` | 104 | Two years of weekly epochs. One checkpoint after a long quiet spell writes every epoch it spans (~23k gas each) and `close` settles every unsettled epoch (~80k each); 104 keeps both under the EIP-7825 per-transaction cap of 2²⁴ gas (audit L-1). Marked `ponytail:` with the upgrade path (bounded chunks). |

## Mandate Terms

`Terms` is fixed at creation and never changes.

| Term | Type | Meaning | Checked at creation |
|---|---|---|---|
| `stableIs0` | bool | Which pool currency is the stablecoin. Bonds, slashes and the pace rule use it. | |
| `maxFee` | uint24 pips | Fee cap; the pool starts here. | `<= 1_000_000` |
| `minFee` | uint24 pips | Fee floor, so every manipulation round trip through the pool costs something. | `<= maxFee` |
| `auctionEnd` | uint40 | Bidding closes and epoch 0 starts. | `>= now + twapWindow`, so the oracle holds a full window before the manager can act |
| `epochLength` | uint32 s | Epoch duration. | `> 0` |
| `epochs` | uint16 | Number of epochs. | `1..104` |
| `minBond` | uint256 | Smallest acceptable bid. | |
| `twapWindow` | uint32 s | Seconds the TWAP averages over; also the growth cooldown. | `> 0` |
| `maxTickDeviation` | uint24 | Rebalance only while `abs(spot - TWAP)` is at most this. | `< minHalfWidth` |
| `minHalfWidth` | uint24 | The managed range must cover `TWAP ± minHalfWidth`, spot strictly inside. | `> maxTickDeviation` |
| `minLiquidity` | uint128 | Depth floor for the managed position. | `> 0` |
| `uptimeBps` | uint16 | Share of each epoch that must be in compliance. | `<= 10_000` |
| `managerFeeBps` | uint16 | Manager's share of a clean epoch's managed-position fees. | `<= 10_000` |
| `startStableBps`, `endStableBps` | uint16 | Pace glide path: the highest stablecoin share of inventory value allowed at epoch 0 and at the end, linear in between. | `<= 10_000` each |
| `anchorLiquidity` | uint128 | Permanent full-range position. | `> 0`, and worth `>= 19%` of the deposit (`ThinAnchor`) |

## How It Works

### createMandate

The treasury posts a pool key, an opening price, the terms, the deposit and an initial position. In order:

1. **Key checks.** `hooks == this`, fee is `DYNAMIC_FEE_FLAG`, both currencies have code. The code check is the M-1 fix: solmate's `SafeTransferLib` treats a call to an address without code as a successful transfer, so an undeployed token (or `address(0)`) would credit a deposit that never arrived. `test_M1_phantomDepositOfUndeployedTokenDrainsOtherMandates` pins it.
2. **Terms checks** (table above). `test_createMandate_rejectsShallowOrOffPricePosition` covers `auctionEnd` one second short of a window, `minFee > maxFee` and `minHalfWidth == maxTickDeviation`; `test_L1_closeAfter365UnsettledEpochsExceedsTxGasCap` and `test_swap_afterQuietGapAcrossAllEpochs` cover `epochs > 104`.
3. **Pool creation.** `poolManager.initialize` (reverts if the pool exists, so one mandate per pool), then `updateDynamicLPFee(maxFee)` because v4 dynamic-fee pools start at 0. The oracle is seeded with one observation at the opening tick.
4. **Deposit and placement.** The deposit becomes `idle0`/`idle1`, then the initial position is placed under the same `_place` rules a rebalance uses (`TooShallow`, `RangeMissesTwap`; at creation the TWAP is the opening tick), and the anchor is added from idle.
5. **Anchor floor.** `_checkAnchor` values the anchor and the deposit at the opening price and reverts `ThinAnchor` below 19%.

The pool is never empty from its first block. An empty pool's price can be pushed for free and held until the TWAP follows; liquidity around the price makes that cost capital and invites arbitrage. `test_createMandate_initsPoolAndPlacesInventory` checks the price, the fee at the cap, and pool liquidity of exactly managed + anchor.

`lastOk` starts `true`: the treasury's own position straddles the opening price and the manager can't act before `auctionEnd`, so the first interval is judged by its end alone. A keeper checkpoint at `auctionEnd` makes that interval empty.

### Auction and bid

Bids are in the stablecoin, at least `minBond`, strictly increasing, until `auctionEnd`. The outbid bond goes straight to `owed[previous][stable]`: a pull payment, so a bidder whose transfer would revert (blacklisted, a contract that rejects) can't block the next bid. The highest bidder at `auctionEnd` is the manager; there is no separate "accept" step. `test_bid_highestWins_outbidCanClaim` covers `LowBid`, the refund via `claim` and `AuctionClosed`.

If nobody bids, the mandate never checkpoints (`_checkpoint` returns early with no manager) and the treasury can `close` from `auctionEnd` (`test_close_noBids_afterAuction`).

### Manager: rebalance and its guards

`rebalance` replaces the managed position. The manager names a range and a liquidity; the hook removes the old position and adds the new one in one unlock. Funds only move between the hook and the pool. The guards, in `_guard` and `_place`, exist because the real attack on a hook-held position is mispricing, not withdrawal: pull the liquidity, push the price cheaply, re-place around the fake price, buy the treasury's tokens from another wallet.

| Guard | Rule | Why | Proof |
|---|---|---|---|
| One per block | `lastRebalance != block.timestamp` else `SameBlock` | The TWAP can't see inside a block. | `test_rebalance_oneBlockManipulationRefused` |
| No growth after an in-block move | Growing while the newest observation is this block and `spot != o.open` reverts `SameBlock` | A manager could push the price and grow behind the push. Shrinking or re-ranging at the same size is symmetric, so it is allowed: a one-tick nudge can't veto repairs (re-audit Medium-1). | `test_C1_managerDrainsBySameBlockSandwichLoop`, `test_R3_oneTickNudgeVetoesEveryRepair` |
| TWAP deviation | `abs(spot - TWAP) <= maxTickDeviation` else `SpotOffTwap` | Placing at a pushed spot is the core of the mispricing attack. | `test_rebalance_oneBlockManipulationRefused`, `test_C2_managerDrainsByParkingPriceAtMaxTickForOneBlock` |
| Growth at the TWAP | Growing needs `abs(spot - TWAP) <= MAX_GROW_GAP` (2) else `SpotOffTwap` | A sandwich only pays if the position is bigger on the way back than on the way out. | `test_rebalance_growsOnlyWithSpotAtTwap` |
| Growth rate | At most `GROW_BPS` (5%) per rebalance, at most once per `twapWindow`, else `GrowTooFast` | The TWAP may lag a real move; growing at a stale TWAP and trading to the market takes the difference from the treasury. The cap bounds that to one step (re-audit High-1). | `test_rebalance_growsOnlyWithSpotAtTwap`, `test_limit_managerPlacesAtStalePriceAfterJump`, `test_limit_managerOwningBlockBoundaryPlacesAtLaggingTwap` |
| Depth floor | `liquidity >= minLiquidity` else `TooShallow` | A market maker has to provide real depth. | `test_rebalance_rejectsShallowOrRangeMissingTwap` |
| Minimum width | `lo <= TWAP - minHalfWidth`, `hi >= TWAP + minHalfWidth`, `lo < spot < hi`, else `RangeMissesTwap` | Caps how much inventory sits between a pushed spot and the TWAP (at most `maxTickDeviation`, less than half the width), so a push can't sell a whole side off-price. | `test_rebalance_rejectsShallowOrRangeMissingTwap` |
| Ledger | The new position may use only this mandate's `idle` plus what the old position releases; more underflows | Not the bond, not another mandate's inventory, not unsettled fees. | `test_rebalance_cannotSpendTheBond` |

Shrinking and re-ranging are never rate-limited. Going from the depth floor to 10x takes about 47 TWAP windows of 5% steps.

After placing, `rebalance` books the fees the old position collected to the current epoch and sets `lastOk` from the new position, so a rebalance that restores compliance counts from the fix, not from the next checkpoint (`test_checkpoint_fixCountsFromTheRebalance`). `test_rebalance_followsSustainedMove` shows an honest manager can follow a held price once the TWAP arrives.

### Manager: setFee

The pool uses v4's dynamic-fee flag and starts at `maxFee`. Only the hook can call `updateDynamicLPFee`, and it does so only from `setFee`, with `minFee <= fee <= maxFee`. The fee rule can therefore never be breached and isn't part of compliance. The floor exists because a zero fee made the same-block sandwich loop free (audit C-1). `test_setFee_betweenFloorAndCap`.

### Compliance and checkpoints

Three rules, all measured against the TWAP, not spot (`_compliance`):

- **In range:** `tickLower <= TWAP < tickUpper`.
- **Deep:** `liquidity >= minLiquidity`.
- **On pace:** the stablecoin share of all inventory (idle + managed position + anchor, valued at the TWAP) is at most the glide path at this moment. `test_pace_sellingAheadOfGlidePathIsOutOfCompliance` sells ahead of a 55% to 90% path, is booked out, and is on pace again a day later.

Judging by the TWAP is the grief guard: an outsider can't knock the price out of range for one block to get the manager slashed (`test_settle_oneBadBlockDoesNotBreach`, `test_H1_outsiderForcesBreachWithThreeOneBlockSpikes`).

**Compliance is counted in seconds, not swaps.** `_checkpoint` runs on every swap (from `beforeSwap`), every `rebalance`, `setFee` and `settle`, and the public `checkpoint()`. It books the time since `lastCheck` into the epochs that time spans, splitting at epoch boundaries (`test_checkpoint_splitsQuietGapAcrossEpochs`). An interval counts as in compliance only if the mandate was compliant at **both** ends (`okNow && lastOk`). The TWAP drifts between checkpoints, so judging by the end alone would let a manager wait out a bad stretch and checkpoint once the TWAP drifted back. `test_checkpoint_whitewashAttemptBooksTheBadStretchOut` shows that stretch is still booked out.

With a keeper every minute, the booking is exact to one interval at each change of state: `test_checkpoint_keeperBooksOutStretchWithinOneIntervalPerEdge` books a 2-hour out stretch as between 2h and 2h + 2 minutes, never under. `test_checkpoint_compliantManagerUnaffected` books a compliant day as 86,400 seconds in, 0 out.

Time before `auctionEnd`, after the mandate's end, with no manager, after a breach or after close is ignored. After the end, any price move needs a swap, and its `beforeSwap` checkpoints before the move, so a post-end move can't re-judge the final interval (`test_safe_postEndMoveCannotRejudgeFinalInterval`).

### Fees: the sweep and per-epoch booking

LP fees are collected whenever the hook touches the managed position (every rebalance, settle, sweep and close). Collected fees are held in `fees0`/`fees1`, outside `idle`, so a rebalance can't redeploy unsettled fees as inventory.

- **Pre-hire fees are the treasury's.** `_sweep` runs once, on the first `checkpoint`, `rebalance` or `settle` at or after `auctionEnd`, and moves everything the position earned before then straight into idle. `beforeSwap` can't unlock the PoolManager, so the sweep can't happen inside a swap; instead the first swap after `auctionEnd` (while the sweep is pending) measures the position's uncollected fees with a view read of its fee growth (`LeashOracle.pendingFees`, the same formula PoolManager collects with) into `_preHire`. Fees accrue only in swaps and the position can't change before the sweep, so that is exactly the pre-hire amount: the sweep sends only it to idle and books the rest of what it collects to the first unsettled epoch. `test_settle_feesEarnedBeforeHireGoToTreasury` (a checkpoint comes first), `test_settle_epochFeesCountWhenASwapComesFirst` (a swap does).
- **Epoch fees.** Fees collected by a rebalance are added to the current epoch's record; `_settle` pokes the position (a zero-liquidity modify) to collect the rest and books it to the epoch being settled.
- **The anchor's fees never pay the manager.** The anchor is only touched at close, and its fees ride along to the treasury. `test_safe_anchorFeesNeverPayTheManager` runs the same managed path twice, once with extra trading outside the managed range: the manager's pay is identical, the treasury's take is larger.

### Epochs and settle

Epoch `e` covers `[auctionEnd + e·epochLength, auctionEnd + (e+1)·epochLength)`. `settle(key, e)` requires `e == settled` (in order), `e < epochs`, and the epoch over. Anyone may call it; the keeper does ([`../script/README.md`](../script/README.md), `Settle.s.sol`).

`_settle` sweeps, checkpoints, pokes the position for fees, then judges: clean if `inSecs · 10,000 >= uptimeBps · (inSecs + outSecs)`.

- **Clean:** the manager is owed `managerFeeBps` of each currency's epoch fees; `records[manager].clean++`. The rest of the fees join idle as treasury inventory. If this is the last epoch, the bond is credited to the manager too, so a clean manager never depends on the treasury calling `close` (audit M-2, `test_M2_cleanManagersBondIsHostageToTreasuryClose`). `test_settle_cleanEpochPaysExactShare` checks the 30% to the wei.
- **Breach:** the whole bond is credited to the treasury's `owed`, `breached = true`, `records[manager].breached++`, no pay. The manager is fired: `rebalance`, `setFee` and `settle` revert `Breached`, checkpoints stop, and the treasury may close at once. `test_settle_breachSlashesBondAndFiresManager` books 22h in, 2h out (8% > 5% allowed) and slashes. `test_safe_finalEpochBreachBondGoesToTreasuryOnce` checks a final-epoch breach pays the bond out exactly once.

`EpochSettled` carries `clean`, `pay0`, `pay1` and `slashed`. `test_settle_needsAManager` covers `NotActive` when nobody bid.

### Close

Only the treasury, and only when one of these holds:

| Path | Open from | What happens to the bond |
|---|---|---|
| No bids | `auctionEnd` | none posted |
| Breach | the moment the breach is settled | already credited to the treasury |
| Normal end | the mandate's end (`auctionEnd + epochs·epochLength`) | `close` first settles every unsettled epoch; if all are clean the last one freed the bond to the manager; if one breaches, the loop stops there and the bond goes to the treasury |

Then `close` marks the mandate closed, removes the managed position and the anchor in one unlock, credits any bond still held to the manager (zero if slashed or already freed), and transfers `idle + fees` of both currencies to the treasury. After `close`, the hook holds for this mandate only what it owes in `owed`. `test_close_returnsEverything`, `test_close_paysCleanManagerFirst` (nobody settled during the mandate; close settles all three before paying out), `test_close_noBids_afterAuction`, `test_anchor_fullRangeUntouchedByRebalancesRemovedAtClose`.

Closing settles every remaining epoch in one transaction, which is why `epochs` is capped at 104: `test_L1_closeAfter365UnsettledEpochsExceedsTxGasCap` measures close with 104 unsettled epochs at **8,613,731 gas**, under 2²⁴ = 16,777,216.

### Claims and owed balances

Every payment to a party other than the treasury at close is a pull payment in `owed[account][currency]`: outbid bonds, a clean manager's pay, the manager's returned bond, and a slashed bond (owed to the treasury). `claim(currency)` pays the caller's balance and zeroes it first. This keeps a reverting recipient from blocking a bid, a settle or a close. The only push transfers are deposit pulls, bond pulls, and `close`'s transfer to the treasury.

### Liquidity and the ledger

The hook holds two positions per pool, both owned by the hook:

- **Managed** (salt 0): the manager's range, recorded in `tickLower`, `tickUpper`, `liquidity`.
- **Anchor** (salt `ANCHOR`): full range (`minUsableTick` to `maxUsableTick` for the tick spacing), `anchorLiquidity`, added at creation, removed only at close.

All changes go through `_modify`, which calls `poolManager.unlock` with up to two `ModifyLiquidityParams`. `unlockCallback` runs them (an op with `tickLower == tickUpper` is skipped, which is how "no old position" or "no new position" is expressed), then settles the net delta per currency: `sync` + `transfer` + `settle` if the hook owes, `take` if it is owed. `_modify` then applies `delta - fees` to `idle` and adds the fees to `fees`. An underflow in `_apply` reverts the whole call, so a position can never use more than this mandate's own inventory, even when the hook's total balance (bonds, other mandates, unsettled fees) could cover it.

The ledger identity, for each currency, is: hook balance = Σ over mandates (`idle + fees`) + Σ `owed` + bonds held (in the stablecoin). `_assertLedger` in the unit tests and `invariant_hookHoldsExactlyItsLedger` in the fuzzer check it after every action.

### The anchor

The anchor puts liquidity at every price. Without it, the price outside the managed range could be parked for free and the TWAP dragged; with it, moving or holding the price anywhere costs capital and pays the arbitrageur who trades it back. Keeping the price X ticks away for one block costs about (anchor + managed liquidity in the path) × (X/20000)². Dragging a TWAP means paying that every block for a window.

The anchor is inventory like any other: it counts in the pace rule, its fees go to the treasury, and the manager can't move, shrink or price it. Its size is floored at 19% of the deposit (`ThinAnchor`). Pushing the price to `MAX_TICK` through it would need a swap amount that overflows `int128`, so the original audit attack can't even be expressed (`test_C2_managerDrainsByParkingPriceAtMaxTickForOneBlock`). In `test_twap_oneBlockSpikeBarelyMovesIt`, parking the price 400,000 ticks up for one block costs on the order of 1e28 tokens through a 20e18 anchor.

### The oracle

v4 has no built-in oracle, so the hook keeps one per pool (`Oracle`: a 1,024-slot ring of `Obs{time, tick, tickCumulative}`).

- **Recording.** `beforeSwap` calls `_observe` with the pre-swap tick. At most one observation per block: the first swap of a block writes one, later swaps in that block skip. Using the pre-swap tick (as v3 does) means a price pushed and returned within one block never enters the TWAP (`test_twap_ignoresSameBlockPush_followsSustainedPrice`). `o.open` keeps the tick before the block's first swap, which `_guard` uses to tell whether the price moved this block.
- **Truncation.** `_truncate` moves the recorded tick at most `MAX_MOVE · dt` (50 ticks per second) from the previous recorded tick. A genuine 30% move traded every 12-second block ramps 600 ticks per block and the TWAP is fully there one window plus a minute later (`test_twap_followsGenuineFastMoveWithinAboutAWindow`). A one-block spike moves a 30-minute TWAP at most 4 ticks (`test_twap_oneBlockSpikeBarelyMovesIt`). A long `dt` is not capped beyond overflow: a long gap means the price really sat there with nobody trading against it.
- **Reading.** `_twap` extrapolates from the newest observation to now with the current spot tick, truncated exactly as the next observation will record it, so the view can't be pushed either. It finds the window start by binary search, and rounds toward negative infinity. If the held history is shorter than the window, it averages over what is held; if all history is this block, it returns the opening tick. `test_safe_oracleWraparoundMatchesReference` drives 1,200 swaps over uneven blocks (wrapping the 1,024 slots, and ending with held history shorter than the window) and matches a brute-force reference at every query point.

### Hook callbacks during swaps

Every swap runs `_beforeSwap`: read slot0, `_observe`, `_checkpoint`, return a zero delta and no fee override. `_checkpoint` returns early in every state where there is nothing to book (auction running, no manager, breached, closed, mandate over and fully booked), and nothing in it reverts on mandate state. So the pool keeps trading through every stage of the lifecycle: `test_swap_neverBricks_cleanLifecycle`, `test_swap_neverBricks_noBids`, `test_swap_neverBricks_breached`. After `close` the pool has no liquidity, but swaps still don't revert in the hook.

The worst case for the checkpoint loop is the first swap after a quiet gap spanning all 104 one-hour epochs: `test_swap_afterQuietGapAcrossAllEpochs` measures **2,582,947 gas**, under the 2²⁴ cap.

## Test Coverage

```
101 passing, 0 failed, 0 skipped, 8 suites
  LeashTest 45, LeashPathsTest 16, LeashFuzzTest 12 (256 runs each), LeashAuditTest 13, LeashReauditTest 8,
  DeployTest 2, SettleTest 2, LeashInvariantTest 3 (128 runs x 100 calls each)
```

Per-suite detail is in [`../test/README.md`](../test/README.md); every audit finding, its attack and its measured numbers are in [`../test/audit/README.md`](../test/audit/README.md).

## Usage

```bash
forge build
forge build --sizes                       # Leash runtime 24,566 B (10 B under the limit)
forge test                                # all 101
forge test --match-path test/Leash.t.sol  # the 45 unit tests for this contract
forge inspect Leash abi                   # the ABI; the frontend reads deployments/abi/Leash.json
```

Deploying (address mining, Unichain Sepolia, the local stack) is in [`../script/README.md`](../script/README.md).

## Known Limits

From the root [README](../README.md#known-limits) and the re-audit:

- **Arbitrage keeps the price honest.** The pool holds only the treasury's liquidity, so its price tracks the wider market only as well as arbitrageurs link the two.
- **The TWAP assumes arbitrage.** If nobody trades the pool back toward the market, holding a price costs nothing and any TWAP can be dragged. The anchor turns holding into a cost. In the audit's setup (12-second blocks, anchor about 20% of value), dragging the TWAP 200 to 1,200 ticks cost 45 to 320 times what re-placing around it could then extract, and forcing an honest manager's breach cost 68 times the bond. On 1-second blocks the 1,024-slot oracle holds about 17 minutes while the drag swaps every block, so the per-window cost factor is about 7, not 12.
- **Managers deepen slowly.** 5% per TWAP window; about 47 windows from the floor to 10x.
- **An informed manager can still place badly on purpose.** Nothing on chain shows the TWAP is stale. A manager who knows of a jump before the pool trades can re-range into its path at the old price and arbitrage the treasury. In the audit setup that costs the treasury 0.54 tokens beyond a plain arbitrageur's take on a 10% jump and 5.28 on a 35% jump (of a 200-token inventory). The track record and the auction price this.
- **Fast trends breach honest managers.** While spot runs more than `maxTickDeviation` from the TWAP, rebalances are refused and out-of-range time counts. Four 30% swings in one day breached an honest manager on a ±600 range. Allowing re-ranges at any gap would reopen the sandwich. Managers of volatile tokens keep wide ranges; treasuries size `maxTickDeviation` and `uptimeBps` for the token.
- **Oracle history is fixed at 1,024 observations.** About 17 minutes on 1-second blocks swapped every block; longer windows quietly shorten.
- **Fees are booked when collected.** A late settle counts some of the next epoch's fees toward the earlier one.
- **Quiet pools need the keeper.** Without checkpoints a long gap is judged only by its endpoints, and the first swap after a gap spanning many epochs pays to book them all (about 23k gas per epoch).
- **ERC-20 only, standard tokens only.** Native ETH is rejected; fee-on-transfer and rebasing tokens are not supported.
- **One mandate per pool.** One hook serves many pools.
- **24,510 bytes.** 66 bytes of headroom under EIP-170.

An audit and a re-audit were run against this contract; every finding is kept as a test in [`../test/audit/`](../test/audit/README.md). Not audited by a third party. Testnet only.
