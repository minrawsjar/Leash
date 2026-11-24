// The hero: one canvas. Behind, the pool's ledger scrolls by. In front, a mandate plays out on a 24-second loop:
//
//   epoch 1   spot wanders inside the manager's range; one block's push barely moves the TWAP; settles clean
//   epoch 2   the market moves and the manager doesn't follow: the TWAP leaves the range, the clock runs out;
//             settlement slashes the bond to the treasury and fires the manager
//   after     only the anchor is left (liquidity at every price) until the next mandate's range goes up
//
// Units: price in "range half-widths" around the first range's centre. Everything here is illustrative.

const P = 24; // loop length, seconds
const FPS = 30;
const N = P * FPS;
const TAU = Math.PI * 2;
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const range = (v: number, a: number, b: number) => clamp((v - a) / (b - a), 0, 1);
const smooth = (t: number) => t * t * (3 - 2 * t);
const wrap = (s: number) => ((s % P) + P) % P;

const C = {
  ink: '11, 13, 31',
  cream: '238, 240, 255',
  mint: '78, 240, 176',
  violet: '139, 123, 255',
  rose: '255, 93, 143',
};
const rgba = (c: string, a: number) => `rgba(${c}, ${a.toFixed(3)})`;

// ── the path, precomputed once ───────────────────────────────────────────
const level = (s: number) => 2.6 * smooth(range(s, 9.4, 12.4)) * (1 - smooth(range(s, 16.8, 20.4)));
const noise = (s: number) => {
  const k = (n: number, ph: number) => Math.sin((TAU * n * s) / P + ph);
  return 0.24 * k(7, 0.4) + 0.15 * k(13, 1.3) + 0.09 * k(29, 2.1) + 0.05 * k(53, 0.7);
};
const SPIKE = [4.4, 4.56]; // one block, pushed hard
const spotAt = (s: number) => level(s) + noise(s) - (s >= SPIKE[0] && s < SPIKE[1] ? 2.0 : 0);

const spot = new Float32Array(N);
const twap = new Float32Array(N);
{
  // The oracle moves at most MAX a sample toward spot (Leash truncates at 50 ticks a second); the TWAP
  // averages it over a trailing window. Two passes, so the loop starts warm and joins without a seam.
  const MAX = 0.045, WIN = 2 * FPS;
  const o = new Float32Array(N * 2);
  let prev = spotAt(0);
  for (let i = 0; i < N * 2; i++) {
    const s = (i % N) / FPS;
    if (i < N) spot[i] = spotAt(s);
    prev += clamp(spotAt(s) - prev, -MAX, MAX);
    o[i] = prev;
  }
  for (let i = 0; i < N; i++) {
    let sum = 0;
    for (let k = 0; k < WIN; k++) sum += o[N + i - k];
    twap[i] = sum / WIN;
  }
}
// The manager's range: on until the breach settles at 16, gone while fired, back for the next mandate.
const bandOn = (s: number) => (s < 16 ? 1 - range(s, 15.95, 16) : range(s, 21.8, 22.4));
const sample = (arr: Float32Array, s: number) => {
  const x = wrap(s) * FPS, i = Math.floor(x), f = x - i;
  return arr[i % N] * (1 - f) + arr[(i + 1) % N] * f;
};
const inRange = (s: number) => Math.abs(sample(twap, s)) <= 1;
// Seconds in compliance so far this epoch, sampled.
const ok = new Uint8Array(N);
for (let i = 0; i < N; i++) ok[i] = Math.abs(twap[i]) <= 1 ? 1 : 0;
function uptime(s: number) {
  const e = Math.floor(wrap(s) / 8) * 8, to = Math.floor(wrap(s) * FPS);
  let good = 0, all = 0;
  for (let i = e * FPS; i <= to; i++) { all++; good += ok[i]; }
  return all ? good / all : 1;
}

