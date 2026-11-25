# Tests: Every Suite for the Leash Hook

> **Foundry, Solidity 0.8.26, v4-core `Deployers`. 61 tests passing, 0 failing, 0 skipped, in 6 suites (measured with `forge test`).**

Every rule in [`src/Leash.sol`](../src/Leash.sol) has a test that fails if the rule breaks. The unit suite proves each rule on its own; the invariant suite drives random sequences and checks the two properties the design rests on (the ledger matches the balances; managers gain only their pay); the audit suites keep every attack found in two review rounds as a test that asserts the attack now fails, or, for the documented limits, that its damage stays inside a measured bound. The deploy and keeper suites run the scripts' own logic against a fresh PoolManager.

What the suites deliberately don't do: no fork tests against Unichain Sepolia (the app's writes are checked against a local anvil stack by `frontend/src/app/verify.ts`, see [`../frontend/README.md`](../frontend/README.md)), no mocked PoolManager (every test runs the real v4-core `PoolManager` and `PoolSwapTest` router), and no gas snapshots.

## Index

| Suite | Contract | Tests | What it covers |
|---|---|---|---|
| [`Leash.t.sol`](Leash.t.sol) | `LeashTest` | 35 | Unit tests: creation, the anchor, treasury-only pool, the oracle, bids, every rebalance guard, the ledger, setFee, checkpoint accounting, pace, settle (pay, slash, pre-hire fees), swaps never brick, close. |
| [`fuzz/LeashInvariant.t.sol`](fuzz/LeashInvariant.t.sol) | `LeashInvariantTest` + `Handler` | 2 | 128 runs x 100 calls of random bids, rebalances, fees, swaps, settles, checkpoints, closes, claims and time; two invariants. |
| [`Deploy.t.sol`](Deploy.t.sol) | `DeployTest` | 2 | The deploy logic of [`script/Local.s.sol`](../script/Local.s.sol): the mined address encodes exactly the permissions; the seeded mandate's state. |
| [`Settle.t.sol`](Settle.t.sol) | `SettleTest` | 2 | The keeper ([`script/Settle.s.sol`](../script/Settle.s.sol)): checkpoint, then settle exactly the ended epochs in order; stop at a breach; no-op afterwards. |
| [`audit/LeashAudit.t.sol`](audit/LeashAudit.t.sol) | `LeashAuditTest` | 12 | Audit round: C-1, C-2, H-1, M-1, M-2, L-1, each with the strongest still-legal variant measured; oracle wraparound; post-end judging. |
| [`audit/LeashReaudit.t.sol`](audit/LeashReaudit.t.sol) | `LeashReauditTest` | 8 | Re-audit of the fixes: growth at a stale TWAP, volatility, one-tick veto, thin anchor, a smarter drag; anchor fees; final-epoch bond. |
| | | **61** | |

The audit suites are explained finding by finding in [`audit/README.md`](audit/README.md).

## Folder Structure

```
test/
├── Leash.t.sol                 # 35 unit tests, one per rule; _assertLedger after every money move
├── Deploy.t.sol                # 2: hook address bits == permissions; seeded local mandate
├── Settle.t.sol                # 2: keeper books, settles in order, stops at a breach, then no-ops
├── fuzz/
│   └── LeashInvariant.t.sol    # Handler (9 actions) + 2 invariants, 128 runs x depth 100
└── audit/
    ├── README.md               # every finding: attack, fix, test, measured numbers
    ├── LeashAudit.t.sol        # 12: round-1 PoCs turned regressions, plus two coverage tests
    └── LeashReaudit.t.sol      # 8: re-audit PoCs, limit bounds, coverage
```

## Running

```bash
forge test                                                    # all 61, 6 suites
forge test --match-path test/Leash.t.sol                      # 35 unit tests: every rule on its own
forge test --match-path test/fuzz/LeashInvariant.t.sol        # 2 invariants, 128 runs x 100 calls each
forge test --match-path test/Deploy.t.sol                     # 2: address bits, seeded mandate
forge test --match-path test/Settle.t.sol                     # 2: keeper round logic
forge test --match-path 'test/audit/*' -vv                    # 20 audit PoCs, with the measured P&L and gas logs
forge test --match-test test_swap_afterQuietGapAcrossAllEpochs -vv   # worst-case checkpoint gas
forge test --match-test test_L1 -vv                           # close() gas with 104 unsettled epochs
```

`-vv` prints the `emit log_named_*` lines the audit and gas tests write. `ffi = true` in [`foundry.toml`](../foundry.toml) is needed by the scripts, not by these tests.

## Shared Setup

`LeashTest`, `LeashAuditTest` and `LeashReauditTest` share one mandate so their numbers are comparable:

