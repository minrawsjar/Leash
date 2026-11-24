// Illustrative data: one block of price manipulation against a 30-block TWAP.
const N = 48, PUSH = 30, WINDOW = 30, BAND = 0.01;
const spot = Array.from({ length: N }, (_, i) =>
  i === PUSH ? 0.86 : 1 + 0.004 * Math.sin(i * 0.9) + 0.003 * Math.sin(i * 2.3 + 1));
const twap = spot.map((_, i) => {
  const w = spot.slice(Math.max(0, i - WINDOW + 1), i + 1);
  return w.reduce((a, b) => a + b) / w.length;
});

const W = 640, H = 300, L = 48, R = 20, T = 18, B = 36, LO = 0.84, HI = 1.03;
const x = (i: number) => L + (i * (W - L - R)) / (N - 1);
const y = (v: number) => T + ((HI - v) / (HI - LO)) * (H - T - B);
const path = (vs: number[]) => 'M' + vs.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('L');
const band =
  path(twap.map((v) => v * (1 + BAND))) +
  'L' + twap.map((v, i) => [i, v * (1 - BAND)] as const).reverse().map(([i, v]) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('L') + 'Z';

export function AttackChart() {
  const px = x(PUSH), py = y(spot[PUSH]);
  return (
    <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img"
      aria-label="Chart: the spot price is pushed 14% down for one block at block 30. The 30-block TWAP barely moves, so the rebalance attempted at that moment is refused.">
      {[0.85, 0.9, 0.95, 1].map((v) => (
        <g key={v}>
          <line x1={L} x2={W - R} y1={y(v)} y2={y(v)} className="grid" />
          <text x={L - 8} y={y(v) + 4} textAnchor="end">{v.toFixed(2)}</text>
        </g>
      ))}
      {[0, 10, 20, 30, 40].map((i) => (
        <text key={i} x={x(i)} y={H - 12} textAnchor="middle">{i === 0 ? 'block 0' : i}</text>
      ))}
      <path d={band} className="band" />
      <path d={path(spot)} className="spot" />
      <path d={path(twap)} className="twap" />
      <text x={x(N - 1)} y={y(twap[N - 1] * (1 + BAND)) - 8} textAnchor="end" className="tw">TWAP ± 1%</text>
      <text x={x(N - 1)} y={y(spot[N - 1]) + 22} textAnchor="end">spot</text>
      <path d={`M${px - 7},${py - 7}L${px + 7},${py + 7}M${px + 7},${py - 7}L${px - 7},${py + 7}`} className="mark" />
      <text x={px - 14} y={py + 4} textAnchor="end" className="red">rebalance() refused: price pushed 14% for one block</text>
    </svg>
  );
}
