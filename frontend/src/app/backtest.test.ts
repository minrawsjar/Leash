// node src/app/backtest.test.ts — the backtester's own sanity: flat is clean, a jump past the gap limit breaches,
// presets are deterministic per seed, the CSV reader takes "time,price" lines.
import assert from 'node:assert/strict';
import { backtest, breachRisk, grid, parseCsv, preset, resample, runPreset } from './backtest.ts';
import { defaultForm } from './plan.ts';

const r = defaultForm(); // demo rules: 3 x 1h, 2-min TWAP, gap 100, half-width 200, 95% uptime, ±12% range
const g = grid(r);

const flat = backtest(r, Array(g.n + 1).fill(2), g.dt);
assert.equal(flat.breachedAt, -1, 'a flat price is clean');
assert.equal(flat.uptime, 1);
assert.equal(flat.refused, 0);

// +40% in one step, then held: the TWAP lags, spot sits far past maxTickDeviation, the range is left behind.
const jump = backtest(r, Array.from({ length: g.n + 1 }, (_, i) => (i < g.n / 6 ? 2 : 2.8)), g.dt);
assert.ok(jump.refused > 0, 'rebalances refused while spot is off the TWAP');
assert.ok(jump.epochs[0].out.range > 0, 'out-of-range time booked');

// a slow drift inside the guards is followed
const drift = backtest(r, Array.from({ length: g.n + 1 }, (_, i) => 2 * (1 + 0.1 * (i / g.n))), g.dt);
assert.ok(drift.rebalances > 0 && drift.epochs.every((e) => e.out.range === 0), 'slow drift: re-centred, never out of range');

assert.deepEqual(preset('choppy', 2, 50, 60, 3), preset('choppy', 2, 50, 60, 3), 'same seed, same path');
assert.notDeepEqual(preset('choppy', 2, 50, 60, 3), preset('choppy', 2, 50, 60, 4));
assert.equal(runPreset(r, 'calm').breachedAt, -1, 'calm demo is clean');

assert.deepEqual(parseCsv('time,price\n1,2.0\n2,2.5\n\n3,1e0'), [2, 2.5, 1]);
assert.deepEqual(resample([1, 3], 3), [1, 2, 3]);

const risk = breachRisk(r, 3);
assert.ok(Object.values(risk).every((v) => v >= 0 && v <= 1));
console.log('backtest ok', JSON.stringify(risk), 'jump uptime', jump.uptime.toFixed(3));
