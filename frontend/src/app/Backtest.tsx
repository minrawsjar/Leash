// The rules backtester on the create page: runs a price path through the draft terms (backtest.ts) and shows
// what the epochs would have looked like. An approximation, said so on the panel.
import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { PATHS, backtest, breachRisk, grid, parseCsv, resample, runPreset, type PathKind, type Result, type Rules } from './backtest.ts';
import { dur, fmtPrice } from './chain.ts';

const SEEDS = 6;

export function Backtest({ f, unit }: { f: Rules; unit: string }) {
  const r = useDeferredValue(f);
  const [kind, setKind] = useState<PathKind | 'csv'>('choppy');
  const [seed, setSeed] = useState(1);
  const [csv, setCsv] = useState('');
  const bad = !(Number(r.price) > 0 && r.epochs >= 1 && r.epochs <= 104 && r.epochHours > 0 && r.twapMins > 0 && r.minHalfWidth > 0 && Number(r.tokenAmount) > 0 && Number(r.stableAmount) > 0);
  const pasted = useMemo(() => parseCsv(csv), [csv]);
  const res = useMemo<Result | null>(() => {
    if (bad) return null;
    if (kind !== 'csv') return runPreset(r, kind, seed);
    if (pasted.length < 2) return null;
    const g = grid(r);
    return backtest(r, resample(pasted, g.n + 1), g.dt); // pasted prices are taken as the price, not scaled to the opening price
  }, [r, kind, seed, pasted, bad]);
  const risk = useMemo(() => (bad ? null : breachRisk(r, SEEDS)), [r, bad]);

  return (
    <section className="bt" aria-labelledby="bt-h">
      <div className="assist-top">
        <h2 id="bt-h" className="eyebrow">Backtest these rules</h2>
        <span className="quiet small">An approximation of the on-chain rules, not a guarantee: no fees, gas or per-block limits, and an honest manager who re-centres on the TWAP whenever the guards allow.</span>
      </div>
      <div className="x-chips" role="tablist" aria-label="Price path">
        {PATHS.map(([k, label]) => <button key={k} type="button" role="tab" aria-selected={kind === k} className="x-chip" onClick={() => setKind(k)}>{label}</button>)}
        <button type="button" role="tab" aria-selected={kind === 'csv'} className="x-chip" onClick={() => setKind('csv')}>Paste prices</button>
        {kind !== 'csv' && <button type="button" className="link bt-seed" onClick={() => setSeed((x) => x + 1)}>Another run (seed {seed})</button>}
      </div>
      {kind === 'csv' && (
        <label className="bt-csv">
          <span className="quiet small">One price per line, {unit}, oldest first ("time,price" lines work too). Spread evenly over the {r.epochs} × {dur(r.epochHours * 3600)} of the mandate.</span>
          <textarea rows={4} value={csv} onChange={(e) => setCsv(e.target.value)} spellCheck={false} placeholder={'2.00\n2.04\n1.97\n…'} />
        </label>
      )}

      {bad ? <p className="quiet">Fix the opening price, deposits, epochs and TWAP window above to run it.</p>
        : !res ? <p className="quiet">Paste at least two prices.</p>
        : <Run r={r} res={res} unit={unit} />}

      {risk && (
        <div className="bt-risk">
          <p className="eyebrow">Breach risk · {SEEDS} runs per path</p>
          <ul>
            {PATHS.map(([k, label]) => (
              <li key={k}>
                <button type="button" className="link" onClick={() => setKind(k)}>{label}</button>
                <span className="bt-meter" aria-hidden><i className={risk[k] > 0 ? 'bad' : ''} style={{ width: `${Math.max(2, risk[k] * 100)}%` }} /></span>
                <b className={risk[k] > 0 ? 'rose' : 'ok'}>{Math.round(risk[k] * 100)}%</b>
              </li>
            ))}
          </ul>
          <p className="quiet small">Share of runs where at least one epoch misses {r.uptimePct}% uptime. A miss slashes the bond, so a careful manager prices this into their bid. Trends move 30% in three hours (or a third of the mandate, if shorter); the crash drops 25% in ten minutes and recovers within an hour.</p>
        </div>
      )}
    </section>
  );
}

