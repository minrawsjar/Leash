// Runs a price path through a draft mandate's rules before it is posted: a TWAP over twapWindow, a manager who
// keeps the range around it within the rebalance guards, and the checkpoint's booking. Pure, no chain: an
// approximation of Leash.sol for picking rules, not a promise. Self-check: node src/app/backtest.test.ts
import { GROW_BPS, MAX_GROW_GAP, liquidityFor } from './chain.ts';
import type { Form } from './plan.ts';

export type PathKind = 'calm' | 'choppy' | 'up' | 'down' | 'crash';
export const PATHS: [PathKind, string][] = [
  ['calm', 'Calm'], ['choppy', 'Choppy'], ['up', 'Fast trend up'], ['down', 'Fast trend down'], ['crash', 'Flash crash and recover'],
];

const LN = Math.log(1.0001);
const tickOf = (p: number) => Math.log(p) / LN;
const sq = (tick: number) => Math.pow(1.0001, tick / 2);
const FULL = 887272;

/** Seeded uniform [0, 1) (mulberry32) and a standard normal from it. */
function rng(seed: number) {
  let a = seed >>> 0;
  const u = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  return () => Math.sqrt(-2 * Math.log(1 - u())) * Math.cos(2 * Math.PI * u());
}

/** A deterministic price path: `n` prices `dt` seconds apart, starting at `p0`. Moves are set in real time, so a
 *  trend is as fast against a 2-minute TWAP on a 3-hour mandate as on a 12-week one. */
export function preset(kind: PathKind, p0: number, n: number, dt: number, seed = 1): number[] {
  const z = rng(seed * 7919 + kind.length);
  const T = n * dt, h = dt / 3600;
  const vol = kind === 'choppy' ? 0.015 : 0.003; // per hour
  // the scripted move: [start, length, total log move] for the trends; the crash falls 25% in 10 min, back in an hour
  const span = Math.min(3 * 3600, T / 3), t0 = T / 4;
  let x = 0;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = i * dt;
    x += vol * Math.sqrt(h) * z();
    if (kind === 'choppy') x -= x * Math.min(1, h / 2); // pulls back, half-life about 2h
    let move = 0;
    if (kind === 'up' || kind === 'down') move = (kind === 'up' ? 1 : -1) * Math.log(1.3) * Math.min(1, Math.max(0, (t - t0) / span));
    if (kind === 'crash') {
      const c = T / 2, fall = Math.min(600, T / 20), back = Math.min(3600, T / 6);
      move = Math.log(0.75) * (t < c ? 0 : t < c + fall ? (t - c) / fall : t < c + fall + back ? 1 - (t - c - fall) / back : 0);
    }
    out.push(p0 * Math.exp(x + move));
  }
  return out;
}

/** Prices from pasted text: one per line (the last number on each line, so "time,price" works too). */
export function parseCsv(text: string): number[] {
  return text.split(/\r?\n/).map((l) => l.match(/-?\d*\.?\d+(?:e-?\d+)?/gi)?.pop()).map(Number).filter((v) => v > 0 && isFinite(v));
}

/** Stretches `src` evenly over `n` points (linear interpolation). */
export function resample(src: number[], n: number): number[] {
  if (src.length < 2) return Array(n).fill(src[0] ?? 1);
  return Array.from({ length: n }, (_, i) => {
    const x = (i / (n - 1)) * (src.length - 1), k = Math.min(src.length - 2, Math.floor(x));
    return src[k] + (src[k + 1] - src[k]) * (x - k);
  });
}

export type Rules = Pick<Form, 'price' | 'tokenAmount' | 'stableAmount' | 'tickSpacing' | 'rangePct' | 'positionPct' | 'anchorPct'
  | 'twapMins' | 'maxTickDeviation' | 'minHalfWidth' | 'floorPct' | 'uptimePct' | 'epochHours' | 'epochs' | 'startStablePct' | 'endStablePct'>;
