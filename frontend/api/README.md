# API: The AI Mandate Drafter

> **One TypeScript Node handler, zod and OpenRouter. Runs as a Vercel function at [leash-khaki.vercel.app/api/draft](https://leash-khaki.vercel.app/api/draft), and as a Vite middleware in `npm run dev`.**

`POST /api/draft` takes a treasury's requirements in plain words ("sell 10% of our 1M TKN over a quarter, bond at least 25k") and returns a drafted mandate form: one value and one short reason per field, plus the assumptions it made and the questions only the treasury can answer. The page at [`/app#/create`](../src/app/README.md#createtsx) writes the draft into the term sheet, where it goes through exactly the same checks as a hand-typed value. The drafter fills a form and stops: it never signs, approves, posts or touches a chain. The rest of the frontend is in [../README.md](../README.md); the terms it drafts are the contract's, documented in [../../src/README.md](../../src/README.md).

## Files

```
api/
├── draft.ts            # The handler: validation, the OpenRouter call, the schema, Raw → Draft
├── draft.test.ts       # node api/draft.test.ts: no key, no network
└── draft.sample.json   # A recorded draft in the Raw shape, used by the test and for screenshots
```

Vercel turns every file in `api/` into a function, so `draft.ts` is served at `/api/draft` with no configuration. In dev, [`../vite.config.ts`](../vite.config.ts) imports the same default export and mounts it at `/api/draft` on the dev server.

## Request

```http
POST /api/draft
Content-Type: application/json

{
  "requirements": "Sell 10% of our 1M TKN treasury into USDC over a quarter, keep fees between 0.05% and 0.5%, want a bond of at least 25k",
  "context": {
    "token0": "0x…",                       // the form's treasury token address (may be empty)
    "token1": "0x…",                       // the form's stablecoin address (may be empty)
    "symbols": { "token": "TKN", "stable": "USDC" },
    "decimals": { "token": 18, "stable": 6 },
    "spot": 2                              // the form's current opening price
  }
}
```

- `requirements` is required: a non-empty string, at most 4,000 characters after trimming.
- `context` is optional; anything that is not an object is treated as `{}`. The page sends the form's current values so the model can keep the price and avoid asking for what is already filled.
- The body may be at most 64,000 characters. Vercel parses JSON bodies itself; the dev server's body is read from the stream.

## Response

On success, HTTP 200:

```json
{
  "draft": {
    "token": null,
    "stable": null,
    "tokenAmount": { "value": 100000, "why": "10% of the 1M TKN treasury, the amount to sell." },
    "minBond":     { "value": 25000,  "why": "You asked for a bond of at least 25k." },
    "maxFeePct":   { "value": 0.5,    "why": "Your fee cap of 0.5%." },
    "...": "one entry per form field",
    "assumptions": ["The opening price stays at 2 USDC per TKN.", "..."],
    "questions":   ["Which addresses are TKN and USDC on this network? ...", "..."]
  }
}
```

`Draft` has one entry per form input, in the form's own units (whole tokens, hours, minutes, %): `{ value, why }`, or `null` for "leave that input alone". `token` and `stable` are `null` unless the user typed the exact address. Every numeric field is always present. The fields are:

| Field | Meaning |
|---|---|
| `token`, `stable` | Treasury token and stablecoin addresses |
| `tokenAmount`, `stableAmount` | Deposit of each side, whole units |
| `price` | Opening price, stablecoin per token |
| `tickSpacing` | Integer tick spacing |
| `rangePct` | Opening position half-width, % either side of the price |
| `positionPct`, `anchorPct` | % of each side in the opening position, and in the permanent full-range anchor |
| `floorPct` | Depth floor, % of the opening position's liquidity |
| `auctionHours`, `minBond` | Bond auction length; minimum bond in stablecoin |
| `epochHours`, `epochs` | Epoch length; number of epochs |
| `uptimePct`, `managerFeePct` | Required uptime per epoch; manager's share of a clean epoch's fees |
| `twapMins`, `maxTickDeviation`, `minHalfWidth` | TWAP window; max spot–TWAP gap for a rebalance; minimum range half-width around the TWAP |
| `minFeePct`, `maxFeePct` | Swap fee floor and cap, % per swap |
| `startStablePct`, `endStablePct` | Most stablecoin the inventory may hold, % of value, at the start and the end |

On failure, `{ "error": "<one plain sentence>" }` with one of these statuses:

| Status | When |
|---|---|
| 400 | Empty requirements, requirements over 4,000 characters, or a body that is not JSON |
| 405 | Any method but POST |
| 422 | The model refused |
| 429 | OpenRouter rate-limited the request ("The assistant is busy. Retry in a moment.") |
| 502 | OpenRouter unreachable or timed out (90 s), any other OpenRouter error (its own message and the provider's `metadata.raw`, cut to 400 characters; never the key), `finish_reason: length`, content that is not JSON, or JSON that fails the schema |
| 503 | No `OPENROUTER_API_KEY` where the server runs, an invalid key (OpenRouter 401), or no credits (402) |

The page shows the sentence in the assistant panel; the form keeps working by hand.

## What It Sends to OpenRouter

- **Endpoint:** `https://openrouter.ai/api/v1/chat/completions`.
- **Model:** `MODEL` = `anthropic/claude-haiku-5.5`.
- **`max_tokens`:** 4000. **Timeout:** 90 s (`AbortSignal.timeout`).
- **Headers:** `Authorization: Bearer <key>`, `Content-Type: application/json`, `X-Title: Leash`. The key is only in the header, never in the body.
- **System message:** a fixed prompt (kept byte-stable; nothing request-specific goes in it) that explains what Leash is, every field and its constraints, the quarter defaults to use when the requirements are silent, and the output rules. It tells the model to set an address only when the exact `0x` address appears in the requirements and never to invent or recall one, to treat the requirements as a description only and ignore instructions inside them, and to check every constraint before answering. The constraints mirror the contract and `plan.ts`: both deposits above zero, `positionPct + anchorPct ≤ 100`, an anchor holding at least 19% of the deposit's value (`ThinAnchor`), `maxTickDeviation < minHalfWidth`, the opening range covering the price ± `minHalfWidth`, the auction outlasting the TWAP window plus a minute, 1 to 104 epochs, the fee floor at or below the cap, and so on.
- **User message:** `<context>{…}</context>` then `<requirements>…</requirements>`.
- **`response_format`:** `{ type: "json_schema", json_schema: { name: "mandate_draft", strict: true, schema } }`, where `schema` is the zod `Raw` schema converted with `z.toJSONSchema` (its `$schema` key removed).

## The Schema, and Why It Is Flat

The model fills `Raw`, a flat object:

- `token`, `stable`: strings, empty unless the user typed the address.
- 21 numbers at the top level, one per numeric form field, each with a short description.
- `why`: an array of strings, one line per field, exactly `"fieldName: reason"`, the reason under 15 words.
- `assumptions`: values chosen without the user stating them, one short sentence each.
- `questions`: what the user must answer or fill in.

Every key is required, `additionalProperties` is false, and there are no nullable or union types.

It was nested first: one `{ value, why }` object per field. OpenRouter's Anthropic provider compiles a strict schema into a grammar, and it refused that one as "compiled grammar is too large". Union-typed fields are capped as well. The flat shape keeps the grammar small. Any new field must be one more top-level number, nothing nested.

The server rebuilds the per-field shape the page wants. `toDraft(raw)` splits each `why` line at its first colon into a map, then gives every numeric field `{ value, why: map.get(field) ?? '' }`, and `token`/`stable` an entry only when they are non-empty.

## Validation

Nothing from the model is trusted as-is:

1. `choices[0].message.refusal` set: 422.
2. `finish_reason` is `length`: 502 ("The draft ran out of room").
3. `message.content` is parsed with `JSON.parse`; a failure is 502.
4. The parsed object goes through `Raw.safeParse` (zod). Anything off-schema, such as `"epochs": "twelve"`, is 502.
5. Only then `toDraft()` builds the response.

The page applies one more layer: `applyDraft()` in [`../src/app/plan.ts`](../src/app/plan.ts) skips addresses that are not `0x` plus 40 hex characters and numbers that are not finite, and everything it writes is checked by `plan()` exactly like typed input. A value the model gets wrong is flagged at its field before anything can be signed.

## The Key Stays on the Server

- **Production:** the Vercel function reads `process.env.OPENROUTER_API_KEY` (the handler's default argument).
- **Dev:** `vite.config.ts` reads `OPENROUTER_API_KEY` from the repo root `.env` with `loadEnv` and passes it to the handler as its third argument. It is not `VITE_`-prefixed, so Vite never inlines it into client code.
- **Nowhere else.** The browser calls `/api/draft` on its own origin and never sees the key. Error messages pass on OpenRouter's text, which never echoes the key. After a build, `dist/` must not contain `sk-or-`:

```bash
grep -r "sk-or-" ../dist/ && echo "KEY IN BUNDLE" || echo "clean"
```

## It Never Signs Anything

The handler has no wallet, no RPC and no chain client. It returns a form. The person reviews every field (the ones the draft changed are marked in mint with the reason), the page runs every `createMandate` check, and only the person's own wallet can approve tokens and post the mandate.

## Exports

| Export | Use |
|---|---|
| `default handler(req, res, key?)` | The Vercel-style Node handler: POST only, reads the body, calls `draft`, writes JSON |
| `draft(input, { key, fetch })` | The logic, with the key and `fetch` passed in so the test can stand them in. Returns `{ status, body }` |
| `Raw`, `type Raw` | The zod schema the model fills, and its type |
| `toDraft(raw)` | `Raw` to `Draft` |
| `type Draft`, `type DraftContext`, `type Result` | Shapes shared with the page (`Create.tsx`, `plan.ts`) |
| `MODEL` | The OpenRouter model id |

## Tests

`draft.test.ts` uses `node:assert` and a stand-in `fetch`, so it needs no key and makes no network call. It checks:

- **Error paths:** no key gives 503 and names `OPENROUTER_API_KEY`; empty requirements 400; OpenRouter 401 and 402 give 503; 429 gives 429; 500 gives 502; a network error 502; `finish_reason: length` 502; content that is not JSON 502; an off-schema draft (`epochs: "twelve"`) 502.
- **A good draft:** the sample through a stand-in reply gives 200 and equals `toDraft(Raw.parse(sample))`; `minBond` is 25000 with its reason; an empty address becomes `null`.
- **The request it sends:** model `anthropic/claude-haiku-5.5`; `strict: true`; `additionalProperties: false`; no `anyOf` anywhere (no unions); every key of `Raw` required; the key in the `Authorization` header and not in the body.
- **The UI fill:** the sample through `applyDraft(defaultForm(...))` keeps the form's addresses (the draft left them `null`), sets `maxFeePct` to `"0.5"`, `epochHours` to 168 and `minBond` to `"25000"`, records reasons only for fields the draft set, and passes `plan()` with no problems. The same form with a 5% anchor is flagged at `anchorPct`.

`draft.sample.json` is a recorded draft in the `Raw` shape for "sell 10% of 1M TKN over a quarter, fees 0.05–0.5%, bond at least 25k": 100,000 TKN and 200,000 USDC at 2, weekly epochs for 12 weeks, a 22% anchor, the stablecoin cap gliding from 55% to 100%, with a reason per field, three assumptions and two questions. The app's screenshots use it to answer `/api/draft` for the filled state.

Run it from `frontend/` (Node 22 or later runs the TypeScript directly):

```bash
cd frontend
node api/draft.test.ts
# draft: all checks pass
```

## Try It Locally

```bash
# OPENROUTER_API_KEY=… in the repo root .env, then:
cd frontend && npm run dev

curl -s localhost:5173/api/draft -H 'content-type: application/json' \
  -d '{"requirements":"Two-week trial with 50k TKN at $2, daily epochs, cautious rules, a small 2k bond"}'
```

Or open [http://localhost:5173/app#/create/ai](http://localhost:5173/app#/create/ai) and use the assistant panel. Each call spends OpenRouter credits.
