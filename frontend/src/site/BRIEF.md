# Leash landing site: working brief (after round 2)

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

## Rules learned
- Screenshots: plain `chrome --screenshot` of a scrolled page comes back blank, and a 9000px window makes
  100svh sections 9000px tall. Drive Chrome over CDP instead (/tmp/leash-shots/cdp.mjs: navigate, wait,
  Page.captureScreenshot). Section shots at 1440x1800, pinned/hero shots at 1440x900, phone at 390x844 with
  mobile emulation. `?shot=<id>` / `?shot=story-<x>` scroll there; `?t=` freezes the hero; `?still` = reduced.
- Hero must fit 900px tall: title clamp(64px, min(9.4vw, 15.5svh), 168px). On phones the chart is a fixed
  300px block at the top and the copy starts at 372px; the ledger fades out at the chart's bottom edge.
- The ledger behind the chart fights the lines: a soft ink panel (shadowBlur) sits between them.
- Canvas cards need fixed internal rows (px), not fractions of H, or they break at phone height.
- The SVG AttackChart scales its 11px labels with its width: cap it by putting it in a 2-column card.
- Story timing: each scene plays over 6%..84% of its stretch, so it holds finished before the next.
- Hyphenated words in h3 break badly ("re-/audited"): reword.

## Round log
- R1: everything built; story/tour/proof never seen because headless screenshots were blank.
- R2: CDP screenshots; hero sized to fit; one-block-push labels beside the spike; loop reordered so the
  next mandate's range only appears once the TWAP is home (no false rose segment at the left edge);
  settle cards rebuilt on fixed rows; auction bids stack on phones; attack steps beside the chart;
  phone screen got an activity list; final banner band moved below the copy and tiled seamlessly.

## Open problems (next round)
1. Check the nav dropdown and the phone menu sheet open (no shot yet).
2. Check reduced motion (?still): stacked scenes with still canvases.
3. Story canvas on violet/mint: managed bars and pills should read at a glance; deposit labels overlap
   bars on phones.
4. Tile art in the tour (fee slider, clock) is small for its tile; consider bigger art.
5. Hero: does the loop read without the labels? Try a live (unfrozen) shot mid-slash.
