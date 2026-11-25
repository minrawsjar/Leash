// Chain access for the Leash app: networks, ABI, reads and the math to show them. No DOM here, so the
// verify script (verify.ts) can import it under plain node.
import {
  createPublicClient, defineChain, fallback, http, keccak256, encodeAbiParameters, parseEventLogs, erc20Abi, zeroAddress,
  type Abi, type Address, type Hex, type PublicClient,
} from 'viem';
import leashJson from '../../../deployments/abi/Leash.json' with { type: 'json' };
import dep1301 from '../../../deployments/1301.json' with { type: 'json' };
import tok1301 from '../../../deployments/1301-tokens.json' with { type: 'json' }; // TKN and mUSDC: the create form's defaults
import dep31337 from '../../../deployments/31337.json' with { type: 'json' };

// v4-core errors that can surface through Leash calls (pool creation, tick checks, hook wrapping).
const v4Errors = [
  'error PoolAlreadyInitialized()', 'error TickMisaligned(int24 tick, int24 tickSpacing)',
  'error CurrenciesOutOfOrderOrEqual(address currency0, address currency1)', 'error TicksMisordered(int24 tickLower, int24 tickUpper)',
  'error TickLowerOutOfBounds(int24 tickLower)', 'error TickUpperOutOfBounds(int24 tickUpper)',
  'error TickSpacingTooLarge(int24 tickSpacing)', 'error TickSpacingTooSmall(int24 tickSpacing)',
  'error InvalidSqrtPrice(uint160 sqrtPriceX96)', 'error WrappedError(address target, bytes4 selector, bytes reason, bytes details)',
].map((s) => {
  const [, name, params] = s.match(/error (\w+)\((.*)\)/)!;
  const inputs = params ? params.split(', ').map((p) => ({ type: p.split(' ')[0], name: p.split(' ')[1] })) : [];
  return { type: 'error', name, inputs } as const;
});
export const leashAbi = [...(leashJson as Abi), ...v4Errors] as Abi;
const pmAbi = [{ type: 'function', name: 'extsload', stateMutability: 'view', inputs: [{ name: 'slot', type: 'bytes32' }], outputs: [{ type: 'bytes32' }] }] as const;

export type Deployment = { chainId: number; leash: Address; poolManager: Address; block: number; tkn?: Address; usdc?: Address; swapRouter?: Address };
export type Net = { id: number; name: string; short: string; rpc: string; rpcs?: string[]; explorer: string; logsApi?: string; dep: Deployment };

export const NETS: Record<number, Net> = {
  1301: { id: 1301, name: 'Unichain Sepolia', short: 'Unichain', rpc: 'https://sepolia.unichain.org', rpcs: [import.meta.env?.VITE_UNICHAIN_RPC, 'https://unichain-sepolia-rpc.publicnode.com', 'https://unichain-sepolia.drpc.org', 'https://sepolia.unichain.org'].filter(Boolean) as string[], explorer: 'https://unichain-sepolia.blockscout.com', logsApi: 'https://unichain-sepolia.blockscout.com/api', dep: { ...dep1301, ...tok1301 } as Deployment },
  31337: { id: 31337, name: 'Local anvil', short: 'Local', rpc: 'http://127.0.0.1:8545', explorer: '', dep: dep31337 as Deployment },
};
export const viemChain = (n: Net) => defineChain({
  id: n.id, name: n.name, nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [n.rpc] } }, ...(n.explorer ? { blockExplorers: { default: { name: 'Blockscout', url: n.explorer } } } : {}),
  // Multicall3 is at its usual address on Unichain Sepolia; without it viem's multicall batching quietly does nothing.
  ...(n.id === 1301 ? { contracts: { multicall3: { address: '0xcA11bde05977b3631167028862bE2a173976CA11' as const } } } : {}),
});
const clients = new Map<number, PublicClient>();
export const client = (n: Net): PublicClient => {
  if (!clients.has(n.id)) clients.set(n.id, createPublicClient({
    chain: viemChain(n),
    // Public testnet RPCs rate-limit per IP: spread across several, retry with backoff, batch every round trip.
    transport: n.rpcs
      ? fallback(n.rpcs.map((u) => http(u, { batch: true, retryCount: 2, retryDelay: 400 })))
      : http(n.rpc, { batch: true }),
    batch: { multicall: true },
    pollingInterval: n.rpcs ? 2000 : 1000,
  }) as PublicClient);
  return clients.get(n.id)!;
};

