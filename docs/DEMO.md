# Demo Video Plan (UHI11 Hookathon)

> **A 3-minute video: the landing page, the app, the attack failing live in a terminal, and the verified hook. Plus a 60-second cut.**

## Before Recording

| What | How |
|---|---|
| Landing page | [leash-khaki.vercel.app](https://leash-khaki.vercel.app), scrolled to the top |
| App | [leash-khaki.vercel.app/app](https://leash-khaki.vercel.app/app) on Unichain Sepolia, wallet connected, a second tab open on `#/create` |
| A mandate dashboard | Click any mandate in the explorer; keep its URL (`#/m/<poolId>/dashboard`) ready in a third tab |
| Managers leaderboard | `#/managers` |
| Terminal | Repo root, font at 18 pt or larger, about 110 columns wide. Run `./scripts/demo.sh` once beforehand so forge has compiled and the run takes about 40 s. Nothing may be listening on port 8545 |
| Blockscout | [unichain-sepolia.blockscout.com/address/0xA8e4A5CECA23777aB7a6f07aE682845c891e2880](https://unichain-sepolia.blockscout.com/address/0xA8e4A5CECA23777aB7a6f07aE682845c891e2880), Contract tab, showing the verified source |
| Reference output | [`demo-output.txt`](demo-output.txt) is a full recorded run. Fee amounts move a little between runs, because anvil stamps blocks with the wall clock; the reverts, the clean epoch and the 33% slash come out the same every time |

The terminal shot is the proof. Record it live, or replay a real run at 2x speed. Don't stage it.

## Shot List: 3 Minutes

| Time | On screen | Voiceover (word for word) |
|---|---|---|
| 0:00 to 0:15 | Landing page hero: "Keep the leash." rises word by word | "Token treasuries hold most of their money in their own token. To sell some of it without crashing the price, they hire a market maker, and today that means handing over the tokens. Leash is a Uniswap v4 hook that lets a treasury hire a market maker without giving up custody." |
| 0:15 to 0:30 | Scroll through the five story scenes: Deposit, Auction, Manage, Every swap checked, Settle | "The treasury deposits into the hook and posts a mandate: the rules. Managers bid a bond for the job. The winner can move the liquidity and set the fee, and nothing else. There is no withdraw function. Every swap checks the rules, and every epoch either pays the manager or slashes the bond." |
| 0:30 to 0:40 | Scroll to the Defences section: "Withdrawal was never the risk." and the attack figure | "The real risk isn't theft. It's mispricing: push the price, re-place the treasury's liquidity at the fake price, and trade it back. That's the attack Leash is built to stop. We'll run it in a minute." |
| 0:40 to 1:00 | App, `#/create`: type a plain sentence into the AI assistant ("Sell 30% of 100k TKN into mUSDC over three weeks, 1% max fee"), the form fills in; scroll to the rules backtester and switch the price path between choppy and trending | "Here's the app. A treasury describes what it wants in plain words, and the AI drafter fills in the term sheet. It never signs anything. Before posting, the rules backtester runs price paths through those terms and shows which epochs would breach. So the treasury tunes the rules before money is at stake." |
| 1:00 to 1:15 | A mandate dashboard: spot vs TWAP chart with the managed range, the three compliance checks, the ledger, the epochs table | "Every mandate gets a live dashboard: spot against the TWAP, the manager's range, whether it's in range, deep enough and on pace, and every epoch's seconds in and out. Every number here is read from the chain." |
| 1:15 to 1:22 | `#/managers`: the leaderboard | "Managers build a public track record: clean epochs, breaches, pay and slashes, ranked." |
| 1:22 to 1:32 | Terminal: type `./scripts/demo.sh`, enter. Steps 0 to 2 scroll: the ThinBond revert, two bids, the outbid bond claimable | "Now the proof, on a fresh local chain. The treasury posts a mandate. A bond under two percent of the deposit is rejected. Two managers bid. The outbid bond is claimable straight away." |
| 1:32 to 2:05 | Terminal, step 4. Highlight `REVERTED SpotOffTwap()`, the `4300 pips` fee line, and `REVERTED on chain with SameBlock()` | "Here's the attack. The manager sells into the pool and pushes the price a hundred and fifty ticks off fair value. Then it tries to re-range around the fake price. Reverted: spot is too far from the TWAP. It pushes further, and the hook charges more: the fee rose from 0.30 to 0.43 percent, because spot is off the TWAP. Last try: nudge the price and grow the position in the same block. Reverted on chain. Same block. The sandwich has nothing to stand on." |
| 2:05 to 2:20 | Terminal, step 5: `clean=true`, the manager's and the keeper's `owed` lines | "Epoch zero ends clean. Anyone can settle it. The keeper does, and earns a small bounty. The manager is owed thirty percent of the fees. The treasury keeps the rest." |
| 2:20 to 2:40 | Terminal, step 6: the out-of-range countdown, then `out 241 s`, `allowance 180 s`, and the slash line | "Epoch one: the market drops ten percent and the manager is asleep. The hook counts every second out of range. Two hundred and forty-one seconds, against an allowance of one hundred and eighty. A third of the bond goes to the treasury. At twice the allowance the manager would lose all of it and be fired." |
| 2:40 to 2:48 | Terminal, step 7: `close()`, the final balances table | "The treasury closes, takes back all its inventory, and everyone claims what they're owed." |
| 2:48 to 3:00 | Blockscout: the verified Leash contract on Unichain Sepolia, then back to the landing page's final section | "Leash is live on Unichain Sepolia, source verified, with no owner, no admin and no upgrade path. Hire a market maker. Keep the leash." |

About 440 words, a calm 150 words a minute.

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
