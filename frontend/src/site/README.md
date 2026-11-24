# Site: The Leash Landing Page

> **React 19 markup, hand-written Canvas 2D and CSS motion, no animation library. Deployed on Vercel at [leash-khaki.vercel.app](https://leash-khaki.vercel.app).**

The page at `/`. It makes a treasury lead or a market maker understand Leash in one scroll: a treasury hires a market maker without handing over the keys, a Uniswap v4 hook holds the tokens, checks every swap against its own TWAP, pays a clean epoch and slashes a breach. Every claim on the page is traceable to the repo README or `Leash.sol` ([../../../src/README.md](../../../src/README.md)). The art is abstract on purpose: a price line, a TWAP, a range band, liquidity bars and a violet bond. The hero and story animations are illustrative, and the page says so. Every "Launch app" link goes to the app, documented in [../app/README.md](../app/README.md); the project setup is in [../../README.md](../../README.md).

## Sections

In page order, all in [`Site.tsx`](Site.tsx).

| Section | Id | What it shows |
|---|---|---|
| **Nav** | `#nav` | A floating bar: the mark and "leash", Protocol and Resources dropdowns, "Launch app". On phones the menus fold into a sheet behind a toggle. A "Skip to how it works" link comes first for keyboard users |
| **Hero** | `.hero` | The headline "Keep the leash." rising word by word, the lede, "Launch app" and "How it works", a "Live: Unichain Sepolia, source verified" link to the hook on Blockscout, and the hero canvas behind it all ([`hero.ts`](hero.ts)) |
| **Story** | `#story` | Five pinned scenes the scroll plays on one canvas ([`story.ts`](story.ts)), each with a label, a title and one paragraph: 01 Deposit ("Tokens in. Keys kept."), 02 Auction ("Bid a bond to run it."), 03 Manage ("Two verbs. No withdraw."), 04 Every swap checked ("Every swap reads the terms."), 05 Settle ("Clean pays. Breach slashes."). A rail on the side fills as each scene plays |
| **Tour** | `#tour` | "Run it. Never hold it.": a phone mock-up of a mandate dashboard that cycles through three screens (home, rebalance review, rebalanced), and four tiles: bonds in the stablecoin, the fee inside floor and cap, compliance counted in seconds, a public track record |
| **Defences** | `#defences` | "Withdrawal was never the risk.": the mispricing attack in four steps beside Fig. 1 ([`../AttackChart.tsx`](../AttackChart.tsx)), then six cards with small line drawings: rebalance guard, permanent anchor, sandwich guards, truncated oracle, 5% growth cap, grief guard |
| **Facts** | `#facts` | "Nothing to trust.": four numbers that count up on reveal. 2 verbs a manager has, 0 functions that pay inventory to a manager (counting down from 9), 50 ticks a second the oracle can move, 5% the position can grow per TWAP window |
| **Proof** | `#proof` | "On chain, in the open.": the live hook address with a Blockscout link, the audit and re-audit findings as written in the repo README, a ring of the four terms every swap checks (in range, depth, pace, fee), and a strip of example events that slides without a seam |
| **Final** | `#final` | "Hire them. Keep the leash." with "Launch app" and a note that test tokens have no value |
| **Duo** | | Two cards: "Run a treasury?" (Post a mandate) and "Make markets?" (Bid for a mandate) |
| **Footer** | `#footer` | The mark, section links, app links, and GitHub, `Leash.sol` and Blockscout |

The hook address (`0xbB07…6880`), the repo, the `Leash.sol` link and the Blockscout link are constants at the top of `Site.tsx`. `APP` is `./app`, relative, so the links work under any base path.

## How the Page Is Put Together

`Site` renders the markup once. A `useEffect` calls `mount(root)` from [`motion.ts`](motion.ts) and returns its cleanup, so React owns the DOM and `motion.ts` owns everything that moves. Every listener `mount` adds hangs off one `AbortController`, so the cleanup (and React StrictMode's second mount in dev) drops them all at once.

## Files

### `Site.tsx`

All the markup and the page's static data: the six defence cards (`DEFENCES`) with their icons (`ICONS`, small SVG drawings in the page's own vocabulary: a range, a line, bars), the event strip (`FLOW`), the phone's three screens, the tour tiles, the facts, the proof cards. Elements that should appear on scroll carry `data-reveal`; numbers that count carry `data-count` (and optionally `data-from`, `data-suffix`). Entrance delays are CSS custom properties set inline (`--d`, `--i`).

### `motion.ts`

`mount(root)` wires, in order:

1. **Reduced motion.** `reduced` is true under `prefers-reduced-motion: reduce` or with `?still` in the URL. It adds the `reduced` class to the root.
2. **Hero.** `mountHero()` with `reduced` and, from `?t=<seconds>`, a frozen time.
3. **Story.** Normally: one canvas pinned in a sticky stage. On every scroll and resize it computes the story section's scroll progress, maps it to a scene (five equal stretches) and a progress inside that scene, and plays each scene over 6% to 84% of its stretch so it holds finished before the next one starts. The stage's colours blend from the previous scene's theme to the next over the first 10% of each stretch (themes in order: dark, violet, cream, mint, dark), set as CSS variables on the stage and passed to the canvas. The active step's text and the rail's fill follow.
4. **Phone.** Cycles the tour phone's `data-screen` between home, send and sent every 2.8 s (not under reduced motion). Each event-strip row is cloned once so sliding it by half loops without a seam.
5. **Nav menus.** Hover (on hover-capable screens wider than 860px) or click opens one panel; leaving closes it after 180 ms unless the pointer reaches the panel. Escape closes and returns focus to the trigger; a click outside closes. The phone sheet has its own toggle and closes when a link in it is followed.
6. **Reveals and counters.** One `IntersectionObserver` (threshold 0.15) adds `is-in` to each `[data-reveal]` the first time it shows and starts its counters (1.1 s, ease-out cubic).
7. **Screenshots.** `?shot=<id>` scrolls to that section with every reveal already shown; `?shot=story-<x>` scrolls to scene position `x` (0 to 5) inside the story.

It returns one cleanup that stops the hero, destroys the story canvases, clears the phone timer, disconnects the observer and aborts every listener.

### `hero.ts`

One canvas behind the hero copy. `mountHero(hero, canvas, { reduced, freeze })` returns a cleanup.

- **Behind:** the pool's ledger scrolls up slowly: rows of made-up hook activity (swaps checked, keeper checkpoints, rebalances, `setFee`, epoch settlements), generated from a fixed seed so every visit shows the same rows. A gradient fades it out on the left (on phones, at the chart's bottom edge), and a soft ink panel sits between the ledger and the chart so the lines stay legible.
- **In front:** a mandate on a 24-second loop, precomputed once at 30 samples a second. In epoch 1 the spot wanders inside the manager's range and one block's hard push (at 4.4 s) barely moves the TWAP; the epoch settles clean. In epoch 2 the market moves and the manager does not follow: the TWAP leaves the range and out-of-compliance time builds until settlement slashes the bond and fires the manager. After that only the anchor is left, liquidity at every price, until the next mandate's range goes up. The oracle is truncated the way Leash truncates it (it moves at most a fixed step per sample toward spot, standing in for 50 ticks a second), and the TWAP averages it over a trailing window; two passes make the loop start warm and join without a seam.
- **At the head:** a depth profile (anchor bars at every price, the managed block inside the band) and the violet bond pill.
- **Timing:** the live loop opens at second 3, calm and in range, with the push still ahead. It runs on `requestAnimationFrame` only while the hero is on screen (an `IntersectionObserver` starts and stops it). A `ResizeObserver` redraws at the new size, with the device pixel ratio capped at 2. Fonts loading triggers one more resize so the labels measure correctly.
- **Still:** under reduced motion the hero draws one frame at 7.2 s and never animates; with `?t=<seconds>` it draws that second instead.