// ── the ledger behind: made-up activity of the hook's pool ───────────────
let seed = 20261127;
const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const pick = <T,>(l: T[]) => l[Math.floor(rnd() * l.length)];
const hex = (n: number) => Array.from({ length: n }, () => pick([...'0123456789abcdef'])).join('');
const who = () => `0x${hex(2)}…${hex(4)}`;
let block = 18402117;
function record() {
  if (rnd() < 0.4) block += 1;
  const k = rnd();
  const amt = (rnd() * 4000 + 20).toLocaleString('en-US', { maximumFractionDigits: 2, minimumFractionDigits: 2 });
  const [type, detail, status] =
    k < 0.55 ? ['swap', `${who()}  ${amt} ${pick(['USDC → TKN', 'TKN → USDC'])}`, 'checked']
      : k < 0.72 ? ['checkpoint', `keeper ${who()}  ${Math.ceil(rnd() * 60)}s booked`, 'in']
        : k < 0.84 ? ['rebalance', `ticks ${-pick([600, 900, 1200])} → ${pick([600, 900, 1200])}`, 'ok']
          : k < 0.92 ? ['setFee', `${pick(['0.18', '0.22', '0.25', '0.30'])}% ≤ cap 0.30%`, 'ok']
            : ['settle', `epoch ${Math.ceil(rnd() * 40)}  ${pick(['clean', 'clean', 'clean', 'breached'])}`, 'final'];
  return `${block.toLocaleString('en-US')}  ${type.padEnd(10)}  ${detail.padEnd(36)}  ${status}`;
}
const row = (cols: number) => { let t = ''; while (t.length < cols) t += (t ? '      ' : '') + record(); return t; };

// ── drawing ──────────────────────────────────────────────────────────────
const MONO = '"JetBrains Mono", ui-monospace, Menlo, monospace';
const LH = 22;
const START = 3; // the loop opens calm, inside the range, with the one-block push still ahead

