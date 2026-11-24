# Script: Foundry Deploy, Local Stack and Keeper Scripts

> **Five Solidity files: one deploys the hook, one builds a full local chain, one is the keeper, one mints testnet tokens, one mines the hook address.**

Everything here runs under `forge script`. The scripts write their results to [`../deployments/`](../deployments/README.md) (the only folder `foundry.toml` lets them write, through `fs_permissions`) and forge records every broadcast transaction under `broadcast/`. The shell wrappers that run `Local.s.sol` and `Settle.s.sol` are in [`../scripts/`](../scripts/README.md). The contract they deploy is described in [`../src/README.md`](../src/README.md); the tests that run this code without broadcasting are in [`../test/README.md`](../test/README.md).

## Files

| File | Contract(s) | Purpose | Writes |
|---|---|---|---|
| [`DeployLeash.s.sol`](DeployLeash.s.sol) | `DeployLeash` | Mines a hook address and deploys `Leash` through CREATE2 against an existing PoolManager | `deployments/<chainId>.json` |
| [`HookMiner.sol`](HookMiner.sol) | `HookMiner` (library) | Brute-forces the CREATE2 salt whose address carries the permission bits | nothing |
| [`Local.s.sol`](Local.s.sol) | `Local is DeployLeash` | A fresh v4 PoolManager, swap router, two mock tokens, Leash and one seeded mandate on anvil | `deployments/31337.json` |
| [`Settle.s.sol`](Settle.s.sol) | `Settle` | One keeper round: `checkpoint`, then `settle` every ended epoch in order | nothing |
| [`Tokens.s.sol`](Tokens.s.sol) | `Tokens`, `Faucet` | Deploys testnet TKN and mUSDC with an open mint; mints more later | `deployments/<chainId>-tokens.json` |

## Folder Structure

```
script/
├── DeployLeash.s.sol   # Testnet / any-chain deploy. PRIVATE_KEY, optional POOL_MANAGER
│                       #   hookFlags(): reads getHookPermissions() from Leash's own runtime code
│                       #   flags():     Hooks.Permissions -> uint160 flag bits
│                       #   deployLeash(): HookMiner.find + new Leash{salt}, checks the address
├── HookMiner.sol       # CREATE2 salt search, up to 500,000 salts, mask 0x3FFF
├── Local.s.sol         # Extends DeployLeash. Anvil's default mnemonic only, refuses chain != 31337
├── Settle.s.sol        # Keeper round for the pool in deployments/<chainId>.json. KEEPER_PRIVATE_KEY
└── Tokens.s.sol        # Tokens: TKN (18 dec) + mUSDC (6 dec), 10M each to the deployer
                        # Faucet: 1M of each to TO (default: the key's address)
```

## Configuration

`foundry.toml` sets Solidity 0.8.26, EVM `cancun`, 800 optimizer runs, no via-IR, and one RPC alias:

| Alias | URL |
|---|---|
| `unichain_sepolia` | `https://sepolia.unichain.org` (chain 1301) |

Forge loads `.env` from the repo root automatically. [`.env.example`](../.env.example) lists the variable names:

| Variable | Used by | Meaning |
|---|---|---|
| `PRIVATE_KEY` | `DeployLeash`, `Tokens`, `Faucet` | Deployer key, 0x-prefixed. Needs Unichain Sepolia ETH for gas |
| `POOL_MANAGER` | `DeployLeash` | Optional on 1301; required on any other chain |
| `KEEPER_PRIVATE_KEY` | `Settle` | Keeper signer; needs gas only. Defaults to anvil account #4 on 31337 |
| `TO` | `Faucet` | Recipient of the minted tokens; defaults to `vm.addr(PRIVATE_KEY)` |

`Local.s.sol` reads no variables: it derives every key from anvil's public mnemonic (`test test ... junk`).

### `msg.sender` is not the broadcaster