function Run({ r, res, unit }: { r: Rules; res: Result; unit: string }) {
  const clean = res.epochs.filter((e) => e.clean).length;
  const first = res.breachedAt >= 0 ? res.epochs[res.breachedAt] : null;
  const why = first && (['range', 'depth', 'pace'] as const).reduce((a, k) => (first.out[k] > first.out[a] ? k : a), 'range' as 'range' | 'depth' | 'pace');
  return (
    <>
      <PathChart res={res} r={r} unit={unit} />
      <ol className="bt-dots" aria-label="Epochs">
        {res.epochs.map((e, i) => {
          const up = e.inSecs + e.outSecs ? (e.inSecs / (e.inSecs + e.outSecs)) * 100 : 100;
          const after = res.breachedAt >= 0 && i > res.breachedAt;
          return <li key={i} className={after ? 'after' : e.clean ? 'clean' : 'breached'} title={`Epoch ${i + 1}: ${up.toFixed(1)}% in compliance${after ? ' (the manager is already fired by then)' : ''}`}><span className="sr">Epoch {i + 1} {e.clean ? 'clean' : 'breached'}</span></li>;
        })}
      </ol>
      <div className="stats">
        <div className={`stat ${res.uptime * 100 >= r.uptimePct ? 'mint' : 'rose'}`}><span className="eyebrow">Uptime, whole run</span><strong>{(res.uptime * 100).toFixed(1)}% <small>needs {r.uptimePct}% per epoch</small></strong></div>
        <div className={`stat ${first ? 'rose' : 'mint'}`}><span className="eyebrow">Epochs clean</span><strong>{clean} <small>of {res.epochs.length}</small></strong></div>
        <div className="stat"><span className="eyebrow">Rebalances</span><strong>{res.rebalances}</strong></div>
        <div className="stat"><span className="eyebrow">Refused</span><strong>{res.refused + res.short} <small>{res.refused} spot off TWAP · {res.short} too shallow</small></strong></div>
      </div>
      <p className="quiet">{!first ? 'Every epoch clean on this path.'
        : `Epoch ${res.breachedAt + 1} breaches: ${dur(first.outSecs)} out of compliance, mostly ${why === 'range' ? 'with the TWAP outside the range while spot ran too far from it to rebalance' : why === 'depth' ? 'below the depth floor' : 'over the stablecoin cap: the position sold token into the rise faster than the glide path allows'}. On-chain the bond is slashed and the manager fired there; later epochs are shown faint.`}</p>
    </>
  );
}

/** Spot, TWAP and the simulated range over the whole run, with epoch boundaries. */
function PathChart({ res, r, unit }: { res: Result; r: Rules; unit: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(720);
  useEffect(() => {
    const ro = new ResizeObserver(([e]) => setW(Math.max(260, Math.round(e.contentRect.width))));
    if (box.current) ro.observe(box.current);
    return () => ro.disconnect();
  }, []);
  const h = w < 500 ? 170 : 210, pad = { l: 4, r: 60, t: 10, b: 8 };
  const P = (tick: number) => Math.pow(1.0001, tick);
  const pts = res.points;
  const ys = pts.flatMap((p) => [P(p.spot), P(p.twap), P(p.lo), P(p.hi)]);
  let [y0, y1] = [Math.min(...ys), Math.max(...ys)];
  const m = (y1 - y0 || y1 * 0.02) * 0.06; [y0, y1] = [y0 - m, y1 + m];
  const T = pts[pts.length - 1].t;
  const X = (t: number) => pad.l + (t / T) * (w - pad.l - pad.r);
  const Y = (v: number) => pad.t + (1 - (v - y0) / (y1 - y0)) * (h - pad.t - pad.b);
  const line = (f: (p: typeof pts[0]) => number) => pts.map((p, i) => `${i ? 'L' : 'M'}${X(p.t).toFixed(1)},${Y(P(f(p))).toFixed(1)}`).join('');
  const band = line((p) => p.hi) + [...pts].reverse().map((p) => `L${X(p.t).toFixed(1)},${Y(P(p.lo)).toFixed(1)}`).join('') + 'Z';
  const len = r.epochHours * 3600;
  return (
    <div ref={box} className="chart bt-chart">
      <svg width={w} height={h} role="img" aria-label={`Simulated spot, TWAP and range, ${unit}`}>
        {[0, 0.5, 1].map((k) => { const v = y0 + (y1 - y0) * k; return <g key={k} className="grid"><line x1={pad.l} x2={w - pad.r} y1={Y(v)} y2={Y(v)} /><text x={w - pad.r + 6} y={Y(v) + 4}>{fmtPrice(v)}</text></g>; })}
        {r.epochs <= 40 && Array.from({ length: r.epochs - 1 }, (_, i) => <line key={i} className="bt-ep" x1={X((i + 1) * len)} x2={X((i + 1) * len)} y1={pad.t} y2={h - pad.b} />)}
        <path className="band" d={band} />
        <path className="twap" d={line((p) => p.twap)} />
        <path className="spot" d={line((p) => p.spot)} />
      </svg>
      <ul className="legend">
        <li><i className="k-spot" />Spot</li>
        <li><i className="k-twap" />TWAP ({r.twapMins} min)</li>
        <li><i className="k-band" />Manager's range</li>
      </ul>
    </div>
  );
}