export type EpochResult = { inSecs: number; outSecs: number; clean: boolean; out: { range: number; depth: number; pace: number } };
export type Point = { t: number; spot: number; twap: number; lo: number; hi: number }; // ticks
export type Result = { dt: number; epochs: EpochResult[]; uptime: number; breachedAt: number; rebalances: number; refused: number; short: number; points: Point[] };

/** The grid a run uses: about 12,000 steps over the mandate, and at least 3 per TWAP window when that fits. */
export function grid(r: Rules) {
  const T = r.epochHours * 3600 * r.epochs, tw = Math.max(1, r.twapMins * 60);
  const dt = Math.max(1, Math.min(tw / 3, T / 600), T / 12_000);
  return { T, tw, dt, n: Math.max(2, Math.ceil(T / dt)) };
}

/**
 * One run. `prices` are stablecoin per token, one per `dt` from the end of the auction. The TWAP is warm at the
 * start (flat at the first price, as after the auction). Each step: the keeper checkpoints (an interval is in only
 * if compliant at both ends), then the manager re-centres on the TWAP when it drifts toward an edge, and grows back
 * toward the opening size, refused while spot is more than maxTickDeviation from the TWAP (2 ticks to grow) and
 * growth capped at +5% once per window. The manager can't swap: after a move the inventory is lopsided, so a
 * re-centre may have to shrink, and below the depth floor it is refused (TooShallow) and the range stays behind. Fees, gas and the per-block rules are left out.
 */