| Parameter | Value |
|---|---|
| Hook address | `FLAGS ^ (0x4444 << 144)`, flags `0x2880`, deployed with `deployCodeTo` (no mining needed in tests) |
| Pool | currency0 / currency1 (mock 18-decimal), dynamic fee, tick spacing 60, opened at 1:1 |
| Deposit | 100 of each token |
| Managed position | `[-600, 600)`, L = 1,000e18 (uses ~29.6 of each token) |
| Anchor | L = 20e18 full range, ~20 of each token: 20% of the inventory's value |
| Auction | ends 1 day after creation; bond 10e18 of currency1 (the stablecoin) |
| Epochs | 3 x 1 day |
| TWAP | 1,800 s window, `maxTickDeviation` 100, `minHalfWidth` 200 |
| Depth floor | `minLiquidity` 100e18 |
| Fees | `maxFee` 1% (10,000 pips), `minFee` 0.05% (500), manager share 30% |
| Uptime | 95%: 72 minutes out allowed per 1-day epoch |
| Pace | 100% to 100% (off) except in `test_pace_*` |

`_win()` has alice bid 10e18, warps to `auctionEnd` and checkpoints, as a keeper would. `_assertLedger()` checks, for each currency, hook balance == `idle + fees + Σ owed (+ bond in currency1)`.

`DeployTest` and `SettleTest` instead use the stack [`script/Local.s.sol`](../script/Local.s.sol) builds: a TKN/mUSDC pool at 1 TKN = 2 mUSDC across 18 vs 6 decimals, two bids (manager #2 leading), a few swapper trades, auction still open.

## Leash.t.sol: Unit Tests (35)

### Creation and the treasury-only pool

| Test | Proves |
|---|---|
| `test_createMandate_initsPoolAndPlacesInventory` | Pool at 1:1, fee starts at the 1% cap, the hook is treasury, pool liquidity is exactly managed + anchor (1,020e18), idle equals the hook's balances. |
| `test_createMandate_rejectsShallowOrOffPricePosition` | `TooShallow` at 99e18; `RangeMissesTwap` for a range not containing spot and for one narrower than `minHalfWidth`; `BadTerms` for `auctionEnd` 1 s short of a window, `minFee > maxFee`, `minHalfWidth == maxTickDeviation`. |
| `test_anchor_fullRangeUntouchedByRebalancesRemovedAtClose` | The anchor spans the full range, survives rebalances and swaps at 20e18, is removed at close, its fees go to the treasury, the manager gets exactly 30% of managed fees, and the hook ends at zero balance. |
| `test_outsiderCannotAddLiquidity` | An outside `modifyLiquidity` through v4's router reverts (the hook's `HookOnly`, wrapped by the PoolManager). |
| `test_outsiderCannotCreateLeashPool` | An outside `initialize` with this hook reverts. |

### Oracle

| Test | Proves |
|---|---|
| `test_twap_ignoresSameBlockPush_followsSustainedPrice` | Spot pushed to 400 in the same block: TWAP 0. Held a tenth of the window: 40. Held a full window: 400. Half a window at -200 after that: exactly 100. |
| `test_twap_followsGenuineFastMoveWithinAboutAWindow` | A real 30% move traded every 12 s block: the TWAP is exactly 3,000 one window plus one minute later. |
| `test_twap_oneBlockSpikeBarelyMovesIt` | Price parked 400,000 ticks up for one block: TWAP <= 4 while parked and after; back to spot one window later. |

### Bids and the manager

| Test | Proves |
|---|---|
| `test_bid_highestWins_outbidCanClaim` | `LowBid` for an equal bid; bob outbids alice; alice is owed 10e18 and `claim` makes her whole; `AuctionClosed` after the end. |
| `test_rebalance_onlyManager_onlyWhenActive` | `NotActive` during the auction; `NotManager` for an outsider. |
| `test_rebalance_oneBlockManipulationRefused` | Push, then grow in the same block: `SameBlock`. Next block: `SpotOffTwap` (400 off a TWAP that barely moved). A second rebalance in one block: `SameBlock`. |
| `test_rebalance_growsOnlyWithSpotAtTwap` | With spot 60 ticks off the TWAP, growing by 1 wei of liquidity is `SpotOffTwap` while the same size re-range succeeds. With spot at the TWAP: 5% + 1 is `GrowTooFast`, exactly 5% succeeds, another 5% within the window is `GrowTooFast`, and it succeeds one window later. |
| `test_rebalance_followsSustainedMove` | An honest manager re-ranges once a held price is in the TWAP. |
| `test_rebalance_rejectsShallowOrRangeMissingTwap` | `TooShallow`; `RangeMissesTwap` for each of: too narrow below, too narrow above, spot outside. |
| `test_rebalance_swap_ledgerMatchesBalances` | After a 5% growth and a swap: pool liquidity 1,050e18 + 20e18; the fee was collected outside idle, booked to epoch 0; ledger holds. |
| `test_rebalance_cannotSpendTheBond` | A range needing 5 more currency1 than the mandate has reverts with `arithmeticError`, though the hook's balance (with the 10e18 bond) could pay. |
| `test_setFee_betweenFloorAndCap` | `FeeTooHigh`, `FeeTooLow`; 500 pips is set in the pool. |

