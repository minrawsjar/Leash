# Leash dApp brief (round 5: post a mandate)

The app at `/app`: every Leash mandate, live, and every write a treasury, manager or keeper makes.

## Screens (hash routes)
- `#/` mandates index: MandateCreated logs → snapshot per mandate (status, pair, bond, epoch, 3 compliance dots).
- `#/` takes `?who=<address>` (`#/?who=0x…`): opens filtered to mandates that address treasures or manages.
- `#/managers` leaderboard: every bidder, from Bid/EpochSettled logs + `records`. Won, clean, breached, clean rate,
  pay per token, slashed, active now; sort by clean rate or pay (valued at each pool's current TWAP).
- `#/m/<poolId>` dashboard: stats (spot from sqrtPriceX96), live chart, compliance + glide bar, ledger, keeper
  (last checkpoint age, finished-unsettled epochs, Checkpoint now / Settle next; violet warning after 5 min without
  a checkpoint on an active mandate), epochs, activity, terms.
- `#/m/<id>/auction`: open → bid form ("Leader + 1" preset); closed → result card. Bid history; claimable balances
  listed separately and labelled per account across all mandates (owed is not per mandate).
- `#/m/<id>/manage`: range picker around the TWAP, size as % of the current position (Floor / Keep / +5% pin exact
  bigints), every rebalance guard as a live check, setFee.
- `#/m/<id>/settle`: checkpoint, settle next epoch, close (treasury), claim, track records.
- `#/create`: a term sheet. Assistant panel on top, five numbered sections (01 Inventory, 02 Auction and bond,
  03 Rules the manager must follow, 04 Pay and pace, 05 Opening position), a sticky receipt with the exact call.
  Under the sheet, the backtester (backtest.ts, pure; `node src/app/backtest.test.ts`): seeded presets or pasted
  prices through a simulated TWAP, an honest manager inside the rebalance guards, and the checkpoint's both-ends
  booking. Shows the path, per-epoch dots, uptime, refusals, and breach risk over 6 seeds per preset. It says it
  is an approximation; if Leash.sol's rules change, backtest.ts changes.

## Post a mandate: rules
- It is a term sheet, not a card stack. Sections are separated by one hairline, headed by a mono uppercase label
  with its number in faint ink. No boxes around sections; only the assistant and the receipt are panels.
- Inputs are a value on a hairline: no filled grey boxes. Units sit inside the line as a quiet mono suffix
  (TKN, mUSDC, hours, min, ticks, %). The form speaks hours, minutes, %, whole tokens; plan.ts converts.
- Under a field, one line at most: the derived fact a person needs (≈ 1.00% for ticks, pips for fees, the
  closing time for the auction, the anchor's share of value). Raw liquidity and bigints live in "Exact call".
- Every field and section has an ⓘ: a native popover (`popovertarget`), aria-label "About <label>", Esc and
  click-outside close it, placed under its button and following it on scroll. 1–3 sentences: what it is, a
  typical value, what goes wrong at either end. True to Leash.sol; if the contract changes, the text changes.
- Problems show at the field (rose line + rose text) AND in the receipt, where each one is a link that focuses its
  field. plan.ts owns the checks and says which field each belongs to (`at`, `owner`); a paired check (gap vs
  half-width) gets a short field-specific message on the second field instead of the same sentence twice.
- Field errors are short and name the other number ("Must be below the minimum half-width (200 ticks)."); the
  receipt keeps the full sentence that says why. A receipt row whose value fails a check turns rose.
- Labels say which thing, not just what kind: "Token deposit" and "Stablecoin deposit", never "Deposit" twice.
- Rose is for problems only. Violet only for the bond. Mint marks what the assistant filled (a dot before its
  reason, a mint underline) and the one "all checks pass" line.

## The assistant (POST /api/draft)
- Server-side only: `frontend/api/draft.ts` (Vercel function; the dev server mounts the same handler). OpenRouter,
  model constant `MODEL` = `anthropic/claude-haiku-5.5`, strict json_schema built from the zod `Raw` schema,
  max_tokens 4000. The handler turns `Raw` into the `Draft` the page uses ({ value, why } | null per field).
- Keep `Raw` flat: numbers at the top level, reasons as "field: reason" lines, no nullable/union types. One
  {value, why} object per field made Anthropic refuse it ("compiled grammar is too large"), and union-typed
  fields are capped. Any new field is one more top-level number, nothing nested.
- Mark only what the draft changed. A mint dot on every field marks nothing. Example chips are short labels
  ("Two-week trial") that put the full request in the box; three different shapes of request, not paraphrases. Key: `OPENROUTER_API_KEY`, read from the repo root .env by vite.config.ts in dev (never
  VITE_-prefixed), from process.env in production. `dist/` must never contain `sk-or-`.
- It fills the form and stops. It never signs, approves or posts. Its output goes through applyDraft → plan(),
  so a bad value it picks is flagged exactly like a hand-typed one.
- It never sets token addresses unless the user typed them; it asks instead. Assumptions and open questions list
  under the panel. A hand edit removes that field's mint mark and reason.
- Failures are plain sentences in the panel; the rest of the page keeps working without the assistant.

## Verification
- `verify.ts` (node, fresh local.sh): 31 checks through actions.ts/plan.ts.
- `node api/draft.test.ts`: the handler's error paths with a stand-in fetch (no key → 503, 401/402/429/5xx,
  network, finish_reason length, bad JSON, off-schema), the request shape, and the recorded sample draft
  (`api/draft.sample.json`) through applyDraft and plan() with no problems.
- Screens: CDP headless Chrome, Fetch interception answers /api/draft from the sample for the filled state.

## Rules learned
- anvil only mines on demand: local "now" = max(last block ts, wall clock), in snapshot AND in create's auctionEnd.
- owed[account][currency] is global to the hook: never present it as one mandate's refund.
- "Next bid from X" with X = bond + 1 wei renders as the bond itself; say "must exceed X" instead.
- Spot from the tick is floored (2 shows as 1.9998); use sqrtPriceX96 for the headline number.
- A chart with one sample draws nothing; pad it to a flat line.
- Phone screenshots: CDP Emulation (390px), viewport shots at scroll positions; full-page captures smear the
  sticky bar. Set `scroll-behavior: auto` before scripted scrolling.
- A grid item with a nowrap row inside (the chips) needs `minmax(0, 1fr)` or it widens the whole page at 390px,
  and then every fixed-position popover is placed against the wrong width.

## Open problems
- The assistant has not yet answered one real request end to end: the first two live calls hit the grammar limit
  (nested schema, then the size check), and the flat schema is verified only against stand-ins. Next real call
  settles it; if the grammar is still too large, drop `strict` before cutting fields.
- Wallet connect itself is only exercised through an injected shim (no real extension headless).
- Unichain Sepolia has no mandates yet: only the empty state and the Blockscout log path are proven there.
- The local chain's seeded mandate sits at spacing 60, so a fresh create form opens with one problem (pool taken)
  and offers the free spacing. Correct, but it is the first thing people see.
