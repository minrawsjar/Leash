# Leash landing site: working brief (round 1)

## Goal
One page at `/` that makes a treasury lead or a market maker understand Leash in one scroll, at Opaque's
quality bar (opaque.credit, source in ~/OpaqueXRPL/frontend/site). Every claim traceable to README.md or
src/Leash.sol. Abstract metaphor only: a price line, a TWAP band, liquidity bars, a violet bond.

## Rules
- Tokens from theme.css only: ink #0b0d1f ground, mint #4ef0b0 mark, violet = manager/bond, rose = breach only.
  No black, no orange, no gradient blobs, no glass, no emoji.
- All CSS scoped under `.site` (main.tsx bundles the /app page too; global rules would leak into it).
- Type: Poppins 800 uppercase display, tracking -0.045em, line-height 0.9; body 17px muted; labels in
  JetBrains Mono 500, 11-12px, uppercase, 0.14em tracking.
- Motion by hand (canvas + CSS). prefers-reduced-motion: no rise, story unpinned with still canvases.
- 390px: no horizontal scroll, 16px+ gutters.
- `?t=<seconds>` freezes the hero (README promises it); `?shot=<id>` scrolls to a section for screenshots.

## Sections
1. Nav: floating bar, brand mark + wordmark, Protocol / Resources dropdowns, Launch app (./app), mobile sheet.
2. Hero: ledger rows behind; canvas chart: spot line, TWAP, mint range band, depth profile at the head
   (anchor bars at every price + managed block in the band), violet bond pill. 24s loop, 3 epochs:
   clean (pay) -> TWAP leaves range, out-of-compliance time builds -> settle slashes the bond -> fired,
   band gone, only the anchor -> new mandate. One-block spike in epoch 1 that the TWAP ignores.
   Headline "Keep the leash." word rise.
3. Story (sticky, 5 scenes, themes dark/violet/cream/mint/dark): Deposit, Auction, Manage, Every swap checked, Settle.
4. Tour: phone with mandate dashboard + 4 tiles.
5. Defences: the mispricing attack + AttackChart + 6 cards.
6. Facts: 2 verbs, 0 withdraw paths, 50 ticks/s, 5% growth per window.
7. Proof: live address, audit numbers (as written in README), what is checked, event flow rows.
8. Final banner + duo cards (treasury / market maker) + footer.

## Truth notes
- Slash happens at epoch settlement, only if out-of-compliance time exceeds the allowance. Not instant.
- After a breach there is no re-auction; the treasury can close and take everything back.
- Fee: manager sets it between floor and cap. Pay: managerFeeBps of the epoch's LP fees (e.g. 30%).
- Hero numbers are illustrative: say so.

## Open problems
(filled after each round)