// ---------------------------------------------------------------- types mirroring Leash.sol
export type Key = { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address };
export type Terms = {
  stableIs0: boolean; maxFee: number; auctionEnd: number; epochLength: number; epochs: number; minBond: bigint;
  twapWindow: number; maxTickDeviation: number; minLiquidity: bigint; uptimeBps: number; managerFeeBps: number;
  startStableBps: number; endStableBps: number; minFee: number; minHalfWidth: number; anchorLiquidity: bigint;
};
export type Mandate = {
  treasury: Address; manager: Address; bond: bigint; idle0: bigint; idle1: bigint; fees0: bigint; fees1: bigint;
  tickLower: number; tickUpper: number; liquidity: bigint; lastCheck: number; settled: number; lastOk: boolean;
  breached: boolean; closed: boolean; swept: boolean; lastRebalance: number; lastGrow: number; terms: Terms;
};
export type EpochRecord = { inSecs: number; outSecs: number; fees0: bigint; fees1: bigint; settled: boolean; clean: boolean };
export type Token = { address: Address; symbol: string; decimals: number };
export type Status = 'auction' | 'active' | 'unhired' | 'ended' | 'breached' | 'closed';
export type LeashLog = { eventName: string; args: Record<string, unknown>; blockNumber: bigint; transactionHash: Hex; logIndex: number };

export const DYNAMIC_FEE = 0x800000;
export const GROW_BPS = 500;
export const MAX_GROW_GAP = 2;
export const MIN_ANCHOR_BPS = 1900;
export const MIN_BOND_BPS = 200; // minBond >= 2% of the deposit's value (ThinBond)
export const MAX_EPOCHS = 104;
export const MAX_LP_FEE = 1_000_000;

export const poolId = (k: Key): Hex => keccak256(encodeAbiParameters(
  [{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }],
  [k.currency0, k.currency1, k.fee, k.tickSpacing, k.hooks]));
export const stableOf = (k: Key, t: Terms) => (t.stableIs0 ? k.currency0 : k.currency1);
export const endOf = (t: Terms) => t.auctionEnd + t.epochLength * t.epochs;
export const epochAt = (t: Terms, now: number) => (now < t.auctionEnd ? 0 : Math.floor((now - t.auctionEnd) / t.epochLength));

export function statusOf(m: Mandate, now: number): Status {
  if (m.closed) return 'closed';
  if (m.breached) return 'breached';
  if (now < m.terms.auctionEnd) return 'auction';
  if (m.manager === zeroAddress) return 'unhired';
  if (now >= endOf(m.terms)) return 'ended';
  return 'active';
}

/** The glide path's stablecoin cap (bps) at time `now`, as Leash._glide computes it. */
export function glideAt(t: Terms, now: number): number {
  const start = t.auctionEnd, end = endOf(t);
  const el = now < start ? 0 : Math.min(now, end) - start;
  const a = t.startStableBps, b = t.endStableBps;
  return b >= a ? a + Math.floor(((b - a) * el) / (end - start)) : a - Math.floor(((a - b) * el) / (end - start));
}

