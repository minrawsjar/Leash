# Leash dApp brief (round 1)

The app at `/app`: every Leash mandate, live, and every write a treasury, manager or keeper makes.

## Screens (hash routes)
- `#/` mandates index: MandateCreated logs → snapshot per mandate (status, pair, bond, epoch, 3 compliance dots).
- `#/m/<poolId>` dashboard: stats (spot, TWAP, bond, fee, epoch countdown), live chart (spot/TWAP/range,
  backfilled from 40 past blocks then one sample per block), compliance checks + glide bar, ledger, epoch
  timeline, activity feed, terms.
- `#/m/<id>/auction`: leader, countdown, approve+bid, bid history with each outbid bidder's claimable refund.
- `#/m/<id>/manage`: range picker around the TWAP with every rebalance guard as a live check, setFee.
- `#/m/<id>/settle`: checkpoint, settle next epoch, close (treasury), claim, track records.
- `#/create`: all 16 Terms, presets, BadTerms/ThinAnchor mirrored in `plan.ts`, review of the exact args.

## Data flow
- `chain.ts`: networks (1301, 31337), ABI from `deployments/abi/Leash.json` + v4-core errors, reads.
  slot0 via `PoolManager.extsload` (pools mapping slot 6). Logs: anvil RPC getLogs; Unichain Sepolia via
  Blockscout `/api?module=logs` (the public RPC caps getLogs at 1000 blocks).
- `actions.ts`: every write = simulate → write → wait. `explain()` turns any revert into one sentence.
- `plan.ts`: create form → createMandate args + problems. Pure, shared with `verify.ts`.
- `verify.ts`: node script driving all writes on a fresh local chain via the same functions.

## Rules learned
- anvil only mines on demand: chain "now" for local = max(last block ts, wall clock). Otherwise the
  auction countdown lies after idle time.
- Token symbols keep their case (mUSDC): no uppercase on pair names.
- Raw liquidity is shown as 1.17e18 and as "× floor"; prices with 5 significant digits.
- app.css is loaded on the landing page too (main.tsx imports both): everything is nested under `.lx`.
- Float math is display-only; the simulation is the source of truth before any signature.

## Next fixes
- Screenshot an active mandate with history (demo state script) and check numbers against `cast call`.
- Phone layout of index rows and dashboard; check 390px for every tab.
- Create: default tick spacing collides with the seeded pool on local; review shows raw minBond.
- Manager console and settle tabs not yet screenshotted.
