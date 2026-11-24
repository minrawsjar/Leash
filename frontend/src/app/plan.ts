// Turns the create-mandate form into createMandate's arguments, and lists every check createMandate makes
// (BadTerms, ThinAnchor, NotLeashPool, ranges) in plain words before anything is signed. Pure: verify.ts uses it too.
import { parseUnits, type Address } from 'viem';
import {
  DYNAMIC_FEE, MAX_EPOCHS, MAX_LP_FEE, MIN_ANCHOR_BPS, liquidityFor, maxTick, minTick, poolId, tickOfRaw,
  type Key, type Terms, type Token,
} from './chain.ts';
import type { Position } from './actions.ts';
import type { Draft } from '../../api/draft.ts';

/** The form, in the units people think in (hours, minutes, %, whole tokens). plan() turns it into Terms. */
export type Form = {
  token: string; stable: string; tickSpacing: number; price: string; tokenAmount: string; stableAmount: string;
  rangePct: number; positionPct: number; anchorPct: number;
  maxFeePct: string; minFeePct: string; auctionHours: number; epochHours: number; epochs: number; minBond: string;
  twapMins: number; maxTickDeviation: number; minHalfWidth: number; floorPct: number; uptimePct: number;
  managerFeePct: number; startStablePct: number; endStablePct: number;
};
export type Field = keyof Form;

export const PRESETS: Record<string, { label: string; note: string; f: Partial<Form> }> = {
  demo: {
    label: 'Demo · 3 × 1 hour', note: 'The local chain\'s seeded mandate: short epochs, a 2-minute TWAP, a 15-minute auction.',
    f: { maxFeePct: '1', minFeePct: '0.05', auctionHours: 0.25, epochHours: 1, epochs: 3, minBond: '1000', twapMins: 2, maxTickDeviation: 100, minHalfWidth: 200, floorPct: 50, uptimePct: 95, managerFeePct: 30, startStablePct: 60, endStablePct: 80 },
  },
  quarter: {
    label: 'Quarter · 12 × 1 week', note: 'A real treasury mandate: weekly epochs, a 30-minute TWAP, a one-day auction.',
    f: { maxFeePct: '1', minFeePct: '0.05', auctionHours: 24, epochHours: 168, epochs: 12, minBond: '25000', twapMins: 30, maxTickDeviation: 100, minHalfWidth: 300, floorPct: 50, uptimePct: 95, managerFeePct: 20, startStablePct: 55, endStablePct: 75 },
  },
};

export const defaultForm = (tkn = '', usdc = ''): Form => ({
  token: tkn, stable: usdc, tickSpacing: 60, price: '2', tokenAmount: '100000', stableAmount: '200000',
  rangePct: 12, positionPct: 50, anchorPct: 20, ...PRESETS.demo.f,
} as Form);

/** Every problem once, in order, plus the first one per field so the form can show it beside the input. */
export type Plan = {
  key: Key; id: `0x${string}`; sqrtPriceX96: bigint; terms: Terms; amount0: bigint; amount1: bigint; initial: Position;
  openTick: number; openStableBps: number; anchorBps: number; problems: string[]; at: Partial<Record<Field, string>>; owner: Record<string, Field>; warnings: string[];
};
type Early = { problems: string[]; at: Partial<Record<Field, string>>; owner: Record<string, Field> };

const isAddr = (a: string): a is Address => /^0x[0-9a-fA-F]{40}$/.test(a);

