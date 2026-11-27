# Demo Video Plan (UHI11 Hookathon)

> **A video under 5 minutes (the hookathon's limit): a real market-maker dump, the problem on seven slides, the architecture, a live mandate on Unichain Sepolia, the attack failing in a terminal, and the verified hook. Plus a 60-second cut.**

## Before Recording

| What | How |
|---|---|
| Problem slides | The seven-slide deck ("Leash: The Problem"), presented full screen. Each slide's speaker notes hold its lines below |
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

## Shot List: 4 Minutes 30 Seconds

| Time | On screen | Voiceover (word for word) |
|---|---|---|
| 0:00 to 0:20 | D, slide 1: the MOVE incident | "In March 2025, Binance said a market maker for the MOVE token sold sixty-six million tokens the day after listing, into a market with almost no buyers, and kept thirty-eight million dollars. The token's team said it had no idea. That's what hiring a market maker can look like today." |
| 0:20 to 0:28 | D, slide 2: the title | "This is Leash: a Uniswap v4 hook that lets a token treasury hire a market maker without handing over its tokens." |
| 0:28 to 0:38 | D, slide 3: the situation | "Token treasuries hold most of their money in their own token. To pay for anything, they have to sell some, without crashing the price." |
| 0:38 to 0:52 | D, slide 4: the three options | "Dump it on the market, and the price falls. Sell it OTC, and you sell at a discount. Hire a market maker, and you hand over the tokens and trust reports you can't verify." |
| 0:52 to 0:58 | D, slide 5: the question | "So what if the market maker could run the liquidity, but never touch the money?" |
| 0:58 to 1:16 | D, slide 6: the attack in three steps | "There's a harder problem too. Even with no withdraw button, the real risk is mispricing: push the price, re-place the treasury's liquidity at the fake price, and trade it back. Leash is built to make every step of that cost more than it returns." |
| 1:16 to 1:38 | D, slide 7: the answer | "The treasury deposits into the hook and posts a mandate: the rules. Managers bid a first-loss bond. The winner moves the liquidity and sets the fee, but can never withdraw, so the tokens only ever sell to real buyers in the pool. Every swap is checked against the hook's own TWAP, and every epoch pays the manager or slashes the bond." |
| 1:38 to 1:58 | E: pan left to right across the architecture | "On the left: the treasury, the manager, and a keeper anyone can run. In the middle, the hook: a ledger, its own TWAP oracle, the bond auction, a compliance clock, rebalance guards and settlement. On the right, Uniswap's PoolManager calls the hook before every swap. No owner, no admin, no upgrades." |
| 1:58 to 2:18 | A, at 2x through the signatures | "This is live on Unichain Sepolia. As the treasury, I post a mandate: a hundred thousand TKN and two hundred thousand mUSDC, a fifteen-minute auction, three one-hour epochs, a ten-thousand-dollar minimum bond. The hook creates the pool and places the opening position and a permanent anchor." |
| 2:18 to 2:26 | B | "From a second wallet, a manager bids the bond. Anyone can outbid it until the auction closes." |
| 2:26 to 2:43 | C | "The manager is live. Every trade pays fees into the treasury's position, and the dashboard reads it all from the chain: spot against the TWAP, the manager's range, and whether it's in range, deep enough and on pace." |
| 2:43 to 2:48 | F: type `./scripts/demo.sh`, enter | "Now the attack, on a local chain where we control the clock." |
| 2:48 to 3:22 | F, step 4. Highlight `REVERTED SpotOffTwap()`, the `4300 pips` fee line, and `REVERTED on chain with SameBlock()` | "The manager sells into the pool and pushes the price a hundred and fifty ticks off fair value, then tries to re-range around the fake price. Reverted: spot is too far from the TWAP. It pushes further, and the fee rises from 0.30 to 0.43 percent, because spot is off the TWAP. Last try: nudge the price and grow the position in the same block. Reverted on chain. The sandwich has nothing to stand on." |
| 3:22 to 3:33 | F, step 5: `clean=true`, the manager's and the keeper's `owed` lines | "Epoch zero ends clean. The keeper settles it and earns a small bounty; the manager is owed thirty percent of the fees." |
| 3:33 to 3:50 | F, step 6: `out 241 s`, `allowance 180 s`, the slash line | "Epoch one: the market drops ten percent and the manager is asleep. Two hundred and forty-one seconds out of range, against an allowance of one hundred and eighty: a third of the bond goes to the treasury." |
| 3:50 to 3:55 | F, step 7: `close()`, the final balances | "The treasury closes and takes everything back." |
| 3:55 to 4:05 | H | "Back on Unichain Sepolia, the keeper has settled epoch zero of our live mandate, and the manager's pay is claimable." |
| 4:05 to 4:30 | G, then back to slide 2 | "A hundred and one forge tests, full coverage of the hook, every audit finding kept as a test, and source verified on Unichain Sepolia. A market maker on a leash can't walk off with the tokens: it earns its share, or it loses its bond. Hire a market maker. Keep the leash." |

About 620 words: 4 min 17 s of speech at a calm 145 words a minute, with room for pauses, 30 seconds under the limit. If the epoch-0 settlement on testnet isn't ready, drop H (3:55 to 4:05) and the video ends at 4:20.

The opening is sourced: Binance's own statement of March 2025, reported by [The Block](https://www.theblock.co/news/markets/2025-03-25-binance-move-market-maker-movement-38-million-usdt-buyback-program-347931) and [Blockworks](https://blockworks.co/news/binance-movement-market-maker-investigation). Binance did not name the market maker, and neither does the video.

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