### Compliance accounting

| Test | Proves |
|---|---|
| `test_checkpoint_splitsQuietGapAcrossEpochs` | Out of range from 12 h into epoch 0, then a day of silence: epoch 0 gets 12 h in / 12 h out, epoch 1 gets 12 h out. |
| `test_checkpoint_whitewashAttemptBooksTheBadStretchOut` | The TWAP leaves the range and drifts back while nobody checkpoints; the manager checkpoints once it's back: 1 h in, 2 h out (10 min seen out + 110 min not proven in). |
| `test_checkpoint_keeperBooksOutStretchWithinOneIntervalPerEdge` | Spot at 900 for 130 min; TWAP out for exactly 2 h. Minute keeper: out between 2 h and 2 h + 2 min; in + out == elapsed. |
| `test_checkpoint_compliantManagerUnaffected` | In range all epoch with swaps, keeper and a rebalance: 86,400 s in, 0 out, clean. |
| `test_checkpoint_fixCountsFromTheRebalance` | A rebalance that restores compliance counts from the fix: 1 h out, 1 h in. |
| `test_pace_sellingAheadOfGlidePathIsOutOfCompliance` | Glide 55% to 90%: starts on pace at 50%, buyers push the stable share above 58%, booked out for an hour, on pace again a day later. |

### Settlement

| Test | Proves |
|---|---|
| `test_settle_cleanEpochPaysExactShare` | `NotEnded` early; clean epoch: fees equal the managed share of a 10-token swap at 1% (1000/1020 of the LP fee), manager owed exactly 30%, track record 1/0, the rest joins idle; `BadEpoch` out of order; ledger holds. |
| `test_settle_breachSlashesBondAndFiresManager` | 22 h in, 2 h out: breach; bond 0, treasury owed 10e18, no pay, record 0/1; `Breached` on rebalance, setFee, settle; close at once; no bond back; hook ends at zero. |
| `test_settle_oneBadBlockDoesNotBreach` | Out of range for one block and back: the epoch stays clean, bond intact. |
| `test_settle_feesEarnedBeforeHireGoToTreasury` | An auction-period swap's fees are swept into idle, epoch 0 books only later fees, pay is 30% of those. |
| `test_settle_epochFeesCountWhenASwapComesFirst` | The same, with no checkpoint after the auction: the first touch is a swap. Its `beforeSwap` measures the pre-hire fees, so the sweep at settle takes only those to idle and epoch 0 keeps the later swap's fees and pays 30% of them. Failed before the fix (epoch 0 booked 0). |
| `test_settle_needsAManager` | `NotActive` with no bids. |

### Swaps and close

| Test | Proves |
|---|---|
| `test_swap_neverBricks_cleanLifecycle` | A swap each way succeeds at every stage of a clean mandate. |
| `test_swap_neverBricks_noBids` | Same, with nobody bidding. |
| `test_swap_neverBricks_breached` | Same, after a breach. |
| `test_swap_afterQuietGapAcrossAllEpochs` | `epochs = 105` is `BadTerms`; with 104 one-hour epochs and no activity until after the end, the first swap books every epoch for **2,534,163 gas** (< 2²⁴), epoch 0 and epoch 103 each 1 h in. |
| `test_close_returnsEverything` | `NotEnded` before the end, `NotTreasury` for the manager; close returns 100/100 (within 4 wei), bond owed back, pool liquidity 0. |
| `test_close_paysCleanManagerFirst` | Nobody settled: close settles all 3, pays 30% of epoch 0's fees and the bond, record 3 clean, hook ends at zero after claims. |
| `test_close_noBids_afterAuction` | No bids: close right after the auction, hook ends at zero. |

## fuzz/LeashInvariant.t.sol: Invariants (2)

The `Handler` is the treasury and the swapper; alice and bob bid and manage. The mandate here differs from the unit setup: 1,000/1,000 deposit, managed `[-600, 600)` L = 2,000e18, anchor 200e18, auction 1 h, 4 epochs x 6 h, TWAP 600 s, deviation 200, half width 400, uptime 90%, glide 60% to 90%. Nine actions, each wrapped in `try` so a revert is a no-op:

| Action | Bounds |
|---|---|
| `bid(who, amount)` | 10e18 to 1,000e18 |
| `rebalance(shift, below, above, liq)` | centre at the TWAP ± up to 5 spacings, 1 to 20 spacings each side, L 50e18 to 6,000e18 |
| `setFee(fee)` | 0 to 20,000 pips (outside the band too) |
| `swap(zeroForOne, amount)` | 0.001 to 100 tokens, limit ±3,000 ticks |
| `settle()`, `checkpoint()`, `close()` | the next epoch / now |
| `claim(who, zero)` | alice, bob or the treasury, either currency |
| `warp(secs)` | 1 s to 3 h, one block |

