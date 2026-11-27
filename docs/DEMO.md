# Demo Video Plan (UHI11 Hookathon)

> **A video under 5 minutes (the hookathon's limit): a real market-maker dump, the problem on six slides, the architecture, a live mandate on Unichain Sepolia, the attack failing in a terminal, and the verified hook. Plus a 60-second cut.**

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

## Shot List: 4 Minutes 42 Seconds

The slides change on each line; the architecture and the demo are each one long narration, with the shots cut under it in the edit: for the architecture, follow the arrows (createMandate, bid, swap and beforeSwap, rebalance and unlock, checkpoint and settle, claim and close); for the demo, clips A to C on Unichain Sepolia, then F (`./scripts/demo.sh` steps 4 to 7). Slide 7 (the answer) is left out of this cut: the architecture covers it.

| Time | On screen | Voiceover (word for word) |
|---|---|---|
| 0:00 to 0:20 | Slide 1: the MOVE incident | "In March 2025, Binance said a market maker for the MOVE token sold sixty-six million tokens the day after listing, into almost no buyers, and kept thirty-eight million dollars. The token's team said it had no idea. That's what hiring a market maker can look like today." |
| 0:20 to 0:29 | Slide 2: title | "This is Leash: a Uniswap v4 hook that lets a token treasury hire a market maker without handing over its tokens." |
| 0:29 to 0:36 | Slide 3: the situation | "Treasuries hold mostly their own token, and need to sell some without crashing the price." |
| 0:36 to 0:49 | Slide 4: the three options | "Dump it, and the price falls. Sell OTC, and you take a discount. Hire a market maker, and you hand over the tokens and trust reports you can't verify." |
| 0:49 to 0:56 | Slide 5: the question | "So what if the market maker could run the liquidity, but never touch the money?" |
| 0:56 to 1:08 | Slide 6: the attack in three steps | "There's a harder problem too: even with no withdraw button, a manager can push the price, re-place the treasury's liquidity at the fake price, and trade it back." |
| 1:08 to 2:56 | Architecture diagram | "Here's how it fits together. It starts when the treasury calls createMandate with its terms and both tokens. The hook pulls the tokens into its ledger, creates a new pool on the PoolManager with a dynamic fee, and places two positions: the opening range the manager will run, and a permanent full-range anchor. beforeInitialize and beforeAddLiquidity revert for anyone else, so nobody but the hook can ever touch this pool. Managers then call bid, paying a bond in the stablecoin; each bid must beat the last, and the outbid bond moves to an owed balance. From then on, every trade goes from the swapper to the PoolManager, which calls the hook's beforeSwap. In that one call the hook writes the pre-swap tick into its own TWAP oracle, capped at fifty ticks a second, books the seconds since the last check as in or out of compliance, and returns the fee: the manager's fee plus a surcharge that grows with every tick spot sits off the TWAP. When the manager calls rebalance, the guards go first: spot near the TWAP, a range around it, above the depth floor, once per block, and growing at most five percent per window. Then the hook unlocks the PoolManager and moves its own liquidity to the new range. There's no recipient, so nothing can leave. A keeper calls checkpoint every minute and settle when each epoch ends. Settlement credits owed balances: the manager's fee share if the epoch was clean, part of the bond to the treasury if it wasn't. Everyone collects with claim, and at the end only the treasury can close." |
| 2:56 to 4:28 | Demo | "Now the demo, live on Unichain Sepolia. As the treasury, I deposit a hundred thousand TKN and two hundred thousand mUSDC, set a fifteen-minute auction and three one-hour epochs, and sign; the form checks every rule first. From a second wallet, a manager bids a ten-thousand mUSDC bond. Once the auction closes, the manager is live, and the dashboard shows what the hook sees: spot against the TWAP, the manager's range, and the three checks, counted in seconds. For the attack, I switch to a local chain where I control the clock. The manager pushes the price a hundred and fifty ticks off fair value and tries to re-range around the fake price: reverted, spot is too far from the TWAP. It pushes further, and its fee rises from 0.30 to 0.43 percent. It tries to nudge the price and grow in the same block: reverted on chain. The sandwich has nothing to stand on. Epoch zero ends clean: the keeper settles it for a small bounty, and the manager is owed thirty percent of the fees. In epoch one the price drops ten percent and the manager falls asleep. The hook counts two hundred and forty-one seconds out of range against an allowance of one hundred and eighty, and a third of the bond goes to the treasury. Finally the treasury closes and takes everything back." |
| 4:28 to 4:42 | Closing: Blockscout, then the title slide | "A hundred and one tests, full coverage of the hook, verified on Unichain Sepolia. A market maker on a leash can't walk off with the tokens. Hire a market maker. Keep the leash." |

About 680 words: 4 min 42 s at a steady 150 words a minute, under the 5-minute limit.

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