// ---------------------------------------------------------------- price math (floats: display only, the chain decides)
export const minTick = (ts: number) => Math.ceil(-887272 / ts) * ts;
export const maxTick = (ts: number) => Math.floor(887272 / ts) * ts;
const sqrtAt = (tick: number) => Math.pow(1.0001, tick / 2);
/** Stablecoin per token, human units, at `tick`. */
export function priceAt(tick: number, _k: Key, t: Terms, tok: [Token, Token]): number {
  const raw = Math.pow(1.0001, tick) * Math.pow(10, tok[0].decimals - tok[1].decimals); // currency1 per currency0
  return t.stableIs0 ? 1 / raw : raw;
}
/** Raw token amounts of `liq` over [lo, hi) at `tick`. */
export function amountsAt(tick: number, lo: number, hi: number, liq: bigint): [number, number] {
  const L = Number(liq), p = sqrtAt(tick), a = sqrtAt(lo), b = sqrtAt(hi);
  const sp = Math.min(Math.max(p, a), b);
  return [L * (1 / sp - 1 / b), L * (sp - a)];
}
/** Liquidity that `x` of currency0 and `y` of currency1 (raw) buy over [lo, hi) at sqrt price `sp` (not a tick). */
export function liquidityFor(sp: number, lo: number, hi: number, x: number, y: number): number {
  const a = sqrtAt(lo), b = sqrtAt(hi);
  if (sp <= a) return (x * a * b) / (b - a);
  if (sp >= b) return y / (b - a);
  return Math.min((x * sp * b) / (b - sp), y / (sp - a));
}
export const tickOfRaw = (raw: number) => Math.floor(Math.log(raw) / Math.log(1.0001));

/** Slot0 straight from PoolManager storage (StateLibrary: pools mapping at slot 6). */
export async function slot0(n: Net, id: Hex, blockNumber?: bigint) {
  const slot = keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint256' }], [id, 6n]));
  const v = BigInt(await client(n).readContract({ address: n.dep.poolManager, abi: pmAbi, functionName: 'extsload', args: [slot], blockNumber }));
  let tick = Number((v >> 160n) & 0xffffffn);
  if (tick >= 0x800000) tick -= 0x1000000;
  return { sqrtPriceX96: v & ((1n << 160n) - 1n), tick, lpFee: Number((v >> 208n) & 0xffffffn) };
}

// ---------------------------------------------------------------- logs
type RawLog = { address: Address; topics: Hex[]; data: Hex; blockNumber: bigint | Hex | null; transactionHash: Hex | null; logIndex: number | Hex | null };
// Logs already scanned, per network: each poll asks only for blocks after `to`.
const scanned = new Map<number, { to: bigint; logs: RawLog[] }>();
const MARGIN = 64n;

/** Every Leash event since deployment, over RPC. Scans incrementally; if a node refuses a wide range, steps 1000 blocks. */
export async function leashLogs(n: Net): Promise<LeashLog[]> {
  const c = client(n);
  const seen = scanned.get(n.id) ?? { to: BigInt(n.dep.block) - 1n, logs: [] };
  const head = await c.getBlockNumber();
  let from = seen.to + 1n;
  const got: RawLog[] = [];
  if (from <= head) {
    try {
      got.push(...((await c.getLogs({ address: n.dep.leash, fromBlock: from, toBlock: head })) as RawLog[]));
    } catch {
      for (; from <= head; from += 1000n) {
        const to = from + 999n < head ? from + 999n : head;
        got.push(...((await c.getLogs({ address: n.dep.leash, fromBlock: from, toBlock: to })) as RawLog[]));
      }
    }
  }
  const raw = [...seen.logs, ...got];
  // The fallback RPCs disagree by a few blocks: the node that answered getLogs can be behind the one that gave `head`
  // and return nothing for its newest blocks. So only blocks MARGIN behind the head count as scanned; the rest are
  // read again next poll (a mandate posted just now otherwise vanished until a reload).
  const to = head - MARGIN > seen.to ? head - MARGIN : seen.to;
  scanned.set(n.id, { to, logs: [...seen.logs, ...got.filter((l) => BigInt(l.blockNumber!) <= to)] });
  const parsed = parseEventLogs({ abi: leashAbi, logs: raw as never, strict: false });
  return parsed.map((l) => ({
    eventName: l.eventName as string, args: l.args as Record<string, unknown>, blockNumber: BigInt(l.blockNumber as bigint),
    transactionHash: l.transactionHash as Hex, logIndex: Number(l.logIndex),
  })).sort((a, b) => (a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1));
}

