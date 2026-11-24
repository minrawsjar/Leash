// Price vs TWAP vs the manager's range: a live SVG chart. Samples are ticks; the y axis is stablecoin per token.
import { useEffect, useRef, useState } from 'react';
import { fmtPrice } from './chain.ts';

export type Sample = { t: number; spot: number; twap: number; lo: number; hi: number };

export function Chart({ samples, price, needLo, needHi, unit }: {
  samples: Sample[]; price: (tick: number) => number; needLo: number; needHi: number; unit: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(720);
  useEffect(() => {
    const ro = new ResizeObserver(([e]) => setW(Math.max(280, Math.round(e.contentRect.width))));
    if (box.current) ro.observe(box.current);
    return () => ro.disconnect();
  }, []);
  const h = w < 500 ? 220 : 280;
  const pad = { l: 8, r: w < 500 ? 62 : 78, t: 14, b: 26 };
  if (samples.length === 0) return <div ref={box} className="chart empty">Waiting for the first price…</div>;

  const last = samples[samples.length - 1];
  // y in price; a token priced in a stable that is currency0 inverts the tick axis, so sort each pair.
  const ranged = samples.filter((s) => s.lo < s.hi); // a closed mandate has no position
  // Frame the price action and the must-cover band; a range edge comes into view only if it is close, else the
  // band runs off the chart (clipped) and the legend gives its bounds.
  const ys = samples.flatMap((s) => [price(s.spot), price(s.twap)]).concat(price(needLo), price(needHi));
  let [y0, y1] = [Math.min(...ys), Math.max(...ys)];
  const span = y1 - y0 || y1 * 0.02 || 1;
  for (const e of ranged.length ? [price(last.lo), price(last.hi)] : []) if (e > y0 - span && e < y1 + span) [y0, y1] = [Math.min(y0, e), Math.max(y1, e)];
  const pad2 = (y1 - y0 || span) * 0.12;
  [y0, y1] = [y0 - pad2, y1 + pad2];
  const t0 = samples[0].t, t1 = Math.max(last.t, t0 + 1);
  const X = (t: number) => pad.l + ((t - t0) / (t1 - t0)) * (w - pad.l - pad.r);
  const Y = (p: number) => pad.t + (1 - (p - y0) / (y1 - y0)) * (h - pad.t - pad.b);
  const line = (f: (s: Sample) => number) => samples.map((s, i) => `${i ? 'L' : 'M'}${X(s.t).toFixed(1)},${Y(price(f(s))).toFixed(1)}`).join('');
  // The manager's range as a band that steps when they rebalance.
  const band = !ranged.length ? '' : ranged.map((s, i) => `${i ? 'L' : 'M'}${X(s.t).toFixed(1)},${Y(price(s.hi)).toFixed(1)}`).join('')
    + [...ranged].reverse().map((s) => `L${X(s.t).toFixed(1)},${Y(price(s.lo)).toFixed(1)}`).join('') + 'Z';
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((k) => y0 + (y1 - y0) * k);
  const lbl = fmtPrice;
  const sorted = (a: number, b: number) => (a < b ? [a, b] : [b, a]);
  const [rLo, rHi] = sorted(price(last.lo), price(last.hi));
  const [nLo, nHi] = sorted(price(needLo), price(needHi));
  const when = (t: number) => new Date(t * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  return (
    <div ref={box} className="chart">
      <svg width={w} height={h} role="img" aria-label={`Spot ${lbl(price(last.spot))}, TWAP ${lbl(price(last.twap))}, ${last.lo < last.hi ? `manager range ${lbl(rLo)} to ${lbl(rHi)}` : 'no managed position'} ${unit}`}>
        {yTicks.map((v) => <g key={v} className="grid"><line x1={pad.l} x2={w - pad.r} y1={Y(v)} y2={Y(v)} /><text x={w - pad.r + 8} y={Y(v) + 4}>{lbl(v)}</text></g>)}
        <clipPath id="plot"><rect x={pad.l} y={pad.t} width={w - pad.l - pad.r} height={h - pad.t - pad.b} /></clipPath>
        <path className="band" d={band} clipPath="url(#plot)" />
        <rect className="need" x={pad.l} width={w - pad.l - pad.r} y={Y(nHi)} height={Math.max(1, Y(nLo) - Y(nHi))} />
        <path className="twap" d={line((s) => s.twap)} />
        <path className="spot" d={line((s) => s.spot)} />
        <circle className="spot-dot" cx={X(last.t)} cy={Y(price(last.spot))} r={4} />
        <circle className="twap-dot" cx={X(last.t)} cy={Y(price(last.twap))} r={3.5} />
        <text className="axis" x={pad.l} y={h - 6}>{when(t0)}</text>
        <text className="axis" x={w - pad.r} y={h - 6} textAnchor="end">{when(last.t)}</text>
      </svg>
      <ul className="legend">
        <li><i className="k-spot" />Spot {lbl(price(last.spot))}</li>
        <li><i className="k-twap" />TWAP {lbl(price(last.twap))}</li>
        {last.lo < last.hi && <li><i className="k-band" />Manager's range {lbl(rLo)}–{lbl(rHi)}</li>}
        <li><i className="k-need" />Must cover (TWAP ± min half-width)</li>
      </ul>
    </div>
  );
}