export function backtest(r: Rules, prices: number[], dt: number): Result {
  const tw = Math.max(1, r.twapMins * 60), len = r.epochHours * 3600, T = len * r.epochs;
  const w = Math.max(1, Math.round(tw / dt)); // TWAP window in steps
  const p0 = prices[0], t0 = tickOf(p0), s0 = sq(t0);
  const X = Number(r.tokenAmount) || 0, Y = Number(r.stableAmount) || 0;
  const ts = Math.max(1, r.tickSpacing);
  const W = Math.max(r.minHalfWidth, Math.round(Math.log(1 + r.rangePct / 100) / LN / ts) * ts); // the manager's half-width
  const amounts = (tick: number, lo: number, hi: number, L: number): [number, number] => {
    const p = Math.min(Math.max(sq(tick), sq(lo)), sq(hi));
    return [L * (1 / p - 1 / sq(hi)), L * (p - sq(lo))];
  };
  const L0 = liquidityFor(s0, t0 - W, t0 + W, (X * r.positionPct) / 100, (Y * r.positionPct) / 100);
  const La = liquidityFor(s0, -FULL, FULL, (X * r.anchorPct) / 100, (Y * r.anchorPct) / 100);
  const floor = (L0 * r.floorPct) / 100;
  const [px, py] = amounts(t0, t0 - W, t0 + W, L0), [ax, ay] = amounts(t0, -FULL, FULL, La);
  let idle: [number, number] = [X - px - ax, Y - py - ay];
  let lo = t0 - W, hi = t0 + W, L = L0, lastGrow = -Infinity;

  const ring: number[] = Array(w).fill(t0);
  let sum = t0 * w;
  const epochs: EpochResult[] = Array.from({ length: r.epochs }, () => ({ inSecs: 0, outSecs: 0, clean: true, out: { range: 0, depth: 0, pace: 0 } }));
  const glide = (t: number) => r.startStablePct + ((r.endStablePct - r.startStablePct) * Math.min(t, T)) / T;
  const judge = (twap: number, t: number) => {
    const [a, b] = amounts(twap, lo, hi, L), [c, d] = amounts(twap, -FULL, FULL, La);
    const tok = a + c + idle[0], stb = b + d + idle[1], p = Math.pow(1.0001, twap);
    const range = lo <= twap && twap < hi, depth = L >= floor * 0.999_999, pace = (stb / (tok * p + stb || 1)) * 100 <= glide(t) + 1e-9;
    return { ok: range && depth && pace, range, depth, pace };
  };

  let lastOk = judge(t0, 0).ok, rebalances = 0, refused = 0, short = 0;
  const points: Point[] = [];
  const every = Math.max(1, Math.floor(prices.length / 360));
  for (let i = 1; i < prices.length; i++) {
    const t = Math.min(i * dt, T), spot = tickOf(prices[i]);
    sum += spot - ring[i % w]; ring[i % w] = spot;
    const twap = sum / w;
    // keeper: book the interval (i-1, i]
    const j = judge(twap, t), ok = j.ok && lastOk;
    lastOk = j.ok;
    const e = epochs[Math.min(r.epochs - 1, Math.floor(((i - 1) * dt) / len))];
    const secs = t - Math.min((i - 1) * dt, T);
    if (ok) e.inSecs += secs; else { e.outSecs += secs; if (!j.range) e.out.range += secs; if (!j.depth) e.out.depth += secs; if (!j.pace) e.out.pace += secs; }
    // manager
    const drift = Math.abs(twap - (lo + hi) / 2) > (hi - lo) / 2 - r.minHalfWidth || !j.range;
    const gap = Math.abs(spot - twap);
    const canGrow = L < L0 && gap <= MAX_GROW_GAP && t - lastGrow >= tw;
    if (drift || canGrow) {
      if (gap > r.maxTickDeviation) { if (drift) refused++; }
      else {
        const [cx, cy] = amounts(spot, lo, hi, L);
        const have: [number, number] = [idle[0] + cx, idle[1] + cy];
        const want = canGrow ? Math.min(L0, (L * (10_000 + GROW_BPS)) / 10_000) : L;
        // the usual width first; if the lopsided inventory can't fill the floor there, the narrowest legal range
        let done = false;
        for (const h of [W, r.minHalfWidth]) {
          const [ux, uy] = amounts(spot, twap - h, twap + h, 1); // per unit of liquidity
          const nL = Math.min(want, Math.min(ux > 0 ? have[0] / ux : Infinity, uy > 0 ? have[1] / uy : Infinity) * 0.999);
          if (nL < floor) continue; // TooShallow
          if (nL > L) lastGrow = t;
          [lo, hi, L] = [twap - h, twap + h, nL];
          idle = [have[0] - ux * nL, have[1] - uy * nL];
          lastOk = judge(twap, t).ok; // the next interval starts from the new position, as rebalance sets lastOk
          rebalances++; done = true; break;
        }
        if (!done && drift) short++; // the range stays behind
      }
    }
    if (i % every === 0 || i === prices.length - 1) points.push({ t, spot, twap, lo, hi });
  }
  let breachedAt = -1, inAll = 0, outAll = 0;
  epochs.forEach((e, k) => {
    e.clean = e.inSecs * 10_000 >= Math.round(r.uptimePct * 100) * (e.inSecs + e.outSecs);
    if (!e.clean && breachedAt < 0) breachedAt = k;
    inAll += e.inSecs; outAll += e.outSecs;
  });
  return { dt, epochs, uptime: inAll + outAll ? inAll / (inAll + outAll) : 1, breachedAt, rebalances, refused, short, points };
}

/** Runs a preset on the rules' own grid. */
export function runPreset(r: Rules, kind: PathKind, seed = 1): Result {
  const g = grid(r);
  return backtest(r, preset(kind, Number(r.price) || 1, g.n + 1, g.dt, seed), g.dt);
}

/** Share of `seeds` runs per preset that breach at least one epoch. */
export function breachRisk(r: Rules, seeds = 6): Record<PathKind, number> {
  return Object.fromEntries(PATHS.map(([k]) => {
    let b = 0;
    for (let s = 1; s <= seeds; s++) if (runPreset(r, k, s).breachedAt >= 0) b++;
    return [k, b / seeds];
  })) as Record<PathKind, number>;
}
