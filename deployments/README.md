# Deployments: Every Public Address

> **One JSON file per chain, written by the Foundry scripts and compiled into the frontend at build time.**

This folder holds every address Leash uses on Unichain Sepolia (chain 1301) and on a local anvil (chain 31337), the testnet token pair, and the Leash ABI. The Foundry scripts in [`../script/`](../script/README.md) write these files; nobody edits addresses by hand. The frontend imports them as JSON modules, so changing a file changes the app on the next build. Public values only: no private key, RPC key or API key ever goes in this folder.

## Files

| File | Written by | Read by | Contents |
|---|---|---|---|
| [`1301.json`](1301.json) | `script/DeployLeash.s.sol` | `frontend/src/app/chain.ts`, `script/Settle.s.sol` | Unichain Sepolia: `chainId`, `block`, `poolManager`, `leash` |
| [`1301-tokens.json`](1301-tokens.json) | `script/Tokens.s.sol:Tokens` | `script/Tokens.s.sol:Faucet` | Testnet TKN and mUSDC addresses |
| [`31337.json`](31337.json) | `script/Local.s.sol` (via `scripts/local.sh`) | `frontend/src/app/chain.ts`, `frontend/src/app/verify.ts`, `script/Settle.s.sol` | Local anvil: core addresses, tokens, swap router, the seeded pool key, the accounts |
| [`abi/Leash.json`](abi/Leash.json) | `scripts/local.sh` (`jq .abi out/Leash.sol/Leash.json`) | `frontend/src/app/chain.ts` | Leash's ABI: a JSON array of 59 entries (constructor, functions, events, errors) |

## Folder Structure

```
deployments/
├── 1301.json           # Unichain Sepolia: Leash + Uniswap's PoolManager, start block for event scans
├── 1301-tokens.json    # Unichain Sepolia: TKN (18 dec) and mUSDC (6 dec), open mint
├── 31337.json          # Local anvil: v4 + router + tokens + Leash + pool key + account roles
└── abi/
    └── Leash.json      # ABI only (no bytecode), exported from forge's out/
```

`foundry.toml` grants scripts `read-write` access to `./deployments` and nothing else outside `./out`, which is why every script output lands here.

## Unichain Sepolia (1301)

From [`1301.json`](1301.json) and [`1301-tokens.json`](1301-tokens.json). Explorer: Blockscout.