export function mountHero(hero: HTMLElement, canvas: HTMLCanvasElement, { reduced, freeze }: { reduced: boolean; freeze: number | null }) {
  const ctx = canvas.getContext('2d')!;
  let W = 0, H = 0, cw = 7.2, cols = 0;
  let rows: string[] = [];
  let offset = 0, last = 0, frame = 0, running = false;
  const born = performance.now();
  const still = reduced || freeze !== null;
  const fixedT = freeze ?? 7.2;

  function resize() {
    const dpr = Math.min(2, devicePixelRatio || 1);
    W = hero.clientWidth; H = hero.clientHeight;
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.font = `12px ${MONO}`;
    cw = ctx.measureText('0').width || 7.2;
    cols = Math.ceil(W / cw) + 4;
    seed = 20261127;
    rows = Array.from({ length: Math.ceil(H / LH) + 2 }, () => row(cols));
    draw(still ? fixedT : (performance.now() - born) / 1000 + START);
  }

  function geo() {
    const narrow = W < 760;
    const x0 = narrow ? 16 : W * 0.5, x1 = narrow ? W - 16 : W - Math.max(24, W * 0.045);
    const y0 = narrow ? 40 : H * 0.17, y1 = narrow ? 300 : H * 0.8;
    const prof = (x1 - x0) * (narrow ? 0.2 : 0.17);
    const head = x1 - prof;
    const pps = (head - x0) / (narrow ? 7 : 10); // px per second of history
    const HI = 4.1, LO = -2.3;
    const y = (v: number) => y0 + ((HI - v) / (HI - LO)) * (y1 - y0);
    return { narrow, x0, x1, y0, y1, head, pps, y, prof };
  }

  function label(text: string, x: number, y: number, colour: string, align: CanvasTextAlign = 'left', size = 11) {
    ctx.font = `500 ${size}px ${MONO}`;
    ctx.textAlign = align; ctx.textBaseline = 'middle';
    ctx.fillStyle = colour;
    ctx.fillText(text.toUpperCase(), x, y);
  }
  function pill(text: string, x: number, y: number, fill: string, fg: string, align: 'left' | 'center' | 'right' = 'center') {
    ctx.font = `600 11px ${MONO}`;
    const w = ctx.measureText(text).width + 22, h = 24;
    const left = align === 'center' ? x - w / 2 : align === 'right' ? x - w : x;
    ctx.fillStyle = fill;
    ctx.beginPath(); ctx.roundRect(left, y - h / 2, w, h, 12); ctx.fill();
    ctx.fillStyle = fg; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText(text, left + 11, y + 0.5);
    return { left, w };
  }

  function drawLedger(g: ReturnType<typeof geo>) {
    ctx.font = `12px ${MONO}`;
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    const fade = g.narrow ? ctx.createLinearGradient(0, 0, 0, H) : ctx.createLinearGradient(0, 0, W, 0);
    const stops: [number, number][] = g.narrow ? [[0, 0.07], [Math.min(0.9, 300 / H), 0.07], [Math.min(0.95, 350 / H), 0]] : [[0, 0], [0.4, 0], [0.56, 0.085], [1, 0.085]];
    for (const [at, a] of stops) fade.addColorStop(at, rgba(C.cream, a));
    ctx.fillStyle = fade;
    const top = LH / 2 - offset;
    rows.forEach((r, i) => ctx.fillText(r, 0, top + i * LH));
  }

  function draw(t: number) {
    const g = geo();
    ctx.clearRect(0, 0, W, H);
    drawLedger(g);
    ctx.save();
    ctx.shadowColor = rgba(C.ink, 1); ctx.shadowBlur = 48;
    ctx.fillStyle = rgba(C.ink, 0.86);
    ctx.fillRect(g.x0 - 12, g.y0 - 44, g.x1 - g.x0 + 24, g.y1 - g.y0 + 100);
    ctx.restore();
    const { x0, head, pps, y } = g;
    const age = still ? 99 : (performance.now() - born) / 1000;
    const reveal = smooth(range(age, 0.15, 1.6));
    const sAt = (x: number) => t - (head - x) / pps;
    const left = head - (head - x0) * reveal;

    // Soft fade at the left edge of the history.
    ctx.save();
    ctx.beginPath(); ctx.rect(left, 0, g.x1 - left + 2, H); ctx.clip();

    // The range band, sampled along history so a fired manager's gap scrolls away with time.
    ctx.fillStyle = rgba(C.mint, 0.1);
    for (let x = x0; x < head; x += 2) {
      const on = bandOn(sAt(x));
      if (on <= 0.01) continue;
      ctx.globalAlpha = on;
      ctx.fillRect(x, y(1), 2.2, y(-1) - y(1));
    }
    ctx.globalAlpha = 1;
    // Band edges.
    ctx.strokeStyle = rgba(C.mint, 0.55); ctx.lineWidth = 1;
    for (const edge of [1, -1]) {
      ctx.beginPath();
      let pen = false;
      for (let x = x0; x <= head; x += 2) {
        const on = bandOn(sAt(x)) > 0.5;
        if (on && !pen) { ctx.moveTo(x, y(edge)); pen = true; } else if (on) ctx.lineTo(x, y(edge)); else pen = false;
      }
      ctx.stroke();
    }

    // Epoch boundaries and their settlements.
    for (const at of [0, 8, 16]) {
      for (let k = -1; k <= 1; k++) {
        const sAbs = Math.floor(t / P) * P + at + k * P;
        const x = head - (t - sAbs) * pps;
        if (x < x0 - 4 || x > head) continue;
        ctx.strokeStyle = rgba(C.cream, 0.14); ctx.setLineDash([2, 5]);
        ctx.beginPath(); ctx.moveTo(x, g.y0 - 6); ctx.lineTo(x, g.y1 + 8); ctx.stroke(); ctx.setLineDash([]);
        const name = at === 0 ? 'epoch 1' : at === 8 ? 'epoch 2' : 'settled';
        if (at !== 16) label(name, x + 6, g.y0 - 2, rgba(C.cream, 0.4));
        if (at === 8) { ctx.fillStyle = rgba(C.mint, 1); ctx.beginPath(); ctx.arc(x, g.y1 + 8, 4, 0, TAU); ctx.fill(); }
        if (at === 16) { ctx.fillStyle = rgba(C.rose, 1); ctx.beginPath(); ctx.arc(x, g.y1 + 8, 4, 0, TAU); ctx.fill(); }
      }
    }

    // Compliance strip along the time axis: mint in, rose out, empty while nobody is hired.
    const sy = g.y1 + 8;
    for (let x = x0; x < head; x += 2) {
      const s = sAt(x);
      if (bandOn(s) < 0.5) continue;
      ctx.fillStyle = inRange(s) ? rgba(C.mint, 0.35) : rgba(C.rose, 0.9);
      ctx.fillRect(x, sy - 1, 2.2, 2);
    }

    // TWAP: the hook's own average, the line compliance is judged on.
    ctx.strokeStyle = rgba(C.mint, 1); ctx.lineWidth = 2.25; ctx.lineJoin = 'round';
    ctx.beginPath();
    for (let x = x0; x <= head; x += 2) { const v = y(sample(twap, sAt(x))); x === x0 ? ctx.moveTo(x, v) : ctx.lineTo(x, v); }
    ctx.stroke();
    // Spot: what trades see, the faint line with the spikes.
    ctx.strokeStyle = rgba(C.cream, 0.55); ctx.lineWidth = 1.2;
    ctx.beginPath();
    for (let x = x0; x <= head; x += 1.5) { const v = y(sample(spot, sAt(x))); x === x0 ? ctx.moveTo(x, v) : ctx.lineTo(x, v); }
    ctx.stroke();
    // Out of range: the TWAP drawn in rose where it has left the band.
    ctx.strokeStyle = rgba(C.rose, 1); ctx.lineWidth = 2.25;
    ctx.beginPath();
    let pen = false;
    for (let x = x0; x <= head; x += 2) {
      const s = sAt(x);
      const bad = bandOn(s) > 0.5 && !inRange(s);
      const v = y(sample(twap, s));
      if (bad && !pen) { ctx.moveTo(x, v); pen = true; } else if (bad) ctx.lineTo(x, v); else pen = false;
    }
    ctx.stroke();
    ctx.restore();

    // The one-block push, labelled where it happened.
    for (let k = -1; k <= 0; k++) {
      const sAbs = Math.floor(t / P) * P + SPIKE[0] + k * P;
      const x = head - (t - sAbs) * pps;
      const age2 = t - sAbs;
      if (x < left + 10 || x > head || age2 > 9) continue;
      const a = range(age2, 0.2, 0.7) * (1 - range(age2, 7, 9));
      const vy = y(sample(spot, sAbs + 0.05));
      ctx.globalAlpha = a;
      ctx.strokeStyle = rgba(C.cream, 0.5); ctx.beginPath(); ctx.moveTo(x + 4, vy); ctx.lineTo(x + 16, vy); ctx.stroke();
      label('one-block push', x + 22, vy - 8, rgba(C.cream, 0.75));
      label('twap held', x + 22, vy + 8, rgba(C.mint, 0.95));
      ctx.globalAlpha = 1;
    }

    // Depth profile at the head: the anchor's bars at every price, the managed block inside the range.
    const s = wrap(t);
    const on = bandOn(s);
    const bars = 26, top = g.y0, span = g.y1 - g.y0, bh = span / bars;
    for (let i = 0; i < bars; i++) {
      const by = top + i * bh;
      const v = 4.1 - ((i + 0.5) / bars) * 6.4;
      const managed = Math.abs(v) <= 1 ? on : 0;
      const w = g.prof * (0.16 + 0.74 * managed * (0.82 + 0.18 * Math.cos(v * 1.4)));
      ctx.fillStyle = managed > 0.02 ? rgba(C.mint, 0.25 + 0.6 * managed) : rgba(C.cream, 0.18);
      ctx.fillRect(head + 10, by + 1.5, w * reveal, Math.max(1, bh - 3));
    }
    if (!g.narrow) {
      label('anchor', head + 10, g.y1 + 8, rgba(C.cream, 0.45));
      label('every price', head + 10, g.y1 + 23, rgba(C.cream, 0.3));
    }

    // The head: where the price is now.
    const sv = y(sample(spot, s)), tv = y(sample(twap, s));
    ctx.fillStyle = rgba(C.cream, 1); ctx.beginPath(); ctx.arc(head, sv, 3, 0, TAU); ctx.fill();
    const bad = on > 0.5 && !inRange(s);
    ctx.fillStyle = bad ? rgba(C.rose, 1) : rgba(C.mint, 1);
    ctx.beginPath(); ctx.arc(head, tv, 5, 0, TAU); ctx.fill();
    ctx.strokeStyle = bad ? rgba(C.rose, 0.3) : rgba(C.mint, 0.3); ctx.lineWidth = 6;
    ctx.beginPath(); ctx.arc(head, tv, 9 + 3 * Math.sin(t * 3), 0, TAU); ctx.stroke();

    // The bond: pinned above the range at the head. Slashed at the breach's settlement, dropped to the treasury.
    const by0 = y(1) - 26;
    const slash = range(s, 16, 16.25), drop = smooth(range(s, 16.6, 18)), arrive = smooth(range(s, 22, 23));
    const shake = s > 16 && s < 16.6 ? Math.sin(s * 90) * 4 * (1 - range(s, 16, 16.6)) : 0;
    let bx = head + shake, byy = by0, ba = 1;
    if (s >= 16 && s < 22) { byy = by0 + drop * (g.y1 - by0 + 40); ba = 1 - range(s, 17.4, 18.2); }
    if (s >= 22) { byy = by0 - (1 - arrive) * 60; ba = arrive; }
        const flash = s >= 16 && s < 22 ? Math.max(slash, 0.6) : 0;
    const paid = s >= 8 && s < 9.6 ? 1 - range(s, 8.6, 9.6) : 0;
    if (ba > 0.01) {
      ctx.globalAlpha = ba;
      const fill = flash > 0 ? rgba(C.rose, 1) : rgba(C.violet, 1);
      if (paid > 0) {
        ctx.strokeStyle = rgba(C.mint, paid); ctx.lineWidth = 2;
        ctx.beginPath(); ctx.roundRect(bx - 78 - 6 * paid, byy - 12 - 6 * paid, 156 + 12 * paid, 24 + 12 * paid, 18); ctx.stroke();
      }
      pill('BOND 25,000 USDC', bx, byy, fill, rgba(C.ink, 1));
      ctx.globalAlpha = 1;
    }

    // What just happened, said once, under the chart.
    const say = (txt: string, colour: string, a: number) => {
      if (a <= 0.01) return;
      ctx.globalAlpha = a;
      label(txt, g.narrow ? g.x0 : g.x0, g.y1 + 36, colour);
      ctx.globalAlpha = 1;
    };
    const pct = Math.round(uptime(s) * 100);
    const fadeIn = (a: number, b: number) => range(s, a, a + 0.3) * (1 - range(s, b - 0.3, b));
    say(`epoch 1 · in compliance ${pct}% · allowance 95%`, rgba(C.cream, 0.6), fadeIn(0.6, 8));
    say('settled clean · 30% of the fees to the manager', rgba(C.mint, 1), fadeIn(8, 10.6));
    say(`epoch 2 · in compliance ${pct}% · allowance 95%`, pct < 95 ? rgba(C.rose, 1) : rgba(C.cream, 0.6), fadeIn(10.6, 16));
    say('breached · bond slashed to the treasury · manager fired', rgba(C.rose, 1), fadeIn(16, 19));
    say('treasury closes · every token comes back', rgba(C.cream, 0.6), fadeIn(19, 22));
    say('next mandate · a new range, a new bond', rgba(C.violet, 1), fadeIn(22, 24.3) + (s < 0.6 ? 1 - range(s, 0.3, 0.6) : 0));
    if (s >= 16 && s < 18.6) label('→ treasury', head, g.y1 + 60, rgba(C.rose, range(s, 16.6, 17.2) * (1 - range(s, 18.2, 18.6))), 'center');

    // Legend, top left of the chart.
    if (!g.narrow) {
      label('spot', g.x0, g.y0 - 30, rgba(C.cream, 0.55));
      label('twap', g.x0 + 52, g.y0 - 30, rgba(C.mint, 1));
      label('range', g.x0 + 104, g.y0 - 30, rgba(C.mint, 0.55));
      label('illustrative', g.x1, g.y0 - 30, rgba(C.cream, 0.3), 'right');
    }
  }

  function loop(ms: number) {
    if (!running) return;
    const now = ms / 1000;
    if (last) offset += 14 * Math.min(0.05, now - last);
    last = now;
    while (offset >= LH) { offset -= LH; rows.shift(); rows.push(row(cols)); }
    draw((ms - born) / 1000 + START);
    frame = requestAnimationFrame(loop);
  }
  const start = () => { if (running || still) return; running = true; last = 0; frame = requestAnimationFrame(loop); };
  const stop = () => { running = false; cancelAnimationFrame(frame); };

  const ro = new ResizeObserver(resize);
  ro.observe(hero);
  const io = new IntersectionObserver(([e]) => (e.isIntersecting ? start() : stop()));
  io.observe(hero);
  void document.fonts?.ready.then(resize);
  return () => { stop(); ro.disconnect(); io.disconnect(); };
}
