# Leash dApp brief (round 2)

The app at `/app`: every Leash mandate, live, and every write a treasury, manager or keeper makes.

## Screens (hash routes)
- `#/` mandates index: MandateCreated logs → snapshot per mandate (status, pair, bond, epoch, 3 compliance dots).
- `#/m/<poolId>` dashboard: stats, live chart, compliance + glide bar, ledger, epoch timeline, activity, terms.
- `#/m/<id>/auction`: open → bid form; closed → result card. Bid history newest first; claimable balances listed
  separately (owed mixes refunds, returned bonds and pay, so never pin it to one bid row).
- `#/m/<id>/manage`: range picker around the TWAP, every rebalance guard as a live check, setFee.
- `#/m/<id>/settle`: checkpoint, settle next epoch, close (treasury), claim, track records.
- `#/create`: all 16 Terms, presets, checks mirrored in `plan.ts`, review of the exact args, free-tick-spacing offer.

## Data flow
- `chain.ts` reads; `actions.ts` writes (simulate → write → wait, `explain()` for reverts); `plan.ts` create math;
  `verify.ts` drives every write on a fresh local chain via the same functions (31 checks, all pass).
- slot0 via `PoolManager.extsload` (pools slot 6), with `blockNumber` for chart backfill.
- Logs: anvil getLogs; Unichain Sepolia via Blockscout (RPC caps getLogs at 1000 blocks). Verified: empty state renders.

## Rules learned
- anvil only mines on demand: local "now" = max(last block ts, wall clock), in snapshot AND in create's auctionEnd.
- Chart frames price action + the must-cover band; the manager's range is a clipped background band. Framing on
  the full range squashed the lines flat.
- Disabled buttons must look disabled (raised grey), not a dimmed mint that reads as enabled.
- Checks: wrap text in one span, or inline code pieces become flex items and wrap per word on phones.
- Phone screenshots: headless iframe + virtual time never finishes loading; use the CDP script (scratchpad cdp.mjs,
  Emulation.setDeviceMetricsOverride 390) with a real wait.
- Numbers cross-checked with `cast call`: twapTick, compliance stableBps 5306, epochRecord(0), owed, idle — all match.

## Next fixes (round 3)
- Manager console: liquidity as "% of current" with the raw value secondary; picker labels collide with the band.
- Create on phone: the review/problems sit below a long form — add a sticky one-line status near the top.
- Activity feed: block numbers only; add relative time.
- Re-run verify.ts after UI changes (needs a fresh local.sh).
