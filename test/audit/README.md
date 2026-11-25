# Audit: Every Finding, Its Attack, Its Fix and Its Test

> **Foundry, Solidity 0.8.26. 20 tests passing (12 audit, 8 re-audit), measured with `forge test --match-path 'test/audit/*' -vv`. Against the hook deployed on Unichain Sepolia at [`0xA8e4…2880`](https://unichain-sepolia.blockscout.com/address/0xA8e4A5CECA23777aB7a6f07aE682845c891e2880).**

Two review rounds were run against [`src/Leash.sol`](../../src/Leash.sol). The first (the audit) found 2 critical, 1 high, 2 medium and 1 low. The second (the re-audit) reviewed the fixes and found 1 high, 2 medium and 2 low. Every finding except the documentation fix (Low-2) started as a proof of concept that demonstrated the attack; after the fix, the same test was turned around to assert the attack fails. Where a fix refuses the original move, the test also runs the **strongest variant that is still legal** and measures that it loses. Where a finding is a limit that can only be bounded, not removed, the test asserts the measured damage stays inside a bound, so any regression fails.

The test names keep the original finding wording (for example `test_L1_closeAfter365UnsettledEpochsExceedsTxGasCap` now asserts close fits under the cap). Read each test's assertion, not its name, for what it proves today.

## Index

| File | Tests | Round |
|---|---|---|
| [`LeashAudit.t.sol`](LeashAudit.t.sol) | 12 | Audit: C-1 (3), C-2 (2), H-1 (2), M-1, M-2, L-1, and 2 coverage tests |
| [`LeashReaudit.t.sol`](LeashReaudit.t.sol) | 8 | Re-audit: High-1 (2 limit tests), Low-1 (1 limit test), Medium-1, Medium-2, and 3 coverage tests |

## Findings at a Glance

| ID | Severity | Attack | Fix | Status | Test(s) |
|---|---|---|---|---|---|
| C-1 | Critical | Manager sandwiches the treasury with same-block rebalances at a zero fee in a 60-tick range | `minFee` floor, `minHalfWidth`, one rebalance per block, no growth after an in-block move, growth only at the TWAP | Fixed | `test_C1_managerDrainsBySameBlockSandwichLoop`, `test_C1_strongestLegalSandwich_arbitraged`, `test_C1_strongestLegalSandwich_managerOwnsBlockBoundary` |
| C-2 | Critical | Manager parks the price at `MAX_TICK` for one block to drag the TWAP, then places around it | Full-range anchor; oracle truncation (`MAX_MOVE`) | Fixed | `test_C2_managerDrainsByParkingPriceAtMaxTickForOneBlock`, `test_C2_strongestLegalDragThenExtract` |
| H-1 | High | Outsider forces an honest manager's breach with three one-block spikes | Anchor + truncation; compliance judged on the TWAP | Fixed | `test_H1_outsiderForcesBreachWithThreeOneBlockSpikes`, `test_H1_strongestLegalBreachCostsFarMoreThanTheBond` |
| M-1 | Medium | Phantom deposit of an undeployed token drains other mandates | `createMandate` requires code at both currencies | Fixed | `test_M1_phantomDepositOfUndeployedTokenDrainsOtherMandates` |
| M-2 | Medium | Clean manager's bond is hostage to the treasury calling `close` | Settling the last epoch clean frees the bond | Fixed | `test_M2_cleanManagersBondIsHostageToTreasuryClose` |
| L-1 | Low | `close` after 365 unsettled epochs exceeds the per-transaction gas cap | `MAX_EPOCHS = 104` | Fixed | `test_L1_closeAfter365UnsettledEpochsExceedsTxGasCap` |
| Re-audit High-1 (R-1) | High | Manager grows the position at a stale TWAP right after a real market move | `GROW_BPS`: 5% per rebalance, once per TWAP window | Bounded, documented limit | `test_limit_managerPlacesAtStalePriceAfterJump`, `test_limit_managerOwningBlockBoundaryPlacesAtLaggingTwap` |
| Re-audit Medium-1 (R-3) | Medium | A one-tick nudge at the top of each block vetoes every repair rebalance | The same-block rule applies only to growth | Fixed | `test_R3_oneTickNudgeVetoesEveryRepair` |
| Re-audit Medium-2 (R-4) | Medium | A thinner anchor and depth floor make drag-and-extract profitable | `MIN_ANCHOR_BPS`: anchor >= 19% of the deposit (`ThinAnchor`) | Fixed | `test_R4_dragProfitableWithThinnerAnchorAndFloor` |
| Re-audit Low-1 (R-2) | Low | Honest manager breached by volatility it isn't allowed to answer | None: kept on purpose | Documented limit | `test_limit_honestManagerBreachedByVolatilityItCannotAnswer` |
| Re-audit Low-2 | Low | The root README's drag-cost factor for 1-second blocks was wrong | README corrected to about 7x | Fixed (docs) | none |

Coverage tests that were expected to hold, and do: `test_safe_postEndMoveCannotRejudgeFinalInterval`, `test_safe_oracleWraparoundMatchesReference` (audit); `test_safe_smarterC2DragStillLoses`, `test_safe_anchorFeesNeverPayTheManager`, `test_safe_finalEpochBreachBondGoesToTreasuryOnce` (re-audit).

## Folder Structure

```
test/audit/
├── README.md               # this file
├── LeashAudit.t.sol        # round 1: alice (manager), eve (outsider), arb (arbitrageur restoring 1:1)
│   ├── C-1                 #   same-block sandwich loop; two-block sandwich with and without an arbitrageur
│   ├── C-2                 #   park at MAX_TICK; drag the TWAP 300/600/1200 for a window, then extract
│   ├── H-1                 #   three one-block spikes; hold the range edge every block for 110 minutes
│   ├── M-1, M-2, L-1       #   phantom token; bond hostage; close gas with 104 / 365 epochs
│   └── coverage            #   post-end move can't re-judge; 1,200-swap oracle vs brute-force reference
└── LeashReaudit.t.sol      # round 2 against the round-1 fixes
    ├── R-1 (High-1)        #   grow at a stale TWAP after a 10% / 35% jump; grow at a lagging TWAP
    ├── R-2 (Low-1)         #   four 30% swings in a day vs an honest +-600 manager
    ├── R-3 (Medium-1)      #   one-tick nudge at the top of every block
    ├── R-4 (Medium-2)      #   thin anchor (10%) and thin floor (25e18)
    └── coverage            #   smarter drag; anchor fees; final-epoch bond
```

## Running

```bash
forge test --match-path 'test/audit/*' -vv                       # all 20, with every measured number
forge test --match-path test/audit/LeashAudit.t.sol -vv          # 12: C-1, C-2, H-1, M-1, M-2, L-1, coverage
forge test --match-path test/audit/LeashReaudit.t.sol -vv        # 8: R-1 to R-4, coverage
forge test --match-test 'test_C1' -vv                            # sandwich P&L per cycle
forge test --match-test 'test_C2_strongestLegalDragThenExtract' -vv   # drag cost vs extraction at 300/600/1200
forge test --match-test 'test_H1_strongest' -vv                  # attacker cost vs the bond
forge test --match-test 'test_limit' -vv                         # the three documented limits and their bounds
```

## Setup and Threat Model

Both suites use the same mandate as [`../Leash.t.sol`](../Leash.t.sol) so numbers are comparable: 100/100 inventory at 1:1, managed `[-600, 600)` with L = 1,000e18, anchor 20e18 full range (about 20% of value), tick spacing 60, bond 10e18 in currency1 (the stablecoin), TWAP window 1,800 s, `maxTickDeviation` 100, `minHalfWidth` 200, `minLiquidity` 100e18, fee floor 0.05%, cap 1%, uptime 95% (72 minutes out allowed per 1-day epoch), 3 epochs.

Actors: **alice** is the manager, **eve** an outsider (or the treasury, who receives a slashed bond), **arb** an arbitrageur who restores the 1:1 market price. Blocks are 12 seconds (`_next(12)` warps and rolls). Every attacker holds 1,000,000 of each token. P&L is valued at the 1:1 market (or at the post-jump market in R-1) and counts what the hook owes the attacker (pay), not the bond.

Helpers worth knowing when reading the tests:

- `_moveTo(who, t)` swaps until spot is exactly tick `t`.
- `_narrowest()` is the narrowest legal range now: TWAP ± 200, rounded out to the spacing.
- `_maxLiquidity(lo, hi)` is the most the mandate's inventory can place in `[lo, hi)`, capped at 5% growth: the strongest legal placement.
- `_keep(until)` is a keeper checkpointing every minute.

## Audit Round

### C-1: Same-block sandwich loop (Critical)

**Attack.** The manager sets the fee to 0, shrinks to a 60-tick range, pushes spot with its own swap, rebalances the whole inventory behind the push in the same block, and sells back into it. The TWAP can't see within a block, and a zero fee makes the round trip free. Repeat every block.

**Fix.** Four rules, all in [`Leash.sol`](../../src/Leash.sol):

- `minFee`: the fee can't go to 0 (`FeeTooLow`). Every round trip pays.
- `minHalfWidth`: the range must cover TWAP ± 200, so a 60-tick range is `RangeMissesTwap`.
- One rebalance per block, and growth is refused after the price moved this block (`SameBlock`).
- Growth only with spot within `MAX_GROW_GAP` (2 ticks) of the TWAP (`SpotOffTwap`).

A same-size re-range after a push is still allowed. That is the point of the design: the push out and the push back then meet the same liquidity, so the manager pays fees both ways for nothing.

**Tests and measured numbers.**

| Test | What it runs | Measured | Asserts |
|---|---|---|---|
| `test_C1_managerDrainsBySameBlockSandwichLoop` | `setFee(0)` reverts `FeeTooLow`; a 60-tick range reverts `RangeMissesTwap`; growth after a push reverts `SameBlock`. Then 20 loops of push to TWAP + 99, same-size re-range behind it, push back. | Manager P&L over 20 loops, including pay: **-0.0599** tokens | P&L <= 0 |
| `test_C1_strongestLegalSandwich_arbitraged` | Two-block cycle at the 0.05% floor: block 1 shrink to `minLiquidity` in the narrowest range and push to TWAP + 99; an arbitrageur backruns; block 2 re-place everything legal at spot (falls back to same size when growth is refused) and sell back. 20 cycles. The manager stays clean. | Manager **-0.0029** per cycle; arbitrageur **+0.00259** per cycle | manager P&L <= 0 |
| `test_C1_strongestLegalSandwich_managerOwnsBlockBoundary` | The same, but nobody trades between the push and the re-placement (the manager is last in block 1 and first in block 2). | Manager **-0.00089** per cycle | P&L <= 0 |

### C-2: Parking the price at MAX_TICK (Critical)

**Attack.** In the pre-fix design, the price outside the managed range had no liquidity. The manager pushed it to `MAX_TICK` for one block for almost nothing, which dragged the TWAP, then placed the treasury's inventory around the dragged TWAP and bought it cheaply.

**Fix.**

- **The anchor.** A permanent full-range position (`anchorLiquidity`) puts liquidity at every price. Pushing to `MAX_TICK` now means buying out the anchor; the swap amount overflows `int128` and can't even be expressed.
- **Truncated oracle.** Each recorded tick moves at most `MAX_MOVE` (50 ticks per second) from the previous one. A price held anywhere for one 12-second block moves the recorded tick at most 600 and a 30-minute TWAP at most 4.

**Tests and measured numbers.**

| Test | What it runs | Measured | Asserts |
|---|---|---|---|
| `test_C2_managerDrainsByParkingPriceAtMaxTickForOneBlock` | A swap to `MAX_SQRT_PRICE - 1` reverts. Spot pushed to tick 100,000 (as far as ~3,000 tokens through the anchor buy) for one block. A rebalance around it. | TWAP <= 4 | The swap reverts; TWAP <= 4; the rebalance reverts `SpotOffTwap` |
| `test_C2_strongestLegalDragThenExtract` | Against an arbitrageur who restores 1:1 first thing every block, the manager ends every block with spot at +X for one window (151 blocks), its position shrunk to `minLiquidity` in `[-240, X + 240)` so it stays compliant on the way. Then, first in a block with spot == TWAP, it re-places the maximum legal liquidity around the dragged TWAP and sells down to 1:1 into it. | See below | drag cost > extracted, for every X |

| X (ticks) | TWAP after the drag | Cost to drag for one window | Extracted by re-placing | Cost / extracted |
|---|---|---|---|---|
| 300 | 300 | 4.6014 | 0.0264 | ~174x |
| 600 | 600 | 18.1979 | 0.0776 | ~235x |
| 1,200 | 1,200 | 72.1678 | 0.2070 | ~349x |

The drag works (the TWAP really reaches X), and it is the arbitrageur who earns what the manager pays. The 5% growth cap is what keeps the extraction small.

### H-1: Outsider forces a breach with one-block spikes (High)

**Attack.** Before the fix, an outsider pushed the price to `MAX_TICK` for one block, three times in an epoch. Each spike moved the TWAP out of an honest manager's range long enough that the out-of-range time exceeded the allowance and the manager's bond was slashed (to the treasury, which could be the attacker).

**Fix.** The same anchor and truncation as C-2, plus compliance is judged against the TWAP, not spot.

**Tests and measured numbers.**

| Test | What it runs | Measured | Asserts |
|---|---|---|---|
| `test_H1_outsiderForcesBreachWithThreeOneBlockSpikes` | Keeper every minute. Three times, an hour apart: eve pushes spot to 100,000 for one block and back. | TWAP <= 4 after every spike | TWAP <= 4; epoch 0 clean |
| `test_H1_strongestLegalBreachCostsFarMoreThanTheBond` | Against an arbitrageur restoring 1:1 first thing every block, eve ends every block for the last 110 minutes of the epoch with spot at the honest manager's upper edge (600): a window to drag the TWAP out, then 80 minutes out of range, over the 72 allowed. Keeper every 5 blocks. | **550** blocks held; **4,812** s out (> 4,320 allowed); attacker cost **677.45** tokens vs a **10** token bond | The epoch is breached (the attack works when held long enough); cost > 10x the bond |

The breach is real: holding the price at the edge for a whole window and longer does move the TWAP out. The test pins that it costs about 68 times the bond, paid to the arbitrageur.

### M-1: Phantom deposit of an undeployed token (Medium)

**Attack.** solmate's `SafeTransferLib` doesn't check for code, so `_pull` of a token not yet deployed succeeds without moving anything and the mandate is credited. With the opening price exactly on the initial range's lower tick, the position needs none of that currency, so creation succeeds. Once the token is deployed at its predictable address (CREATE2, or a bridge factory) and another treasury deposits it, the attacker closes and walks away with that treasury's tokens; the victim's own close then reverts.

**Fix.** `createMandate` reverts `NotLeashPool` unless both currencies have code. This also rejects native ETH (`address(0)`).

**Test.** `test_M1_phantomDepositOfUndeployedTokenDrainsOtherMandates`: creation with the phantom address reverts `NotLeashPool`. After `vm.etch` deploys a real token there, the same mandate is created and eve's balance drops from 100e18 to 50e18: the deposit was really pulled.

### M-2: Clean manager's bond hostage to the treasury (Medium)

**Attack.** Not an attacker's profit, a trust failure. The bond came back only inside `close()`, which only the treasury can call. A treasury that never closes (lost keys, a governance contract without the call, extortion, a USDC-blacklisted treasury whose close reverts on the transfer) locks a clean manager's bond forever.

**Fix.** Settling the final epoch clean credits the bond to the manager's `owed` balance. `close` later credits `m.bond`, which is then zero.

**Test.** `test_M2_cleanManagersBondIsHostageToTreasuryClose`: all 3 epochs settled by eve (a third party); the manager can't `close` (`NotTreasury`) and can't settle a fourth (`BadEpoch`), but `claim` returns its full 1,000,000e18 starting balance. The treasury's later close leaves `owed` at 0: no double refund.

### L-1: close() over the per-transaction gas cap (Low)

**Attack.** `close` settles every unsettled epoch in one transaction. With 365 hourly epochs unsettled, it needed more than the EIP-7825 cap of 2²⁴ gas, so the treasury could never close and the inventory was stuck.

**Fix.** `MAX_EPOCHS = 104` (two years of weekly epochs), enforced in `createMandate` (`BadTerms`).

**Test.** `test_L1_closeAfter365UnsettledEpochsExceedsTxGasCap`: 365 epochs reverts `BadTerms`; with 104 one-hour epochs, all unsettled, `close` (one checkpoint booking every epoch, then 104 settles, each poking the position) uses **8,610,615 gas**, under 16,777,216; `settled == 104`.

The matching worst case for swaps is in the unit suite: `test_swap_afterQuietGapAcrossAllEpochs` measures 2,534,163 gas for the first swap after a quiet gap over 104 epochs.

### Coverage: post-end judging (expected to hold)

**Question.** After the mandate ends, the manager is locked out (`NotActive`), but a checkpoint still judges `[lastCheck, end)` by the state when it runs. Could a genuine move after the end re-judge the final interval and breach the manager?

**Answer: no.** Any price move needs a swap, and its `beforeSwap` checkpoints before the swap moves the price.

**Test.** `test_safe_postEndMoveCannotRejudgeFinalInterval`: keeper until 2 h before the end, warp past the end, eve moves spot to 900, the manager's rebalance reverts `NotActive`, close an hour later. The final epoch has **0** s out and is clean.

### Coverage: oracle ring buffer (expected to hold)

**Question.** Is `_twap` right after the 1,024-slot buffer wraps, at window edges, and when held history is shorter than the window?

**Test.** `test_safe_oracleWraparoundMatchesReference`: 1,200 swaps in 1,200 blocks with uneven 1 to 3 s gaps for the first 600 and 1 s gaps after (so held history, about 1,450 s, is shorter than the 1,800 s window), each to a pseudo-random tick. A brute-force reference (`_refTwap`) re-derives the truncated recorded ticks and integrates them with floor division. The TWAP matches exactly every 97 swaps, on each of the last 9, and after quiet gaps of 0, 1, 7, 600, 1,799 and 1,801 s.

## Re-audit Round

The re-audit targeted the round-1 fixes: the anchor, `minHalfWidth`, `minFee`, the same-block rules, the grow rule and the truncated oracle. Its fixes are in commit `292b979`; the redeployed hook is the one at the top of this file.

### High-1 (R-1): Growth at a stale TWAP

**Attack.** The grow rule trusts the TWAP as fair. After a real market move, the pool hasn't traded yet, so spot == TWAP == the old price and growth is allowed. A manager who knows about the move grows the whole inventory into its path at the stale price, then arbitrages it to the new market itself. The treasury sells its whole side at the pre-move price.

**Fix.** `GROW_BPS`: growth is at most 5% per rebalance and at most once per TWAP window (`GrowTooFast`). What's left is re-ranging into the jump's path at the same size, which no on-chain rule can tell apart from an honest re-range. It is documented as a known limit and pinned by bounds.

**Tests and measured numbers.**

`test_limit_managerPlacesAtStalePriceAfterJump` (R-1a): a calm hour (spot == TWAP == 0), then the market jumps between two blocks. Compared with an ordinary arbitrageur trading the same jump against the untouched position:

| Jump | Plain arbitrageur's take | Manager's take (re-place at stale price, then arb) | Treasury's extra loss | Bound asserted |
|---|---|---|---|---|
| 10% (1,000 ticks) | 2.2448 | 2.7850 | **0.5402** (was about 1.76 before the growth cap) | <= 0.6 |
| 35% (3,000 ticks) | 9.9457 | 15.2295 | **5.2838** | <= 5.5 |

Of a 200-token inventory. The manager stays clean and keeps its bond in both runs.

`test_limit_managerOwningBlockBoundaryPlacesAtLaggingTwap` (R-1b): a gradual move to 1,000 that the market holds; 15 minutes later the TWAP lags at about 500. Last in block N the manager sells spot down to the TWAP; first in block N+1 it grows around the stale TWAP and buys back up to the market.

| Measured | Value |
|---|---|
| TWAP at block N+1 | 510 |
| spot - TWAP | -1 (inside `MAX_GROW_GAP`, so growth is legal) |
| Managed liquidity after the grow | 1,050e18 (was 1,997e18 before the cap) |
| Manager P&L at market | **0.4358** (was 1.02 before the cap) |
| Asserts | liquidity <= 1,050e18; gain <= 0.5; manager clean, bond intact |

### Medium-1 (R-3): One-tick nudge vetoes every repair

**Attack.** The round-1 rule "no rebalance once the price moved this block" compared spot with the block's opening tick exactly. A one-tick swap ordered ahead of the manager's rebalance reverted it with `SameBlock`. After a genuine 9% move takes the TWAP out of an honest manager's range, the griefer (the treasury, who gets the bond, or anyone) nudges the price one tick at the top of every block, every repair reverts, and the manager is breached for dust. Ordinary swap flow does the same to a manager who doesn't win top of block.

**Fix.** Only growth needs an unmoved block. Shrinking or re-ranging at the same size is symmetric (the push and push back meet the same liquidity), so an in-block move doesn't block it.

**Test.** `test_R3_oneTickNudgeVetoesEveryRepair`: the market moves to 900; for 110 minutes the griefer nudges 900/901 at the top of every block in which the manager is out of range, and the manager tries a same-size repair each time.

| Measured | Value |
|---|---|
| Repairs vetoed by `SameBlock` | **0** |
| Epoch 0 out-of-compliance | **420** s (7 minutes, of 72 allowed) |
| Griefer's cost | 0.00037 tokens |
| Bond to the treasury | 0 |
| Asserts | epoch 0 clean |

### Medium-2 (R-4): Thin anchor and depth floor

**Attack.** Round 1 required only `anchorLiquidity > 0` and `minLiquidity > 0`, and the C-2 safety margin was about 2x at the audited configuration. A treasury that set the anchor at 10% of value and the depth floor at 25e18 (both plausible) made the drag-and-extract profitable at 12-second blocks, with the manager staying clean.

**Fix.** `MIN_ANCHOR_BPS = 1900`: `createMandate` reverts `ThinAnchor` unless the anchor is worth at least 19% of the deposit at the opening price. 19% rather than 20% so the audited 20% configuration passes after rounding.

**Test.** `test_R4_dragProfitableWithThinnerAnchorAndFloor`: a 10e18 anchor reverts `ThinAnchor`. With the thinnest legal anchor (20e18) and the thin 25e18 floor, the smarter drag at X = 300:

| Measured | Value |
|---|---|
| Drag cost | 1.2686 |
| Extracted | 0.0101 |
| Manager profit | **-1.2586** (cost about 126x the extraction) |
| Asserts | cost > gain; the manager stays clean and keeps its bond |

### Low-1 (R-2): Volatility an honest manager can't answer

**Finding.** While spot runs more than `maxTickDeviation` from the TWAP, every rebalance reverts `SpotOffTwap`, but the TWAP is already out of the range, so that time counts against the manager. After a 30% swing, the TWAP leaves a ±600 range long before it comes within 100 ticks of spot: about 23 minutes out per swing that the manager cannot avoid.

**Decision: kept.** Allowing a rebalance at any spot-TWAP gap would let a manager push spot past its range, re-range into the push path and sell back into the treasury: C-1 again. Managers of volatile tokens keep wide ranges; treasuries size `maxTickDeviation` and `uptimeBps` for the token.

**Test.** `test_limit_honestManagerBreachedByVolatilityItCannotAnswer`: swings to -3,000, 0, -3,000, 0, two hours apart. An honest manager checks every minute and re-ranges around both spot and TWAP (± 300) the first minute it may.

| Measured | Value |
|---|---|
| Rebalances refused, all by `SpotOffTwap` | **94** |
| Epoch 0 out-of-compliance | **5,880** s (98 minutes, of 72 allowed) |
| Asserts | every refusal is `SpotOffTwap`; the epoch is breached (documented) |

### Low-2: Wrong drag factor in the README

The root README's claim for how dragging scales on 1-second blocks overstated the cost. On 1-second blocks the 1,024-slot oracle holds about 17 minutes while the drag swaps every block, so the per-window factor is about 7, not 12. Corrected in the README; there is no test for a documentation fix.

### Coverage: a smarter C-2 drag (expected to hold)

**Question.** The C-2 test's drag keeps the managed position in the push path. Is a cheaper drag profitable?

**Variant.** Keep the managed position at the narrowest range `[-240, 240)`, so above 240 only the anchor resists (the TWAP leaves the range for part of the window, inside the allowance), and extract with a range spanning the whole dragged band `[0, X + 200)` instead of the narrowest one.

**Test.** `test_safe_smarterC2DragStillLoses`:

| X (ticks) | Drag cost | Extracted | Cost / extracted |
|---|---|---|---|
| 200 | 2.0689 | 0.0119 | ~174x |
| 300 | 3.2904 | 0.0272 | ~121x |
| 600 | 5.8316 | 0.1107 | ~53x |

Asserts cost > gain at every X. With the C-2 table this gives the 53x to 349x range the root README quotes.

### Coverage: anchor fees never pay the manager (expected to hold)

**Test.** `test_safe_anchorFeesNeverPayTheManager`: two runs with the same managed-range path. Run B also trades five round trips to tick 3,000 (outside the managed range, anchor only) within one block. The manager's pay is identical in both runs; the treasury's take at close is larger in run B.

### Coverage: final-epoch breach bond goes out once (expected to hold)

**Test.** `test_safe_finalEpochBreachBondGoesToTreasuryOnce`: a genuine move to 2,000 late in the last epoch; the passive manager doesn't follow. At close, epoch 1 is clean and epoch 2 breached; the treasury is owed exactly 10e18; the manager is owed only pay (< 1e18) and no bond; the hook's balance is exactly what it owes.

## What These Results Mean, and Don't

- The attack costs are measured against an arbitrageur who restores the market price first thing every block, on 12-second blocks. If nobody arbitrages the pool, holding a price costs nothing and any TWAP can be dragged. The anchor makes holding cost; arbitrage collects that cost.
- On 1-second blocks the drag factor is about 7, not 12.
- Two findings remain as documented limits, not fixes: an informed manager placing into a known jump (High-1, bounded by the growth cap) and fast trends breaching honest managers (Low-1).
- The safety margins scale with the anchor's size and `minLiquidity`. The anchor is floored at 19%; `minLiquidity` is not floored beyond `> 0`, and R-4 shows the 20% anchor still holds with a 25e18 floor.

The hook's full list of known limits is in [`../../src/README.md`](../../src/README.md#known-limits) and the root [README](../../README.md#known-limits). The other suites are in [`../README.md`](../README.md).

Not audited by a third party. Testnet only.
