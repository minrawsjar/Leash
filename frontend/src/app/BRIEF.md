# Leash dApp brief (round 4)

The app at `/app`: every Leash mandate, live, and every write a treasury, manager or keeper makes.

## Screens (hash routes)
- `#/` mandates index: MandateCreated logs → snapshot per mandate (status, pair, bond, epoch, 3 compliance dots).
- `#/m/<poolId>` dashboard: stats (spot from sqrtPriceX96), live chart, compliance + glide bar, ledger, epochs,
  activity, terms.
- `#/m/<id>/auction`: open → bid form ("Leader + 1" preset); closed → result card. Bid history; claimable balances
  listed separately and labelled per account across all mandates (owed is not per mandate).
- `#/m/<id>/manage`: range picker around the TWAP, size as % of the current position (Floor / Keep / +5% pin exact
  bigints), every rebalance guard as a live check, setFee.
- `#/m/<id>/settle`: checkpoint, settle next epoch, close (treasury), claim, track records.
- `#/create`: all 16 Terms, presets, checks mirrored in `plan.ts`, exact-args review, free-tick-spacing offer, and on
  narrow screens a sticky "N things to fix · review" bar that scrolls to the review.

## Verification
- `verify.ts` (node, fresh local.sh): 31 checks through actions.ts/plan.ts — outbid/refund/claim, create (and thin
  anchor, duplicate pool refused), every rebalance revert decoded, setFee bounds, settle order, close, claim.
- In-browser: CDP script injects an EIP-1193 shim forwarding to anvil (unlocked dev accounts) and clicks real
  buttons: Rebalance (manager), Use free spacing + Approve and post mandate (treasury), Leader+1 + Approve and bid
  (manager #2), Checkpoint + Claim. Each confirmed with `cast call`.

## Rules learned
- anvil only mines on demand: local "now" = max(last block ts, wall clock), in snapshot AND in create's auctionEnd.
- owed[account][currency] is global to the hook: never present it as one mandate's refund.
- "Next bid from X" with X = bond + 1 wei renders as the bond itself; say "must exceed X" instead.
- Spot from the tick is floored (2 shows as 1.9998); use sqrtPriceX96 for the headline number.
- A chart with one sample draws nothing; pad it to a flat line.
- Phone screenshots: use CDP Emulation (390px), not an iframe under virtual time.

## Done in round 4
- Activity rows show relative time (block timestamps, cached per block, visible rows only).
- Settle tab puts Close first when it is the action that matters (unhired, ended, breached).
- 390px checked for index, dashboard, auction, manage, settle, create.

## Open problems
- Wallet connect itself is only exercised through an injected shim (no real extension headless).
- Unichain Sepolia has no mandates yet: only the empty state and the Blockscout log path are proven there.
- Bundle is ~615 kB (viem); split the app chunk from the landing page if load time matters.
- Fees between two settles show only once collected (contract books fees when collected, by design).