// ---------------------------------------------------------------- reads
const tokens = new Map<string, Promise<Token>>();
export function token(n: Net, address: Address): Promise<Token> {
  const k = `${n.id}:${address}`;
  if (!tokens.has(k)) {
    const c = client(n);
    tokens.set(k, Promise.all([
      c.readContract({ address, abi: erc20Abi, functionName: 'symbol' }).catch(() => address.slice(0, 6)),
      c.readContract({ address, abi: erc20Abi, functionName: 'decimals' }).catch(() => 18),
    ]).then(([symbol, decimals]) => ({ address, symbol, decimals: Number(decimals) })));
  }
  return tokens.get(k)!;
}

const read = <T,>(n: Net, functionName: string, args: unknown[]) =>
  client(n).readContract({ address: n.dep.leash, abi: leashAbi, functionName, args }) as Promise<T>;

export type Snapshot = {
  id: Hex; key: Key; m: Mandate; tok: [Token, Token]; now: number; block: bigint;
  spot: number; sqrtPriceX96: bigint; lpFee: number; twap: number; epoch: number;
  comp: { inRange: boolean; deep: boolean; onPace: boolean; stableBps: number }; status: Status; fetched: number;
};
/** Chain time now, from the last block's timestamp plus the wall-clock time since it was read. */
export const chainNow = (s: { now: number; fetched: number }, wallMs = Date.now()) => s.now + Math.max(0, wallMs / 1000 - s.fetched);

/** One mandate's state right now (one batched RPC round trip). */
export async function snapshot(n: Net, id: Hex, key: Key): Promise<Snapshot> {
  const [m, blk, s0, twap, epoch, comp, t0, t1] = await Promise.all([
    read<Mandate>(n, 'mandate', [id]),
    client(n).getBlock(),
    slot0(n, id),
    read<number>(n, 'twapTick', [key]),
    read<bigint>(n, 'currentEpoch', [key]),
    read<[boolean, boolean, boolean, number]>(n, 'compliance', [key]),
    token(n, key.currency0),
    token(n, key.currency1),
  ]);
  // anvil only mines on demand, so its last block can be far behind the time the next one will get
  const now = n.id === 31337 ? Math.max(Number(blk.timestamp), Math.floor(Date.now() / 1000)) : Number(blk.timestamp);
  return {
    id, key, m, tok: [t0, t1], now, block: blk.number, spot: s0.tick, sqrtPriceX96: s0.sqrtPriceX96, lpFee: s0.lpFee,
    twap: Number(twap), epoch: Number(epoch), comp: { inRange: comp[0], deep: comp[1], onPace: comp[2], stableBps: Number(comp[3]) },
    status: statusOf(m, now), fetched: Date.now() / 1000,
  };
}

export const epochRecords = (n: Net, id: Hex, epochs: number) =>
  Promise.all(Array.from({ length: epochs }, (_, e) => read<EpochRecord>(n, 'epochRecord', [id, BigInt(e)])));
export const owed = (n: Net, who: Address, c: Address) => read<bigint>(n, 'owed', [who, c]);
export const trackRecord = (n: Net, who: Address) => read<[number, number]>(n, 'records', [who]).then(([clean, breached]) => ({ clean: Number(clean), breached: Number(breached) }));

/** Mandates from MandateCreated logs. */
export const mandatesFrom = (logs: LeashLog[]) =>
  logs.filter((l) => l.eventName === 'MandateCreated').map((l) => ({ id: l.args.id as Hex, key: l.args.key as Key, treasury: l.args.treasury as Address, block: l.blockNumber }));