/** `now` is chain time (s); `tok`/`stb` are the two tokens' metadata (null while unknown). */
export function plan(f: Form, hook: Address, tok: Token | null, stb: Token | null, now: number): Plan | Early {
  const problems: string[] = [];
  const at: Partial<Record<Field, string>> = {};
  const owner: Record<string, Field> = {}; // problem → the field it belongs to
  const bad = (field: Field | Field[], msg: string, each: Partial<Record<Field, string>> = {}) => { problems.push(msg); owner[msg] ??= [field].flat()[0]; for (const k of [field].flat()) at[k] ??= each[k] ?? msg; };
  const early = (field: Field | null, msg: string): Early => { if (field) bad(field, msg); else problems.push(msg); return { problems, at, owner }; };
  if (!isAddr(f.token)) return early('token', 'Enter the treasury token\'s address (0x and 40 hex characters).');
  if (!isAddr(f.stable)) return early('stable', 'Enter the stablecoin\'s address (0x and 40 hex characters).');
  if (f.token.toLowerCase() === f.stable.toLowerCase()) return early('stable', 'The token and the stablecoin must differ.');
  if (!tok || !stb) return early(null, 'Reading the tokens… (each must be a deployed ERC-20).');
  const stableIs0 = f.stable.toLowerCase() < f.token.toLowerCase();
  const [t0, t1] = stableIs0 ? [stb, tok] : [tok, stb];
  const ts = Math.round(f.tickSpacing);
  if (!(ts >= 1 && ts <= 32767)) bad('tickSpacing', 'Tick spacing must be 1–32767.');
  const key: Key = { currency0: t0.address, currency1: t1.address, fee: DYNAMIC_FEE, tickSpacing: ts, hooks: hook };

  const units = (s: string, d: number, field: Field) => { try { return parseUnits(s || '0', d); } catch { bad(field, 'Use a plain number, like 25000 or 0.5.'); return 0n; } };
  const tokenRaw = units(f.tokenAmount, tok.decimals, 'tokenAmount');
  const stableRaw = units(f.stableAmount, stb.decimals, 'stableAmount');
  const minBond = units(f.minBond, stb.decimals, 'minBond');
  const P = Number(f.price);
  if (!(P > 0)) return early('price', 'Enter an opening price above zero.');
  if (tokenRaw === 0n) bad('tokenAmount', 'Deposit some of both tokens: the opening position needs both sides.');
  if (stableRaw === 0n) bad('stableAmount', 'Deposit some of both tokens: the opening position needs both sides.');

  // currency1 per currency0, raw units
  const raw = stableIs0 ? 10 ** tok.decimals / (P * 10 ** stb.decimals) : P * 10 ** (stb.decimals - tok.decimals);
  const sp = Math.sqrt(raw);
  const sqrtPriceX96 = BigInt(Math.floor(sp * 2 ** 96));
  const openTick = tickOfRaw(raw);
  const [x0, x1] = stableIs0 ? [Number(stableRaw), Number(tokenRaw)] : [Number(tokenRaw), Number(stableRaw)];

  // the opening position: +-rangePct around the opening price, on the tick grid
  const w = Math.max(ts, Math.round(Math.log(1 + f.rangePct / 100) / Math.log(1.0001) / ts) * ts);
  const base = Math.floor(openTick / ts) * ts;
  const lo = base - w, hi = base + w;
  const L = Math.floor(liquidityFor(sp, lo, hi, (x0 * f.positionPct) / 100, (x1 * f.positionPct) / 100) * 0.999);
  const mn = minTick(ts), mx = maxTick(ts);
  const La = Math.floor(liquidityFor(sp, mn, mx, (x0 * f.anchorPct) / 100, (x1 * f.anchorPct) / 100) * 0.999);
  const sa = Math.pow(1.0001, mn / 2), sb = Math.pow(1.0001, mx / 2);
  const anchorValue = La * (1 / sp - 1 / sb) * raw + La * (sp - sa);
  const depositValue = x0 * raw + x1;
  const anchorBps = depositValue ? Math.floor((anchorValue / depositValue) * 10_000) : 0;
  const stableValue = stableIs0 ? x0 * raw : x1;
  const openStableBps = depositValue ? Math.round((stableValue / depositValue) * 10_000) : 0;

  const bps = (p: number) => Math.round(p * 100);
  const pips = (s: string) => Math.round(Number(s) * 10_000);
  const twapWindow = Math.round(f.twapMins * 60), auctionSecs = Math.round(f.auctionHours * 3600);
  const terms: Terms = {
    stableIs0, maxFee: pips(f.maxFeePct), auctionEnd: Math.floor(now + auctionSecs), epochLength: Math.round(f.epochHours * 3600),
    epochs: Math.round(f.epochs), minBond, twapWindow, maxTickDeviation: Math.round(f.maxTickDeviation),
    minLiquidity: BigInt(Math.floor((L * f.floorPct) / 100)), uptimeBps: bps(f.uptimePct), managerFeeBps: bps(f.managerFeePct),
    startStableBps: bps(f.startStablePct), endStableBps: bps(f.endStablePct), minFee: pips(f.minFeePct),
    minHalfWidth: Math.round(f.minHalfWidth), anchorLiquidity: BigInt(La),
  };

  // createMandate's BadTerms, one by one
  if (terms.twapWindow <= 0) bad('twapMins', 'The TWAP window must be at least 1 second.');
  if (auctionSecs < terms.twapWindow + 60) bad('auctionHours', `The auction must outlast the TWAP window (${f.twapMins} min) plus a minute for the transaction to land, so the oracle has a full window before the manager acts.`);
  if (terms.epochLength <= 0) bad('epochHours', 'Epochs must last at least 1 second.');
  if (terms.epochs < 1 || terms.epochs > MAX_EPOCHS) bad('epochs', `Between 1 and ${MAX_EPOCHS} epochs.`);
  if (!(terms.maxFee >= 0 && terms.maxFee <= MAX_LP_FEE)) bad('maxFeePct', 'The fee cap must be 0–100%.');
  if (!(terms.minFee >= 0 && terms.minFee <= terms.maxFee)) bad('minFeePct', 'The fee floor must not exceed the fee cap.');
  if (terms.minLiquidity <= 0n) bad('floorPct', 'The depth floor works out to zero: raise the floor % or the position.');
  for (const [v, k, n] of [[terms.uptimeBps, 'uptimePct', 'Uptime'], [terms.managerFeeBps, 'managerFeePct', 'The manager\'s share'], [terms.startStableBps, 'startStablePct', 'The start cap'], [terms.endStableBps, 'endStablePct', 'The end cap']] as const)
    if (!(v >= 0 && v <= 10_000)) bad(k, `${n} must be 0–100%.`);
  if (terms.maxTickDeviation >= terms.minHalfWidth) bad(['maxTickDeviation', 'minHalfWidth'], 'The minimum half-width must exceed the max spot–TWAP gap, so a pushed spot can never reach the edge of the range.',
    { maxTickDeviation: `Must be below the minimum half-width (${terms.minHalfWidth} ticks).`, minHalfWidth: `Must exceed the max spot–TWAP gap (${terms.maxTickDeviation} ticks).` });
  if (terms.anchorLiquidity <= 0n) bad('anchorPct', 'The anchor works out to zero liquidity.');
  // ThinAnchor and the opening position's own checks (_place, with TWAP = spot = the opening tick)
  if (anchorBps < MIN_ANCHOR_BPS) bad('anchorPct', `The anchor holds ${(anchorBps / 100).toFixed(1)}% of the deposit's value; it must hold at least ${MIN_ANCHOR_BPS / 100}% (ThinAnchor).`);
  if (f.positionPct + f.anchorPct > 100) bad(['positionPct', 'anchorPct'], 'The opening position and the anchor together can use at most 100% of the deposit.', { anchorPct: `With ${f.positionPct}% in the position, at most ${100 - f.positionPct}% is left.` });
  if (BigInt(L) < terms.minLiquidity || L <= 0) bad(['positionPct', 'floorPct'], 'The opening position is below the depth floor.', { floorPct: 'Above the opening position itself; keep it at or under 100%.' });
  if (lo > openTick - terms.minHalfWidth || hi < openTick + terms.minHalfWidth) bad('rangePct', `The opening range (±${w} ticks) must cover the opening price ± the minimum half-width (${terms.minHalfWidth} ticks): widen it to at least ±${((Math.pow(1.0001, terms.minHalfWidth + ts) - 1) * 100).toFixed(1)}%.`);
  if (lo < mn || hi > mx) bad('rangePct', 'The opening range runs past the price limits.');
  if (sqrtPriceX96 < 4295128739n || sqrtPriceX96 >= 1461446703485210103287273052203988822378723970342n) bad('price', 'That price is outside Uniswap\'s range.');

  const warnings: string[] = [];
  if (openStableBps > terms.startStableBps) warnings.push(`The deposit opens at ${(openStableBps / 100).toFixed(1)}% stablecoin, above the starting cap of ${f.startStablePct}%: epoch 0 would start off pace and count against the manager.`);
  if (terms.uptimeBps === 10_000) warnings.push('100% uptime means one bad interval breaches the epoch.');

  const [amount0, amount1] = stableIs0 ? [stableRaw, tokenRaw] : [tokenRaw, stableRaw];
  return {
    key, id: poolId(key), sqrtPriceX96, terms, amount0, amount1, initial: { tickLower: lo, tickUpper: hi, liquidity: BigInt(L) },
    openTick, openStableBps, anchorBps, problems, at, owner, warnings,
  };
}

/** Writes the assistant's draft into the form: only the fields it set, addresses only when well-formed. */
export function applyDraft(f: Form, d: Draft): { form: Form; why: Partial<Record<Field, string>> } {
  const form: Record<string, string | number> = { ...f };
  const why: Partial<Record<Field, string>> = {};
  for (const k of Object.keys(f) as Field[]) {
    const v = (d as unknown as Record<string, { value: string | number; why: string } | null | undefined>)[k];
    if (v == null || v.value == null) continue;
    if ((k === 'token' || k === 'stable') && !isAddr(String(v.value))) continue;
    if (typeof f[k] === 'number' && !isFinite(Number(v.value))) continue;
    form[k] = typeof f[k] === 'string' ? String(v.value) : Number(v.value);
    why[k] = v.why;
  }
  return { form: form as Form, why };
}
