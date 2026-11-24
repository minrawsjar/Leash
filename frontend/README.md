# Frontend: Landing Page, App and AI Drafter

> **Vite, React 19, TypeScript and viem. Deployed on Vercel at [leash-khaki.vercel.app](https://leash-khaki.vercel.app); the app is at [/app](https://leash-khaki.vercel.app/app).**

One Vite project with two pages and one server function. The landing page at `/` explains Leash to a treasury lead or a market maker in one scroll. The app at `/app` lists every mandate on the Leash hook, shows each one live, and makes every write a treasury, a manager or a keeper needs: post a mandate, bid a bond, rebalance, set the fee, checkpoint, settle, close and claim. The server function at `/api/draft` turns a plain-language description of a mandate into a filled form; it never signs anything. The contract itself is documented in [../src/README.md](../src/README.md), its addresses in [../deployments/README.md](../deployments/README.md).

## Pages

| Source | URL | Purpose |
|---|---|---|
| [`src/site/`](src/site/README.md) | [/](https://leash-khaki.vercel.app) | The landing page: animated hero, the five-scene story, the attack and its defences, live proof |
| [`src/app/`](src/app/README.md) | [/app](https://leash-khaki.vercel.app/app) | The app. Hash routes inside it: `#/` explorer, `#/create`, `#/create/ai`, `#/m/<poolId>/<tab>` |
| [`api/draft.ts`](api/README.md) | `POST /api/draft` | The AI mandate drafter (OpenRouter), server-side only |

Both pages are the same `index.html` and the same bundle entry ([`src/main.tsx`](src/main.tsx)). There is no router dependency.

## Where the Frontend Gets Everything

Nothing in the app is simulated or served by a backend of ours. Every number is read from the chain.

| Piece | Source |
|---|---|
| **Hook and PoolManager addresses, deploy block** | `../deployments/1301.json` and `../deployments/31337.json`, imported at build time by [`src/app/chain.ts`](src/app/chain.ts) |
| **Leash ABI** | `../deployments/abi/Leash.json`, imported at build time, plus v4-core's error signatures added by hand in `chain.ts` |
| **Which mandates exist** | `MandateCreated` events from the hook, read over RPC with `eth_getLogs` |
| **A mandate's state** | `mandate`, `twapTick`, `currentEpoch`, `compliance` on the hook; slot0 from the PoolManager via `extsload` |
| **Epochs, refunds, track records** | `epochRecord`, `owed`, `records` on the hook |
| **Token names and decimals** | `symbol` and `decimals` on each ERC-20 |
| **Writes** | The browser wallet (`window.ethereum`), always simulated first |
| **The AI draft** | `POST /api/draft`, which calls OpenRouter with a key that only the server holds. The draft fills the form; the person signs |
| **Landing page numbers** | Written into the page from the repo README and `Leash.sol`. The hero and story animations are illustrative and say so |

The full table of which on-screen number comes from which read is in [src/app/README.md](src/app/README.md#where-every-number-comes-from).

## Folder Structure

```
frontend/
├── index.html                  # The one HTML page: fonts, meta, #root, loads src/main.tsx
├── package.json                # react, react-dom, viem, zod; dev: vite, typescript, @vitejs/plugin-react
├── tsconfig.json               # Strict; covers src/, api/ and vite.config.ts; noEmit
├── vite.config.ts              # React plugin, the dev /api/draft middleware, base './', fs.allow ['..']
├── vercel.json                 # Rewrites /app and /app/* to index.html
├── public/
│   └── favicon.svg             # The mark, as the tab icon
├── api/                        # Server-side only, see api/README.md
│   ├── draft.ts                #   POST /api/draft: Vercel function and the dev middleware's handler
│   ├── draft.test.ts           #   node api/draft.test.ts: error paths, request shape, sample through plan()
│   └── draft.sample.json       #   A recorded draft the test and screenshots use
└── src/
    ├── main.tsx                # Picks the page from the path; lazy-loads the app
    ├── theme.css               # Design tokens and the few global rules
    ├── Mark.tsx                # The Leash logo (SVG), used by both pages
    ├── AttackChart.tsx         # Fig. 1 on the landing page: a one-block push against a 30-block TWAP
    ├── legacy-termsheet.tsx.txt# An earlier landing page, kept as text so it is not compiled
    ├── site/                   # The landing page, see src/site/README.md
    │   ├── Site.tsx            #   All the markup
    │   ├── motion.ts           #   Wires the motion once the markup is in; one cleanup for React
    │   ├── hero.ts             #   The hero canvas: a 24-second mandate loop over a scrolling ledger
    │   ├── story.ts            #   The story canvas: five scenes the scroll plays
    │   ├── site.css            #   Scoped under .site
    │   └── BRIEF.md            #   The page's working brief
    └── app/                    # The app, see src/app/README.md
        ├── App.tsx             #   Shell, network picker, wallet button, hash router
        ├── Index.tsx           #   #/  the mandate explorer
        ├── Create.tsx          #   #/create  the term sheet and the AI assistant panel
        ├── Mandate.tsx         #   #/m/<id>/<tab>  dashboard, auction, manager console, settle
        ├── Chart.tsx           #   Spot, TWAP and the manager's range, as a live SVG
        ├── plan.ts             #   Form to createMandate arguments, with every check in words
        ├── actions.ts          #   Every write, simulate first; reverts in plain words
        ├── chain.ts            #   Networks, ABI, clients, reads, log scanning, formatting
        ├── wallet.ts           #   The injected wallet: connect, follow, switch chain
        ├── ui.tsx              #   Shared pieces: Ticker, Dot, Act, usePoll, useClock
        ├── verify.ts           #   Drives every write against a local chain and checks it
        ├── app.css             #   Scoped under .lx
        └── BRIEF.md            #   The app's working brief
```

`dist/` is the build output and is ignored by git. `tsconfig.tsbuildinfo` is written by `tsc -b` and is not part of the source.

## Files at the Top of `src/`

### `main.tsx`

Two pages without a router. It reads `location.pathname`, strips one trailing slash, and checks whether the path ends in `/app`. If it does, it renders `<App />`; otherwise `<Site />`. Both are wrapped in `StrictMode`.

`Site` is imported statically. `App` is imported with `React.lazy(() => import('./app/App'))` inside a `Suspense` with no fallback, so the app's code, its CSS and viem are a separate chunk (`dist/assets/App-*.js`) that the landing page never downloads. `theme.css` is imported here, so both pages share the tokens.

Because the page is chosen by path suffix, the app also works when the build is served under a sub-path (for example `/Leash/app`).

### `theme.css`

The design tokens, on `:root`, and the handful of global rules (box sizing, the ink background on `html` and `body`, link colour, the focus ring). Every other rule lives under `.site` or `.lx`.

| Token | Value | Use |
|---|---|---|
| `--ink` | `#0b0d1f` | The ground: deep indigo, never black |
| `--surface`, `--raised`, `--lift` | `#11142b`, `#181c3a`, `#222749` | Panels, one step lighter each |
| `--cream` | `#eef0ff` | Text |
| `--muted`, `--faint` | `#a3a8c9`, `#6c7199` | Quiet text, then quieter |
| `--line` | `rgba(238, 240, 255, 0.12)` | Hairlines |
| `--mint`, `--soft` | `#4ef0b0`, `#9ff7d3` | The one bright mark; its softer form is the focus ring |
| `--violet` | `#8b7bff` | The manager and the bond, sparingly |
| `--rose` | `#ff5d8f` | A breach or a slash, nothing else |
| `--display`, `--mono` | Poppins, JetBrains Mono | Loaded from Google Fonts in `index.html` |
| `--gutter` | `clamp(20px, 5.5vw, 88px)` | Page side padding |
| `--ease` | `cubic-bezier(0.2, 0.7, 0.2, 1)` | The one easing curve |
| `--nav-h` | `88px` | Height reserved for the floating nav |

`color-scheme: dark` is set; there is no light theme.

### `Mark.tsx`

The logo as an inline SVG component: a mint rounded square with a handle loop, a slack lead and a snap clip drawn in `--ink`. It takes a `size` (default 28) and is `aria-hidden`, so every use sits next to the word "leash" or inside a labelled link. The landing nav, the footer, the phone mock-up on the landing page and the app's top bar all use it. `public/favicon.svg` is the same drawing.

### `AttackChart.tsx`

Fig. 1 in the landing page's "Withdrawal was never the risk" section. A static SVG drawn from illustrative data computed at module load: 48 blocks of spot price wobbling around 1.00, pushed to 0.86 for one block at block 30, with a 30-block moving average and a ±1% band around it. The TWAP barely moves, so a cross marks the push and the label reads "rebalance() refused: price pushed 14% for one block". It has `role="img"` and an `aria-label` that says the same in words. Its styles (`.chart`, `.band`, `.spot`, `.twap`) are in `site/site.css`.

### `legacy-termsheet.tsx.txt`

The first landing page, from before the current design. It is kept with a `.txt` extension so TypeScript and Vite ignore it. Nothing imports it.

## Build and Config

### `vite.config.ts`

- **Plugins:** `@vitejs/plugin-react`, and a small plugin named `leash-api` that only runs in `npm run dev`. Its `configureServer` hook mounts the same handler Vercel runs, `api/draft.ts`, at `/api/draft` on the dev server. It reads `OPENROUTER_API_KEY` with `loadEnv(mode, <repo root>, '')` from the repo root's `.env` and passes it to the handler as an argument. The key stays in the Node process: it is not `VITE_`-prefixed, so Vite never puts it in the client bundle.
- **`base: './'`:** asset URLs in `index.html` are relative (`./assets/index-*.js`), so the same build works from `/`, from `/app`, or under a sub-path.
- **`server.fs.allow: ['..']`:** `src/app/chain.ts` imports `../../../deployments/*.json`, which sits outside `frontend/`. Vite's dev server refuses files outside the project root unless they are allowed; this allows the repo root.

### `vercel.json`

```json
{ "rewrites": [
  { "source": "/app", "destination": "/index.html" },
  { "source": "/app/:path*", "destination": "/index.html" }
] }
```

`/app` has no file of its own, so Vercel serves `index.html` there and `main.tsx` renders the app. Routes inside the app are hashes (`/app#/m/0x…`), which never reach the server. The asset URLs are relative, so from `/app/` they would resolve to `/app/assets/…`; `vercel.json` therefore redirects `/app/` to `/app`.

`api/draft.ts` needs no entry here: Vercel turns every file in `api/` into a Node function by itself.

### `tsconfig.json`

Strict, `noUnusedLocals`, `noUnusedParameters`, `isolatedModules`, `noEmit`, `moduleResolution: bundler`, `allowImportingTsExtensions` (the code imports `./chain.ts` with its extension so the same files run under plain `node`), and `resolveJsonModule` for the deployments. It includes `src`, `api` and `vite.config.ts`.

## Environment Variables

Names only. Values live in the repo root `.env` (local) or the Vercel project settings (production), never in git.

| Name | Where it is read | Who sees it |
|---|---|---|
| `OPENROUTER_API_KEY` | Dev: `vite.config.ts` from the repo root `.env`. Production: `process.env` inside the `api/draft.ts` function | The server only. It is not `VITE_`-prefixed, so it is never in `dist/`. Without it, `/api/draft` answers 503 and the rest of the app works |
| `VITE_UNICHAIN_RPC` | `src/app/chain.ts`, as `import.meta.env.VITE_UNICHAIN_RPC` | Everyone: `VITE_` variables are compiled into the bundle. Optional; when set it is tried first, before the three public Unichain Sepolia RPCs. Do not put a URL with a private key in it |

Vite reads `VITE_` variables from `frontend/` (the project root), not the repo root, so a local `VITE_UNICHAIN_RPC` goes in `frontend/.env` or the shell.

## Setup

From the repository root:

```bash
cd frontend
npm install
```

### Against Unichain Sepolia

```bash
npm run dev
```

Opens at [http://localhost:5173](http://localhost:5173). The landing page is `/`, the app `/app`. On `localhost` the app picks the local chain by default; choose Unichain in the network picker, or open `/app?chain=1301`. The choice is remembered in `localStorage` (`leash.chain`).

### Against a local chain

```bash
# terminal 1, from the repo root: fresh anvil with Uniswap v4, two mock tokens, Leash and one live mandate.
# Writes deployments/31337.json and deployments/abi/Leash.json.
./scripts/local.sh

# terminal 2
cd frontend && npm run dev
```

Import one of anvil's dev keys into the browser wallet to sign. The deployment lists the treasury, two managers and a swapper under `accounts`.

### AI drafter in dev

Put `OPENROUTER_API_KEY` in the repo root `.env` and restart `npm run dev`. The dev server serves `POST /api/draft` from `api/draft.ts`. See [api/README.md](api/README.md).

### Build, typecheck, tests

```bash
npm run build                                       # tsc, then vite build into dist/
npm run preview                                     # serve dist/ locally
npx tsc -b --noEmit                                 # typecheck only
node api/draft.test.ts                              # the drafter, with a stand-in fetch: no key, no network
node --experimental-strip-types src/app/verify.ts   # every app write against a fresh ./scripts/local.sh chain
```

`npm run preview` does not serve `/api/draft` (the `leash-api` plugin hooks only the dev server); use `npm run dev` for the drafter. `/app` still works in both, through Vite's own HTML fallback rather than `vercel.json`.

## Deploying on Vercel

1. Import the repository. Set **Root Directory** to `frontend`.
2. Turn on **Include files outside the Root Directory in the Build Step**. The build imports `../deployments/*.json`; without this setting those files are missing and the build fails.
3. Framework preset: Vite. Build command `npm run build`, output directory `dist` (the preset's defaults).
4. Add `OPENROUTER_API_KEY` under Environment Variables for Production (and Preview if previews should draft). Optionally add `VITE_UNICHAIN_RPC`.
5. Deploy. Vercel serves `dist/` as static files, applies `vercel.json`'s rewrite for `/app`, and builds `api/draft.ts` into a Node function at `/api/draft`.

After a deploy, check that no key reached the bundle:

```bash
grep -r "sk-or-" dist/ && echo "KEY IN BUNDLE" || echo "clean"
```

## Rules the Frontend Keeps

- **No keys in the client bundle.** The OpenRouter key is read only on the server (the Vite dev process or the Vercel function). Nothing secret is `VITE_`-prefixed.
- **Nothing simulated.** Every number in the app is read from the chain: a contract view, a storage slot or an event. Prices and token amounts derived from ticks are floats for display only; the chain decides.
- **Nothing signed for you.** The AI draft fills the form, then goes through the same checks as a hand-typed value. Every write is a wallet signature the person makes, and each is simulated first so a revert costs no gas.
- **No backend.** The app talks to public RPCs and the browser wallet. The only server code is the drafter.
- **Scoped CSS.** The landing page's rules live under `.site`, the app's under `.lx`. Only `theme.css` is global.
- **Reduced motion is respected** on both pages: see [src/site/README.md](src/site/README.md#reduced-motion) and the `.lx` rule in `app.css`.

## Tech Stack

| Technology | Purpose |
|---|---|
| **Vite 8** | Dev server, the dev `/api/draft` middleware, build |
| **React 19** | Both pages; the app is a lazy chunk |
| **TypeScript 7** | Strict; the app's chain code also runs under plain `node` |
| **viem** | Public and wallet clients, fallback transport, multicall, ABI decoding |
| **zod** | The drafter's response schema and its JSON Schema |
| **Canvas 2D, SVG** | The landing page's hero and story, the app's chart |
| **OpenRouter** | The drafter's model, called from the server |
| **Vercel** | Static hosting and the `/api/draft` function |