/** One event in plain words, with a tone for its dot: [tone, text]. */
export function describe(l: LeashLog, s: Snapshot): [string, string] {
  const t = s.m.terms;
  const [token, stable] = t.stableIs0 ? [s.tok[1], s.tok[0]] : [s.tok[0], s.tok[1]];
  const a = l.args as Record<string, never>;
  switch (l.eventName) {
    case 'MandateCreated': return ['mint', `Posted by ${short(a.treasury)}: ${fmt(t.stableIs0 ? a.amount1 : a.amount0, token.decimals)} ${token.symbol} + ${fmt(t.stableIs0 ? a.amount0 : a.amount1, stable.decimals)} ${stable.symbol}`];
    case 'Bid': return ['violet', `${short(a.bidder)} bid ${fmt(a.amount, stable.decimals)} ${stable.symbol}`];
    case 'Rebalanced': { const [x, y] = [priceAt(a.tickLower, s.key, t, s.tok), priceAt(a.tickUpper, s.key, t, s.tok)].sort((p, q) => p - q); return ['mint', `Range moved to ${fmtPrice(x)}–${fmtPrice(y)} (ticks ${a.tickLower}…${a.tickUpper}), liquidity ${fmtLiq(a.liquidity)}`]; }
    case 'FeeSet': return ['', `Fee set to ${feePct(Number(a.fee))}`];
    case 'EpochSettled': return a.clean
      ? ['mint', `Epoch ${Number(a.epoch) + 1} clean: manager paid ${fmt(t.stableIs0 ? a.pay1 : a.pay0, token.decimals, 4)} ${token.symbol} + ${fmt(t.stableIs0 ? a.pay0 : a.pay1, stable.decimals, 4)} ${stable.symbol}`]
      : ['rose', `Epoch ${Number(a.epoch) + 1} missed its uptime: ${fmt(a.slashed, stable.decimals)} ${stable.symbol} of the bond slashed to the treasury`];
    case 'Closed': return ['', 'Closed: inventory and fees returned to the treasury'];
    default: return ['', l.eventName];
  }
}

// ---------------------------------------------------------------- formatting
export function fmt(raw: bigint | number, decimals: number, digits = 2): string {
  const v = typeof raw === 'bigint' ? Number(raw) / 10 ** decimals : raw / 10 ** decimals;
  return fmtNum(v, digits);
}
export function fmtNum(v: number, digits = 2): string {
  if (!isFinite(v)) return '–';
  const a = Math.abs(v);
  if (a >= 1e9) return (v / 1e9).toFixed(2) + 'B';
  if (a >= 1e6) return (v / 1e6).toFixed(2) + 'M';
  if (a !== 0 && a < 10 ** -digits) return v.toPrecision(2);
  return v.toLocaleString('en-US', { maximumFractionDigits: a < 1 ? Math.max(digits, 4) : digits });
}
/** Raw liquidity: meaningless as a plain number, so compact scientific. */
export const fmtLiq = (x: bigint) => (x === 0n ? '0' : Number(x).toExponential(2).replace('e+', 'e'));
/** A price with five significant digits, trailing zeros kept so 2.0000 and 2.0020 line up. */
export const fmtPrice = (v: number) => (!isFinite(v) ? '–' : Math.abs(v) >= 1000 ? fmtNum(v, 2) : v.toPrecision(5));
const times = new Map<string, Promise<number>>();
/** A block's timestamp, cached (blocks never change). */
export function blockTime(n: Net, b: bigint): Promise<number> {
  const k = `${n.id}:${b}`;
  if (!times.has(k)) times.set(k, client(n).getBlock({ blockNumber: b }).then((x) => Number(x.timestamp)));
  return times.get(k)!;
}
export const ago = (s: number) => (s < 60 ? 'just now' : `${dur(s).split(' ')[0]} ago`);
export const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
export const pct = (bps: number, d = 1) => `${(bps / 100).toFixed(d)}%`;
export const feePct = (pips: number) => `${(pips / 10_000).toFixed(pips % 100 ? 3 : 2)}%`;
export function dur(s: number): string {
  s = Math.max(0, Math.round(s));
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  if (d) return h ? `${d}d ${h}h` : `${d}d`;
  if (h) return m ? `${h}h ${m}m` : `${h}h`;
  if (m) return x ? `${m}m ${String(x).padStart(2, '0')}s` : `${m}m`;
  return `${x}s`;
}