Inside a forge script, `msg.sender` is forge's default sender, not the key passed to `vm.startBroadcast(pk)`. The scripts never use `msg.sender` to mean "me": `Tokens.run` mints to `vm.addr(pk)`, `Faucet` defaults `TO` to `vm.addr(pk)`, and `Local` passes `addr(TREASURY)` (that is, `vm.addr(vm.deriveKey(MNEMONIC, 0))`) as the PoolManager owner. Inside the broadcast, contract calls do see the broadcaster as `msg.sender`, which is why `createMandate` in `Local` records account #0 as the treasury.

## Hook Address Mining

A Uniswap v4 hook's permissions are not stored anywhere. The PoolManager reads them from the lowest 14 bits of the hook's address (`Hooks.ALL_HOOK_MASK = 0x3FFF`) and calls only the hooks whose bits are set. `Hooks.validateHookPermissions`, called from the `BaseHook` constructor ([`../src/utils/BaseHook.sol`](../src/utils/BaseHook.sol)), reverts the deployment of a hook whose address bits disagree with what `getHookPermissions()` declares. So the deploy has to land Leash at an address whose low 14 bits equal its permissions exactly.

`Leash.getHookPermissions()` sets three permissions:

| Permission | Flag constant | Bit | Value | Why Leash needs it |
|---|---|---|---|---|
| `beforeInitialize` | `BEFORE_INITIALIZE_FLAG` | 13 | `0x2000` | Reverts `HookOnly`: only the hook itself may create a Leash pool |
| `beforeAddLiquidity` | `BEFORE_ADD_LIQUIDITY_FLAG` | 11 | `0x0800` | Reverts `HookOnly`: only the hook may add liquidity |
| `beforeSwap` | `BEFORE_SWAP_FLAG` | 7 | `0x0080` | Records the oracle observation and books compliance on every swap |

`0x2000 | 0x0800 | 0x0080 = 0x2880`. Both deployed Leash addresses end in it: `0x9F1e...6880` on Unichain Sepolia and `0x4607...e880` on anvil, and `0x6880 & 0x3FFF = 0xe880 & 0x3FFF = 0x2880`. The hook's own calls into the PoolManager skip its hooks, so `createMandate` and `rebalance` pass through the `HookOnly` reverts.

The search, step by step:

1. **Read the flags from the contract.** `DeployLeash.hookFlags()` etches Leash's runtime code (`vm.getDeployedCode("Leash.sol:Leash")`) at a scratch address (`keccak256("leash.hookFlags")`), calls `getHookPermissions()` on it and converts the struct with `flags()`, which ORs one `Hooks.*_FLAG` per true field (all 14). The address follows the contract: add a permission to `Leash.sol` and the next deploy mines for it, with no constant to update.
2. **Build the init code.** `abi.encodePacked(type(Leash).creationCode, abi.encode(pm))`. The constructor argument is part of the hash, so a different PoolManager gives a different address.
3. **Mine.** `HookMiner.find(CREATE2_FACTORY, flags, initCode)` tries `salt = 0, 1, 2, ...` up to 500,000, computing `keccak256(0xff ++ deployer ++ salt ++ keccak256(initCode))[12:]` and returning the first address with `addr & 0x3FFF == flags`. One address in 2^14 matches, so a match is expected in about 16,000 tries. It reverts `HookMiner: no valid salt found in 500k iterations` otherwise.
4. **Deploy and check.** `new Leash{salt: salt}(pm)`. In a script, forge routes salted `new` through the deterministic CREATE2 deployer `0x4e59b44847b379578588920ca78fbf26c0b4956c` (`CREATE2_FACTORY` in forge-std), which is why that address, not the broadcasting EOA, is passed as `deployer`. The broadcast record shows the transaction going `to` that factory. `require(address(leash) == mined, "hook address mismatch")` stops the run if the two ever disagree.

The `@param deployer` comment in `HookMiner.sol` says "broadcast EOA"; the caller here passes the CREATE2 factory, which is the address that actually executes CREATE2.