Ghost variables mirror the settlement rules (`pay` per clean epoch at 30% of `r.fees`, `slashed` per breach).

| Invariant | Asserts |
|---|---|
| `invariant_hookHoldsExactlyItsLedger` | Hook balance of currency0 == `idle0 + fees0 + Σ owed0`; of currency1 == `idle1 + fees1 + Σ owed1 + bond`. Nothing is created or lost by any sequence. |
| `invariant_managersGainOnlyTheirPay` | For each bidder: wallet currency0 <= ghost pay; wallet currency1 <= start + ghost pay; and wallet + owed (+ bond if manager) + slashed == start + pay exactly. A manager can never receive inventory. |

Measured: 128 runs, 12,800 calls per invariant, 0 reverts at the handler level, every one of the nine selectors called roughly 1,350 to 1,500 times per invariant.

## Deploy.t.sol (2)

| Test | Proves |
|---|---|
| `test_hookAddressEncodesExactlyItsPermissions` | The low 14 bits of the mined address equal `flags(getHookPermissions())`; v4-core's `Hooks.validateHookPermissions` passes; the hook's PoolManager is the stack's. |
| `test_seededMandate` | Treasury #0; manager #2 leads with `BID2`; #1 is owed `BID1`; auction open; idle equals deposit minus what the opening position and anchor took at the opening price (about 30% idle); ledger equals balances in TKN and mUSDC; fee at the cap; tick within 20 of ±269,393 (1 TKN = 2 mUSDC across 18 vs 6 decimals); starts compliant. |

## Settle.t.sol (2)

`Settle.keep(leash, key)` returns `(checkpointed, settledCount)`. These tests read `EpochSettled` logs to check exactly which epochs each round settled.

| Test | Proves |
|---|---|
| `test_checkpointsThenSettlesExactlyTheEndedEpochsInOrder_thenNoop` | Auction open: nothing. Mid epoch 0: checkpoint, sweep of pre-hire fees, half an epoch booked. After epoch 0: settles `[0]`. Run again: checkpoints only. Past the end: settles `[1, 2]`. Then nothing. Track record 3 clean. After close: skips without reverting. |
| `test_stopsAtABreach` | The swapper dumps until spot is 600 ticks under the range. After every epoch ends, the keeper settles `[0]`, it breaches, and the keeper stops there and no-ops afterwards. |

## Audit Suites (20)

Covered in depth in [`audit/README.md`](audit/README.md). In short:

| Suite | Tests | Findings kept as tests |
|---|---|---|
| `LeashAuditTest` | 12 | C-1 same-block sandwich (3 tests), C-2 parking and dragging the TWAP (2), H-1 forced breach (2), M-1 phantom token, M-2 bond hostage, L-1 close gas, and 2 coverage tests (post-end judging, oracle wraparound) |
| `LeashReauditTest` | 8 | High-1 growth at a stale TWAP (2 limit tests), Low-1 volatility (1 limit test), Medium-1 one-tick veto, Medium-2 thin anchor, and 3 coverage tests (smarter drag, anchor fees, final-epoch bond) |

## Measured Results

From `forge test` on this tree:

```
Ran 2 tests for test/Deploy.t.sol:DeployTest                    2 passed
Ran 2 tests for test/Settle.t.sol:SettleTest                    2 passed
Ran 35 tests for test/Leash.t.sol:LeashTest                     35 passed
Ran 12 tests for test/audit/LeashAudit.t.sol:LeashAuditTest     12 passed
Ran 8 tests for test/audit/LeashReaudit.t.sol:LeashReauditTest  8 passed
Ran 2 tests for test/fuzz/LeashInvariant.t.sol                  2 passed (runs: 128, calls: 12800, reverts: 0)
Ran 6 test suites: 61 tests passed, 0 failed, 0 skipped (61 total tests)
```

Gas figures logged by the tests: close with 104 unsettled epochs 8,610,615; the first swap after a quiet gap over 104 epochs 2,534,163. Both are under the EIP-7825 cap of 16,777,216.

## Limits of the Tests

- Prices are a mock 1:1 market in the unit and audit suites; "market" means an arbitrageur account restoring tick 0. Real arbitrage is less reliable than that, which is the hook's first known limit ([`../src/README.md`](../src/README.md#known-limits)).
- Blocks are 12 s in the attack tests. On Unichain's 1 s blocks the drag factor is about 7, not 12, per the root README.
- The invariant handler uses one mandate and two bidders.
- No third-party audit. Testnet only.