| Contract | Address | Notes |
|---|---|---|
| **Leash** (hook) | [`0xA8e4A5CECA23777aB7a6f07aE682845c891e2880`](https://unichain-sepolia.blockscout.com/address/0xA8e4A5CECA23777aB7a6f07aE682845c891e2880) | Current, source verified. Low 14 bits `0x2880`. Deployed at block 68766900; `block` in the file is 68766877, the simulation's block, which only has to be at or before it |
| **LeashOracle** (linked library) | [`0x5F27fb11c85d2771eCEFe565F5328149582ea64b`](https://unichain-sepolia.blockscout.com/address/0x5F27fb11c85d2771eCEFe565F5328149582ea64b) | Source verified. CREATE2 through the deterministic deployer, so the same address on every chain; Leash calls it for `observe`, `twap` and `pendingFees` |
| Leash (previous build) | [`0xbB07E2C8C163063C602A2D00ddc97d5FacE76880`](https://unichain-sepolia.blockscout.com/address/0xbB07E2C8C163063C602A2D00ddc97d5FacE76880) | Superseded: before the pre-hire fee measurement (a swap before the first post-auction checkpoint had the epoch's fees swept to the treasury with the auction's). Linked to `LeashOracle` [`0x6562...786f`](https://unichain-sepolia.blockscout.com/address/0x6562531d91b9bB6e64b030bf54a4cC68d312786f). The app reads only the current hook |
| Leash (older build) | [`0x9F1e080eFA57938d394e41d58702912371346880`](https://unichain-sepolia.blockscout.com/address/0x9F1e080eFA57938d394e41d58702912371346880) | Superseded: before the per-swap fee, partial slash, keeper bounty and bond floor. Its one mandate is closed |
| **PoolManager** (Uniswap v4) | [`0x00B036B58a818B1BC34d502D3fE730Db729e62AC`](https://unichain-sepolia.blockscout.com/address/0x00B036B58a818B1BC34d502D3fE730Db729e62AC) | Uniswap's deployment; the default in `DeployLeash.s.sol` |
| **TKN** "Leash Test Token" | [`0x2E8D07593389DDB1d84421D41e1d5fe120DCd99C`](https://unichain-sepolia.blockscout.com/address/0x2E8D07593389DDB1d84421D41e1d5fe120DCd99C) | solmate `MockERC20`, 18 decimals, anyone can mint |
| **mUSDC** "Mock USDC" | [`0xd010B2D159a9F43Ce22CDD038c7CC6BfBb2aaE3E`](https://unichain-sepolia.blockscout.com/address/0xd010B2D159a9F43Ce22CDD038c7CC6BfBb2aaE3E) | solmate `MockERC20`, 6 decimals, anyone can mint |
| CREATE2 deployer | [`0x4e59b44847b379578588920ca78fbf26c0b4956c`](https://unichain-sepolia.blockscout.com/address/0x4e59b44847b379578588920ca78fbf26c0b4956c) | The deterministic deployer forge routes salted creates through; the hook address is mined against it |
| Leash (superseded) | [`0x2D01f25225D8CF9AD416d466472b2d8Bf7Dd2880`](https://unichain-sepolia.blockscout.com/address/0x2D01f25225D8CF9AD416d466472b2d8Bf7Dd2880) | First deployment, replaced by the redeploy with the re-audit fixes (commit `bc0dff9`). Not in any JSON file; nothing reads it |

`1301.json` has no `pool` key: `DeployLeash` deploys only the hook, and treasuries create pools by calling `createMandate`. The frontend discovers those mandates from Leash's event logs, starting at `block`. `script/Settle.s.sol` needs a `pool` key, so the keeper does nothing on 1301 until one is added (see [`../scripts/README.md`](../scripts/README.md#keepersh)).

The frontend merges `1301-tokens.json` into the Unichain Sepolia deployment (`frontend/src/app/chain.ts`), so the create form starts with TKN and mUSDC filled in. To get some, mint them to your wallet:

```bash
TO=0xYourWallet forge script script/Tokens.s.sol:Faucet --rpc-url unichain_sepolia --broadcast
```

## Local Anvil (31337)

[`31337.json`](31337.json) is written by `script/Local.s.sol` on a fresh anvil. Every address is deterministic (account #0's nonces, plus CREATE2 for Leash), so a fresh `./scripts/local.sh` reproduces the same file.

| Key | Value | What it is |
|---|---|---|
| `chainId` | `31337` | |
| `block` | `0` | First block the frontend scans for events |
| `poolManager` | `0x5FbDB2315678afecb367f032d93F642f64180aa3` | `PoolManager`, owner #0 |
| `swapRouter` | `0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512` | v4-core's `PoolSwapTest` |
| `tkn` | `0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0` | Mock TKN, 18 decimals |
| `usdc` | `0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9` | Mock mUSDC, 6 decimals |
| `leash` | `0x46071202305a52705A505B9B4e325916B037e880` | Leash, low 14 bits `0x2880` |
| `pool.currency0` / `pool.currency1` | TKN / mUSDC | Sorted by address, so the stablecoin is `currency1` (`stableIs0 = false`) |
| `pool.fee` | `8388608` | `0x800000`, v4's dynamic-fee flag |
| `pool.tickSpacing` | `60` | |
| `pool.hooks` | Leash | |
| `pool.id` | `0x4921eb92f92208acedf2f658bb8c06efd221f5d2d9f97f5a874f42ee2baf68c1` | `keccak256(abi.encode(poolKey))` |
| `accounts.treasury` | `0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266` | Anvil #0 |
| `accounts.manager1` | `0x70997970C51812dc3A010C7d01b50e0d17dc79C8` | Anvil #1 |
| `accounts.manager2` | `0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC` | Anvil #2, leads the auction |
| `accounts.swapper` | `0x90F79bf6EB2c4f870365E785982E1f101E93b906` | Anvil #3 |

These keys are anvil's public development keys. They exist only on a local chain and must never hold anything of value.

## The ABI

[`abi/Leash.json`](abi/Leash.json) is the `abi` field of forge's artifact, nothing else. It is regenerated by `scripts/local.sh` after every local deploy:

```bash
jq .abi out/Leash.sol/Leash.json > deployments/abi/Leash.json
```

Nothing regenerates it on a testnet deploy. After changing `src/Leash.sol`, run `forge build` and the line above (or `./scripts/local.sh`) so the app's ABI matches the deployed contract. The frontend appends ten v4-core error signatures (`PoolAlreadyInitialized`, `TickMisaligned`, `WrappedError` and others) to it in `chain.ts`, so it can decode reverts that surface from the PoolManager through Leash.

## How the Frontend Compiles Them In

`frontend/src/app/chain.ts` imports three files directly:

```ts
import leashJson from '../../../deployments/abi/Leash.json' with { type: 'json' };
import dep1301 from '../../../deployments/1301.json' with { type: 'json' };
import dep31337 from '../../../deployments/31337.json' with { type: 'json' };
```

- Vite inlines them into the bundle at build time. `frontend/vite.config.ts` sets `server.fs.allow: ['..']` so the dev server may serve files outside `frontend/`.
- `NETS[1301].dep` and `NETS[31337].dep` are these objects, typed as `Deployment` (`chainId`, `leash`, `poolManager`, `block`, optional `tkn`, `usdc`, `swapRouter`).
- `leash` is the address for every read and write, `poolManager` is read through `extsload` for pool state, `block` is where the incremental event scan starts, and `tkn` / `usdc` prefill the create form.
- `verify.ts` uses `NETS[31337]` and reads `dep.tkn` and `dep.usdc`.

No address comes from a server or an environment variable. A deployed site shows exactly the addresses that were in this folder when it was built. See [`../frontend/README.md`](../frontend/README.md).

## Broadcast Records

Forge writes one record per broadcast run to `broadcast/<Script>.s.sol/<chainId>/run-<timestamp>.json`, and copies the latest to `run-latest.json`. Each record has the transactions (type, contract name, address, hash, calldata) and their receipts. They are the audit trail behind the addresses above.

| Folder | Runs | What they did |
|---|---|---|
| `broadcast/DeployLeash.s.sol/1301/` | 5 | `run-1795515766584`: CREATE2 of Leash at `0x2D01...2880` (superseded). `run-1795516800888`: CREATE2 of Leash at `0x9F1e...6880` (superseded), tx [`0xd51b0f9e...a433`](https://unichain-sepolia.blockscout.com/tx/0xd51b0f9e610555b0c1af73f616386e9c253b78d07fab324eae680f47a155a433). `run-1795544241801` and `run-1795544270863`: CREATE2 of `LeashOracle` at `0x6562...786f`, then Leash at `0xbB07...6880` (superseded). The latest run (= `run-latest`): CREATE2 of `LeashOracle` at `0x5F27...a64b`, then Leash at `0xA8e4...2880` |
| `broadcast/Tokens.s.sol/1301/` | 3 | `run-1795524411144`: `Tokens`, two CREATEs and two mints. `run-1795524453674` and `run-1795537325904`: `Faucet`, two mints each. Forge files `Faucet` runs here too because the record is keyed by the script file |
| `broadcast/Local.s.sol/31337/` | local only | Gitignored (`/broadcast/*/31337/`) |
| `broadcast/**/dry-run/` | simulations | Gitignored |

## Rules

- **Public values only.** Addresses, chain ids, block numbers, pool ids, the ABI. Never a private key, mnemonic other than anvil's public one, RPC key or API key. Keys live in the repo-root `.env`, which is gitignored; [`../.env.example`](../.env.example) lists the names.
- **Scripts write, people do not.** Each file is the output of a script run. To change an address, rerun the script; the broadcast record then backs the new value.
- **Commit after a testnet deploy.** The frontend only sees a new address once the JSON is committed and the site rebuilt.
- **Simulations write too.** `forge script` without `--broadcast` still runs `vm.writeJson`. After a dry run, check `git diff deployments/` and restore the file if nothing was sent.
- **Keep the ABI in step with the code.** A stale `abi/Leash.json` compiles fine and fails at runtime.
