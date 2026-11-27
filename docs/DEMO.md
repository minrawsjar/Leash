# Demo Video Plan (UHI11 Hookathon)

> **A video under 5 minutes (the hookathon's limit): the problem and the solution on seven slides, the architecture, a live mandate on Unichain Sepolia, the attack failing in a terminal, and the verified hook. Plus a 60-second cut.**

## Before Recording

| What | How |
|---|---|
| Problem slides | The seven-slide deck ("Leash: Problem and Solution"), presented full screen. Each slide's speaker notes hold its lines below |
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

## Script: 4 Minutes 53 Seconds of Constant Speaking

Four parts, spoken straight through at a steady 150 words a minute (734 words): problem, solution, architecture, demo. Record the voiceover in one take, then cut the shots under it.

### Problem (0:00 to 0:52)

*On screen:* Slides 1 to 4: the MOVE incident, the situation, the three options, the attack in three steps. Change slide at each sentence group (the deck's speaker notes hold each slide's lines).

In March 2025 Binance revealed that a market maker working on the MOVE token sold sixty-six million tokens the day after listing and walked away with thirty-eight million dollars. The project's own team said they had no idea. That's the trust problem every token treasury faces when it needs to sell. Most of its money sits in its own token, so paying for anything means selling some without crashing the price. Dumping on the market pushes the price down. Selling over the counter means taking a discount. Hiring a market maker means handing over custody and trusting reports you can't check. And even without a withdraw button a market maker can still hurt you by pushing the price off fair value and moving your liquidity there before trading back against it.

### Solution (0:52 to 1:37)

*On screen:* Slides 5 to 7: the question, the title, the answer.

So what if a market maker could run your liquidity but never touch your money? That's what Leash does. It's a Uniswap v4 hook where the treasury deposits its inventory and posts a mandate setting the rules for depth and fees and how fast it moves into stablecoins. Market makers compete for the job by posting a first-loss bond. The winner can move the liquidity and set the fee, but there's no function that lets it withdraw, so the tokens only ever sell to real buyers in the pool. The hook checks the rules on every swap and each epoch either pays the manager a share of the fees or slashes its bond.

### Architecture (1:37 to 3:24)

*On screen:* The Excalidraw diagram, following the arrows as they are named: createMandate, the PoolManager and the red HookOnly note, bid and the Bond auction, Swappers to PoolManager and beforeSwap (Oracle, Compliance clock, Leash pool), rebalance and the guards, unlock, checkpoint and settle, claim and close.

It all starts when the treasury calls createMandate with its terms and both tokens. The hook pulls the tokens into its ledger and creates a new pool on Uniswap's PoolManager with a dynamic fee. It places two positions there, the opening range the manager takes over and a permanent full-range anchor. Leash makes beforeInitialize and beforeAddLiquidity revert for any other caller, so nobody but the hook can touch this pool. Managers then call bid and lock a bond in the stablecoin, and an outbid bond can be claimed straight back. Once trading starts each swap goes to the PoolManager, which calls the hook's beforeSwap before anything executes. In that one call the hook records the pre-swap tick in its own TWAP oracle and limits how far it can move to fifty ticks per second. It also books the time since the last check as compliant or not and returns a fee that rises the further spot sits from the TWAP. When the manager rebalances the guards run first. Spot has to be near the TWAP and the new range has to cover it with enough depth. There's one rebalance per block and the position can grow at most five percent per window. Then the hook unlocks the PoolManager and moves its own liquidity. Rebalance takes no recipient, so the manager has no way to send funds anywhere. A keeper calls checkpoint every minute and settles each epoch. A clean epoch pays the manager its fee share and a bad one sends part of the bond to the treasury. Everyone collects through claim and only the treasury can close.

### Demo (3:24 to 4:53)

*On screen:* Clips A to C on Unichain Sepolia (post, bid, dashboard), then F: `./scripts/demo.sh` steps 4 to 7, then G: Blockscout, and the title slide to end.

Here it is live on Unichain Sepolia. As the treasury I deposit a hundred thousand TKN and two hundred thousand mUSDC with a fifteen-minute auction and three one-hour epochs. From a second wallet a manager bids a ten-thousand mUSDC bond and takes over once the auction closes. The dashboard reads everything from the chain so you can see spot against the TWAP and the manager's range and the three checks. For the attack I switch to a local chain. The manager pushes the price a hundred and fifty ticks off fair value and tries to re-range around it, and the hook reverts because spot is too far from the TWAP. When it pushes further its own fee climbs from 0.30 to 0.43 percent. Then it tries to nudge the price and grow in the same block and that reverts on chain too. Epoch zero ends clean so the manager is owed thirty percent of the fees. In epoch one the price drops ten percent while the manager sleeps, and the hook counts two hundred and forty-one seconds out of range against an allowance of one hundred and eighty. That costs the manager a third of its bond, which goes to the treasury. A market maker on a leash can't walk off with your tokens. Hire a market maker and keep the leash.

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