`test/Deploy.t.sol` asserts `uint160(address(leash)) & Hooks.ALL_HOOK_MASK == local.flags(p)` for the address this code produces.

## Scripts

### DeployLeash.s.sol

Deploys Leash on a chain that already has a v4 PoolManager. It does not create a pool or a mandate; a treasury does that later by calling `createMandate` (from the app or directly).

1. Picks the PoolManager: `POOL_MANAGER` if set, otherwise `0x00B036B58a818B1BC34d502D3fE730Db729e62AC` on chain 1301 (Uniswap's Unichain Sepolia deployment), otherwise `address(0)`.
2. `require(pm.code.length > 0, "no PoolManager on this chain: set POOL_MANAGER")`.
3. `vm.startBroadcast(vm.envUint("PRIVATE_KEY"))`, then `deployLeash(pm)` as described in [Hook Address Mining](#hook-address-mining). One transaction: the CREATE2 call to the factory.
4. Writes `deployments/<chainId>.json` (path from `vm.projectRoot()`) with `chainId`, `block` (the block the script ran at, which the frontend uses as the first block to scan for events), `poolManager` and `leash`. The file has no `pool` key.
5. Logs the Leash address and the file it wrote.

```bash
# Dry run first: simulates, mines the salt, prints the address, sends nothing (it still writes the JSON)
forge script script/DeployLeash.s.sol --rpc-url unichain_sepolia

# Deploy
forge script script/DeployLeash.s.sol --rpc-url unichain_sepolia --broadcast

# Any other chain with a v4 PoolManager
POOL_MANAGER=0x... forge script script/DeployLeash.s.sol --rpc-url <rpc> --broadcast
```

A simulation without `--broadcast` still runs `vm.writeJson`, so it overwrites `deployments/<chainId>.json` with the simulated address and block. The address is deterministic (same factory, same init code, same salt), so it matches what a broadcast would deploy, unless that address is already taken, in which case the broadcast fails. Restore the file with `git checkout deployments/1301.json` if you only meant to look.

The Unichain Sepolia deployment is `0x9F1e080eFA57938d394e41d58702912371346880`; see [`../deployments/README.md`](../deployments/README.md). To verify the source on Blockscout, add `--verify --verifier blockscout --verifier-url https://unichain-sepolia.blockscout.com/api/` to the broadcast command.

### HookMiner.sol

A library, not a script. `find(address deployer, uint160 flags, bytes creationCode) internal pure returns (address hookAddress, bytes32 salt)`. It hashes the init code once and loops over sequential salts; see step 3 above. It runs inside the forge simulation, so the search costs no gas on chain. Used by `DeployLeash.deployLeash`, and through inheritance by `Local` and the tests.

### Local.s.sol

Builds the whole stack on a fresh anvil so the frontend has something live to show. Run it through [`../scripts/local.sh`](../scripts/README.md#localsh), which starts anvil, spaces block timestamps and exports the ABI. `run()` starts with `require(block.chainid == 31337, "local anvil only")`, because its keys are anvil's public dev keys.

Accounts, all from anvil's default mnemonic:

| Index | Role | Address |
|---|---|---|
| #0 | Treasury, and deployer of everything | `0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266` |
| #1 | Manager 1 (outbid) | `0x70997970C51812dc3A010C7d01b50e0d17dc79C8` |
| #2 | Manager 2 (leads the auction) | `0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC` |
| #3 | Swapper | `0x90F79bf6EB2c4f870365E785982E1f101E93b906` |
| #4 | Keeper (`Settle.s.sol` default) | not used by `Local` |

`deployStack()`, step by step:

1. As #0: deploys `PoolManager(addr(0))`, `PoolSwapTest`, `MockERC20("Treasury Token", "TKN", 18)` and `MockERC20("Mock USDC", "mUSDC", 6)`, then `deployLeash(manager)` (the inherited CREATE2 path).
2. Mints 1,000,000 TKN and 1,000,000 mUSDC to each of #0 to #3.
3. Sorts the two tokens into `currency0` / `currency1` and builds the pool key: fee `LPFeeLibrary.DYNAMIC_FEE_FLAG` (`0x800000`, stored as `8388608` in the JSON), tick spacing 60, hooks = Leash.
4. Sets the opening price from the deposit ratio, 100,000 TKN to 200,000 mUSDC (1 TKN = 2 mUSDC): `sqrtPriceX96 = sqrt(a1 * 2^192 / a0)`.
5. Opening position: half of each deposit over +-1,200 ticks (about 12%) around the opening tick, rounded down to the tick spacing. Anchor: a fifth of each deposit over the full usable range. The remaining ~30% stays idle in the hook.
6. Approves Leash and calls `createMandate(key, openSqrtPriceX96, terms, a0, a1, position)` with these terms:

   | Term | Value |
   |---|---|
   | `maxFee` / `minFee` | 10,000 (1%) / 500 (0.05%) |
   | `auctionEnd` | deploy time + 10 minutes |
   | `epochLength` x `epochs` | 1 hour x 3 |
   | `minBond` | 1,000 mUSDC |
   | `twapWindow` | 120 s |
   | `maxTickDeviation` / `minHalfWidth` | 100 / 200 ticks |
   | `minLiquidity` | half the opening position's liquidity |
   | `uptimeBps` | 9,500 (95% of each epoch in compliance) |
   | `managerFeeBps` | 3,000 (30% of the position's fees) |
   | `startStableBps` -> `endStableBps` | 6,000 -> 8,000 |
   | `anchorLiquidity` | the full-range fifth from step 5 |

7. As #1: approves and bids 1,000 mUSDC. As #2: bids 1,500 mUSDC, which outbids #1; #1's bond becomes claimable through `owed` / `claim`.
8. As #3: approves the swap router and makes three exact-input swaps (1,000 mUSDC in, 300 TKN in, 500 mUSDC in), so the oracle has observations and the position has earned fees.

Then `writeDeployment()` writes `deployments/31337.json`: `chainId`, `block` (the block the script started at), `poolManager`, `swapRouter`, `leash`, `tkn`, `usdc`, a `pool` object (`currency0`, `currency1`, `fee`, `tickSpacing`, `hooks`, `id`) and an `accounts` object (`treasury`, `manager1`, `manager2`, `swapper`). The auction is still open when the script ends.

```bash
./scripts/local.sh                                                   # the normal way
forge script script/Local.s.sol:Local --rpc-url http://127.0.0.1:8545 --broadcast --slow   # what it runs
```

`Local` also exposes `deployStack()`, `poolKey()`, `pk(i)` and `addr(i)` publicly; `test/Deploy.t.sol` and `test/Settle.t.sol` construct it and call `deployStack()` directly, without the JSON write.

### Settle.s.sol

One keeper round against the pool named in `deployments/<chainId>.json`. [`../scripts/keeper.sh`](../scripts/README.md#keepersh) runs it on a loop.

1. Reads `deployments/<chainId>.json`. If it has no `.pool` key, logs `No pool in <path>` and returns without broadcasting.
2. Rebuilds the `PoolKey` from `.pool.currency0`, `.pool.currency1`, `.pool.fee`, `.pool.tickSpacing`, `.pool.hooks`.
3. Signer: `KEEPER_PRIVATE_KEY`, or anvil account #4 on chain 31337; `require(pk != 0, "set KEEPER_PRIVATE_KEY")` elsewhere.
4. `keep(leash, key)`, inside one broadcast:
   - Skips if there is no mandate or it is closed, and if the auction has not ended (`block.timestamp < auctionEnd`).
   - Calls `checkpoint(key)` if the pre-mandate fees are not swept yet, or if there is a manager, no breach, and `lastCheck` is before the mandate's end. Then logs `compliance(key)`: `inRange`, `deep`, `onPace` and the stablecoin share in bps. This condition does not compare against `block.timestamp`: on an idle chain the simulated block is stale while the transaction lands at the real time.
   - If there is no manager, stops (nothing to settle).
   - Takes `currentEpoch(key)` capped at `terms.epochs` as the count of ended epochs, then calls `settle(key, e)` for `e = m.settled, m.settled + 1, ...` while the mandate is not breached. It re-reads the mandate after each settle, because `settle` requires `e == m.settled` and a breach stops the mandate. Each settle logs the epoch's `clean` flag, in/out seconds and fees from `epochRecord`.

It decides with view calls only, never `try`/`catch`: forge still broadcasts a call that reverted inside a `try`, so a guarded call would send a failing transaction anyway.

```bash
./scripts/keeper.sh                                   # loop, local
RPC_URL=unichain_sepolia ./scripts/keeper.sh          # loop, testnet
forge script script/Settle.s.sol:Settle --rpc-url http://127.0.0.1:8545 --broadcast --slow   # one round
```

`deployments/1301.json` has no `pool` key (DeployLeash does not write one), so on Unichain Sepolia the script currently logs `No pool in ...` and exits. To keep a testnet mandate, add its `pool` object to that file in the same shape as `31337.json`. `test/Settle.t.sol` runs `keep()` against a `Local` stack.

### Tokens.s.sol

Two scripts in one file. The tokens are solmate's `MockERC20`, whose `mint` is open to anyone: testnet only, worth nothing.

**`Tokens`** (the default contract in the file):

1. `pk = PRIVATE_KEY`, `me = vm.addr(pk)` (see [the `msg.sender` note](#msgsender-is-not-the-broadcaster)).
2. Deploys `MockERC20("Leash Test Token", "TKN", 18)` and `MockERC20("Mock USDC", "mUSDC", 6)`.
3. Mints 10,000,000 TKN and 10,000,000 mUSDC to `me`.
4. Writes `deployments/<chainId>-tokens.json` with `chainId`, `tkn`, `usdc` (a path relative to the working directory, so run it from the repo root).

```bash
forge script script/Tokens.s.sol --rpc-url unichain_sepolia --broadcast
```

Running it again deploys a new pair and overwrites the tokens file. The Unichain Sepolia pair is already deployed; use `Faucet` to get more.

**`Faucet`**:

1. `pk = PRIVATE_KEY`, `to = TO` or `vm.addr(pk)`.
2. Reads `.tkn` and `.usdc` from `deployments/<chainId>-tokens.json`.
3. Mints 1,000,000 TKN and 1,000,000 mUSDC to `to`. Two transactions.

```bash
forge script script/Tokens.s.sol:Faucet --rpc-url unichain_sepolia --broadcast
TO=0x... forge script script/Tokens.s.sol:Faucet --rpc-url unichain_sepolia --broadcast
```

Forge files `Faucet` runs under `broadcast/Tokens.s.sol/1301/` too, since the record is keyed by the script file.

## Outputs at a Glance

| Script | JSON written | Broadcast record |
|---|---|---|
| `DeployLeash` | `deployments/<chainId>.json` | `broadcast/DeployLeash.s.sol/<chainId>/` |
| `Local` | `deployments/31337.json` | `broadcast/Local.s.sol/31337/` (gitignored) |
| `Settle` | none | `broadcast/Settle.s.sol/<chainId>/` |
| `Tokens` | `deployments/<chainId>-tokens.json` | `broadcast/Tokens.s.sol/<chainId>/` |
| `Faucet` | none (reads the tokens file) | `broadcast/Tokens.s.sol/<chainId>/` |

`deployments/abi/Leash.json` is not written by any of these: `scripts/local.sh` extracts it from `out/Leash.sol/Leash.json` with `jq`. Details in [`../deployments/README.md`](../deployments/README.md).
