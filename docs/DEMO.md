# Demo Video Plan (UHI11 Hookathon)

> **A video under 5 minutes (the hookathon's limit): the problem on six slides, the architecture, a live mandate on Unichain Sepolia, the attack failing in a terminal, and the verified hook. Plus a 60-second cut.**

## Before Recording

| What | How |
|---|---|
| Problem slides | The six-slide deck ("Leash: The Problem"), presented full screen. Each slide's speaker notes hold its lines below |
| Architecture | [`diagrams/leash-architecture.excalidraw`](diagrams/leash-architecture.excalidraw) opened at excalidraw.com (File › Open), zoomed to fit |
| App, treasury | [leash.website/app](https://leash.website/app) on Unichain Sepolia, the treasury wallet connected, on `#/create` |
| App, manager | A second browser profile with the manager wallet, on [leash.website/app](https://leash.website/app) |
| Keeper | `(set -a; . ./.env; ./scripts/keeper.sh)` running in its own terminal for the whole live run |
| Terminal | Repo root, font at 18 pt or larger, about 110 columns wide. Run `./scripts/demo.sh` once beforehand so forge has compiled and the run takes about 40 s. Nothing may be listening on port 8545 |
| Blockscout | [unichain-sepolia.blockscout.com/address/0xA8e4A5CECA23777aB7a6f07aE682845c891e2880](https://unichain-sepolia.blockscout.com/address/0xA8e4A5CECA23777aB7a6f07aE682845c891e2880), Contract tab, showing the verified source |
| Reference output | [`demo-output.txt`](demo-output.txt) is a full recorded run. Fee amounts move a little between runs, because anvil stamps blocks with the wall clock; the reverts, the clean epoch and the 33% slash come out the same every time |

The terminal shot is the proof. Record it live, or replay a real run at 2x speed. Don't stage it.

## Recording Order

The live mandate runs on real time (a 15-minute auction, then three 1-hour epochs), so record in clips and cut them together in the shot-list order below. Record the voiceover last, over the cut.

| When | Clip | Wallet |
|---|---|---|
| Now | A: post the mandate with the Demo settings (`#/create`, then sign). Starts the 15-minute auction | Treasury |
| Within 15 min | B: open the mandate, Auction tab, bid `10000` | Manager |
| After the auction, not recorded | A few buys and sells of 1,000 to 5,000 on the Trade tab over about 20 minutes, so the chart has shape; set the fee once in the Manager console | Either |
| About 45 min after posting | C: the Dashboard, then one buy on the Trade tab | Either |
| Any time | D: the slides. E: the Excalidraw architecture. F: `./scripts/demo.sh`. G: Blockscout | – |
| About 1 h 20 min after posting | H: once the keeper settles epoch 0, the Settle & claim tab and `#/managers` | Manager |

## Shot List: 4 Minutes 50 Seconds

| Time | On screen | Voiceover (word for word) |
|---|---|---|
| 0:00 to 0:08 | D, slide 1: the title | "This is Leash: a Uniswap v4 hook that lets a token treasury hire a market maker without handing over its tokens." |
| 0:08 to 0:20 | D, slide 2: the situation | "Token treasuries hold most of their money in their own token. To pay for anything, they have to sell some of it, and selling your own token without crashing its price is hard." |
| 0:20 to 0:40 | D, slide 3: the three options | "There are three ways to do it today, and each one costs the treasury. Dumping on the market moves the price against you. An OTC deal sells at a discount, usually to someone who dumps it anyway. Hiring a market maker means handing over the tokens and trusting reports you can't verify." |
| 0:40 to 0:47 | D, slide 4: the question | "So what if the market maker could run the liquidity, but never touch the money?" |
| 0:47 to 1:05 | D, slide 5: the attack in three steps | "There's a harder problem too. Even with no withdraw button, the real risk is mispricing: push the price, re-place the treasury's liquidity at the fake price, and trade it back. Leash is built to make every step of that cost more than it returns." |
| 1:05 to 1:20 | D, slide 6: the answer | "The treasury deposits into the hook and posts a mandate: the rules. Managers bid a first-loss bond. The winner moves the liquidity and sets the fee, and can never withdraw. Every swap is checked against the hook's own TWAP. A clean epoch pays the manager; a breach slashes the bond." |
| 1:20 to 1:45 | E: pan left to right across the architecture | "On the left: the treasury, the manager, and a keeper anyone can run. In the middle, the hook: a ledger per mandate, a TWAP oracle it records itself, the bond auction, a compliance clock, rebalance guards and settlement. On the right, Uniswap's PoolManager calls the hook before every swap. Inventory only ever moves between the hook and the pool, or back to the treasury. No owner, no admin, no upgrades." |
| 1:45 to 2:10 | A, at 2x through the signatures | "This is live on Unichain Sepolia. As the treasury, I post a mandate: a hundred thousand TKN and two hundred thousand mUSDC, a fifteen-minute auction, three one-hour epochs, and a ten-thousand-dollar minimum bond. The form checks every rule before anything is signed. The hook creates the pool, places the opening position and a permanent full-range anchor." |
| 2:10 to 2:22 | B | "From a second wallet, a manager bids the bond. Anyone can outbid it until the auction closes, and an outbid bond is refunded." |
| 2:22 to 2:45 | C | "The auction has closed and the manager is live. Every trade pays fees into the treasury's position. The dashboard reads everything from the chain: spot against the TWAP, the manager's range, and the three checks, in range, deep enough and on pace, counted in seconds." |
| 2:45 to 2:52 | F: type `./scripts/demo.sh`, enter | "Now the attack, on a fresh local chain where we control the clock." |
| 2:52 to 3:30 | F, step 4. Highlight `REVERTED SpotOffTwap()`, the `4300 pips` fee line, and `REVERTED on chain with SameBlock()` | "The manager sells into the pool and pushes the price a hundred and fifty ticks off fair value, then tries to re-range around the fake price. Reverted: spot is too far from the TWAP. It pushes further, and the fee rises from 0.30 to 0.43 percent, because spot is off the TWAP. Last try: nudge the price and grow the position in the same block. Reverted on chain. The sandwich has nothing to stand on." |
| 3:30 to 3:45 | F, step 5: `clean=true`, the manager's and the keeper's `owed` lines | "Epoch zero ends clean. Anyone can settle it; the keeper does, and earns a small bounty. The manager is owed thirty percent of the fees. The treasury keeps the rest." |
| 3:45 to 4:05 | F, step 6: `out 241 s`, `allowance 180 s`, the slash line | "Epoch one: the market drops ten percent and the manager is asleep. The hook counts every second out of range: two hundred and forty-one, against an allowance of one hundred and eighty. A third of the bond goes to the treasury. At twice the allowance, all of it would." |
| 4:05 to 4:12 | F, step 7: `close()`, the final balances | "The treasury closes and takes back all its inventory." |
| 4:12 to 4:27 | H | "Back on Unichain Sepolia, the keeper has settled epoch zero of our live mandate. The manager's pay is claimable, and the epoch joins its public track record." |
| 4:27 to 4:50 | G, then back to slide 1 | "Leash is a hundred and one forge tests, full coverage of the hook, and every finding from two internal audit rounds kept as a test. It's live and source verified on Unichain Sepolia, with no owner, no admin and no upgrade path. Hire a market maker. Keep the leash." |

About 660 words: 4 min 35 s of speech at a calm 145 words a minute, with room for pauses, ten seconds under the limit. If the epoch-0 settlement on testnet isn't ready, drop H (4:12 to 4:27) and the video ends at 4:35.

### Terminal lines to zoom on

Taken from [`demo-output.txt`](demo-output.txt):

```
    REVERTED ThinBond() (0x110c6f69): createMandate(minBond = 4,000 mUSDC = 1% of deposit) reverted ThinBond()
    owed(#1)    10000 mUSDC: the outbid bond is claimable now
    REVERTED SpotOffTwap() (0xe16ad561)
       |spot - TWAP| = 150 > maxTickDeviation 100
    4c #2 pushes 100 ticks further while spot is 150 ticks off the TWAP: fee charged 4300 pips (0.43%)
       block 41: nudge mined (status 1), grow REVERTED on chain with SameBlock() (0x6dde4588)
    epoch 0     in 3600 s, out 0 s, clean=true; LP fees 42.587723510528615652 TKN + 102.085279 mUSDC
    epoch 1     in 3359 s, out 241 s, clean=false; allowance 180 s (5%), fired at 360 s
    slash       bond 12000 -> 7933.333334 mUSDC: 4066.666666 to the treasury
```

## If You Have 60 Seconds

| Time | On screen | Voiceover (word for word) |
|---|---|---|
| 0:00 to 0:10 | Landing page hero | "Leash is a Uniswap v4 hook that lets a token treasury hire a market maker without handing over its tokens." |
| 0:10 to 0:22 | App: the AI drafter filling the term sheet, then a mandate dashboard | "The treasury posts its rules. Managers bid a bond. The winner can move the liquidity and set the fee, but it can never withdraw, and every swap checks the rules." |
| 0:22 to 0:45 | Terminal, step 4 then step 6 of `./scripts/demo.sh` | "Watch the real attack. The manager pushes the price and tries to re-range at the fake price: reverted. It tries it inside one block: reverted. Pushing the price even raises its own fee. And when it drifts out of range for longer than the rules allow, a third of its bond goes to the treasury." |
| 0:45 to 1:00 | Blockscout, the verified contract | "It's live and verified on Unichain Sepolia. No owner, no admin, no upgrades. Hire a market maker. Keep the leash." |

About 130 words.