### `story.ts`

One canvas, five scenes, each drawn from a progress `p` between 0 and 1:

| Scene | What it draws |
|---|---|
| `deposit` | The treasury's tokens fall into the hook: the anchor at every price, then the opening position |
| `auction` | Bonds outbid each other; outbid bonds become claimable; the highest holds the mandate |
| `manage` | The manager's two verbs: rebalance moves the block, `setFee` moves inside floor and cap; no withdraw |
| `checks` | Every swap: in range, depth, pace; time booked in or out of compliance |
| `settle` | One clean epoch pays, one breached epoch slashes |

`createStory(canvas)` returns `set(scene, p)`, `setTheme(theme)`, `redraw()` and `destroy()`. It draws only when told to, so it costs nothing while the page is still. It also exports the four `THEMES` (dark, violet, cream, mint, built from the same colours as `theme.css`), `blendTheme()` to mix two of them, and `css()` to turn a colour into an `rgba()` string.

### `site.css`

Every rule is scoped under `.site`, because the app ships in the same bundle and global rules would leak into it. It uses only the tokens in [`../theme.css`](../theme.css): the ink ground, the mint mark, violet for the manager and the bond, rose for a breach only. Type: Poppins 800 uppercase for display, tight tracking; JetBrains Mono for small uppercase labels. The layout holds at 390px wide with no horizontal scroll and gutters of at least 16px. The `.chart` rules for Fig. 1 live here too.

### `BRIEF.md`

The page's working brief: the goal, the visual rules, each section, truth notes (for example: a slash happens at epoch settlement, not instantly; after a breach there is no re-auction), how screenshots are taken over Chrome DevTools Protocol, a log of each design round, and open problems. Read it before changing the page.

## Reduced Motion

Under `prefers-reduced-motion: reduce`, or with `?still` in the URL:

- **Hero:** one still frame, no loop.
- **Story:** not pinned. Each scene becomes its own block with its own theme colours and its own canvas, stopped at its most telling moment (90 to 95% through the scene). The shared sticky canvas and the rail are hidden.
- **Entrances:** no rising words, no slide-ins; `[data-reveal]` elements only fade. Counters show their final number at once. Hover lifts on buttons and cards are off.
- **Phone and event strip:** the phone stays on its first screen, and the strip and other CSS animations stop.

These rules are in `motion.ts` (the `reduced` branches) and at the end of `site.css` (`.site.reduced …`).

## URL Parameters

| Parameter | Effect |
|---|---|
| `?t=<seconds>` | Freezes the hero at that second of its 24-second loop |
| `?still` | Reduced motion, without changing the system setting |
| `?shot=<id>` | Scrolls to a section with every reveal shown, for screenshots |
| `?shot=story-<x>` | Scrolls to position `x` (0 to 5) inside the story |

## Run It

```bash
cd frontend
npm install
npm run dev        # http://localhost:5173/
npm run build      # dist/
```

## Rules the Page Keeps

- **Every claim traceable** to the repo README or `Leash.sol`. Illustrative numbers are labelled as such.
- **Tokens only from `theme.css`.** No black, no orange, no gradient blobs, no glass, no emoji. Rose means a breach and nothing else; violet means the manager or the bond.
- **Motion by hand**, and none of it under reduced motion.
- **Scoped CSS** under `.site`.
- **Nothing runs while unseen.** The hero loop stops when it scrolls away; the story redraws only on scroll.
