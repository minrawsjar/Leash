// The story's stage: one canvas the scroll plays through five scenes, each from p = 0 to 1.
//
//   deposit  the treasury's tokens fall into the hook: the anchor at every price, then the opening position
//   auction  bonds outbid each other; outbid bonds become claimable; the highest holds the mandate
//   manage   the manager's two verbs: rebalance moves the block, setFee moves inside floor..cap; no withdraw
//   checks   every swap: in range, depth, pace; time booked in or out of compliance
//   settle   one clean epoch pays, one breached epoch slashes
//
// It draws only when told to (scroll), so it costs nothing while still.

export type RGBA = [number, number, number, number];
export type Theme = Record<'bg' | 'fg' | 'muted' | 'line' | 'mark' | 'anchor' | 'bond' | 'card' | 'good' | 'bad', RGBA>;

const INK: RGBA = [11, 13, 31, 1], CREAM: RGBA = [238, 240, 255, 1], MINT: RGBA = [78, 240, 176, 1];
const VIOLET: RGBA = [139, 123, 255, 1], ROSE: RGBA = [255, 93, 143, 1];
const a = (c: RGBA, alpha: number): RGBA => [c[0], c[1], c[2], alpha];

export const THEMES: Record<'dark' | 'violet' | 'cream' | 'mint', Theme> = {
  dark: { bg: INK, fg: CREAM, muted: [163, 168, 201, 1], line: a(CREAM, 0.14), mark: MINT, anchor: a(CREAM, 0.22), bond: VIOLET, card: [24, 28, 58, 1], good: MINT, bad: ROSE },
  violet: { bg: VIOLET, fg: INK, muted: a(INK, 0.68), line: a(INK, 0.2), mark: INK, anchor: a(INK, 0.22), bond: INK, card: a(INK, 0.1), good: INK, bad: ROSE },
  cream: { bg: CREAM, fg: INK, muted: [76, 80, 118, 1], line: a(INK, 0.14), mark: INK, anchor: a(INK, 0.18), bond: VIOLET, card: a(INK, 0.06), good: INK, bad: ROSE },
  mint: { bg: MINT, fg: INK, muted: a(INK, 0.66), line: a(INK, 0.18), mark: INK, anchor: a(INK, 0.2), bond: INK, card: a(INK, 0.08), good: INK, bad: ROSE },
};
const lerp = (x: number, y: number, t: number) => x + (y - x) * t;
export const blendTheme = (x: Theme, y: Theme, t: number): Theme =>
  Object.fromEntries(Object.keys(x).map((k) => [k, x[k as keyof Theme].map((v, i) => lerp(v, y[k as keyof Theme][i], t))])) as Theme;
export const css = ([r, g, b, al]: RGBA, mul = 1) => `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${(al * mul).toFixed(3)})`;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const range = (v: number, x: number, y: number) => clamp((v - x) / (y - x), 0, 1);
const ease = (t: number) => 1 - (1 - t) ** 3;
const easeInOut = (t: number) => (t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2);
const TAU = Math.PI * 2;
const MONO = '"JetBrains Mono", ui-monospace, Menlo, monospace';
const SANS = 'Poppins, system-ui, sans-serif';

export type Scene = 'deposit' | 'auction' | 'manage' | 'checks' | 'settle';
const BARS = 28;
const OPEN = [11, 17]; // the opening position's bars [from, to)
const MOVED = [14, 20]; // after the rebalance

export function createStory(canvas: HTMLCanvasElement) {
  const ctx = canvas.getContext('2d')!;
  let W = 0, H = 0;
  let scene: Scene = 'deposit', p = 0, th: Theme = THEMES.dark;

  function resize() {
    const r = canvas.getBoundingClientRect();
    const dpr = Math.min(2, devicePixelRatio || 1);
    W = r.width; H = r.height;
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw();
  }

  // ── primitives ──────────────────────────────────────────────────────────
  function text(s: string, x: number, y: number, colour: RGBA, { size = 11, align = 'left' as CanvasTextAlign, font = MONO, weight = 500, upper = true, alpha = 1 } = {}) {
    if (alpha <= 0.01) return 0;
    ctx.globalAlpha = alpha;
    ctx.font = `${weight} ${size}px ${font}`;
    ctx.textAlign = align; ctx.textBaseline = 'middle'; ctx.fillStyle = css(colour);
    const str = upper ? s.toUpperCase() : s;
    ctx.fillText(str, x, y);
    ctx.globalAlpha = 1;
    return ctx.measureText(str).width;
  }
  function pill(s: string, x: number, y: number, fill: RGBA, fg: RGBA, { alpha = 1, size = 12, h = 34, stroke = null as RGBA | null } = {}) {
    if (alpha <= 0.01) return;
    ctx.font = `600 ${size}px ${MONO}`;
    const w = ctx.measureText(s).width + h * 0.9;
    ctx.globalAlpha = alpha;
    ctx.beginPath(); ctx.roundRect(x - w / 2, y - h / 2, w, h, h / 2);
    if (stroke) { ctx.strokeStyle = css(stroke); ctx.lineWidth = 1.5; ctx.stroke(); } else { ctx.fillStyle = css(fill); ctx.fill(); }
    ctx.fillStyle = css(fg); ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(s, x, y + 0.5);
    ctx.globalAlpha = 1;
  }

  const narrow = () => W < 560;
  function pool() {
    const x0 = W * (narrow() ? 0.06 : 0.1), x1 = W * (narrow() ? 0.94 : 0.9);
    const base = H * (narrow() ? 0.78 : 0.74);
    const step = (x1 - x0) / BARS;
    return { x0, x1, base, step, bw: Math.max(3, step - 4), tall: H * (narrow() ? 0.26 : 0.3), low: H * 0.045 };
  }
  // Liquidity at bar i: the anchor everywhere, plus the managed block over [from, to).
  function bars(g: ReturnType<typeof pool>, anchor: number, managed: number, from: number, to: number, alpha = 1, bandA = 0) {
    for (let i = 0; i < BARS; i++) {
      const x = g.x0 + i * g.step + 2;
      // A block that slides between whole bars: overlap of [i, i+1) with [from, to).
      const cover = clamp(Math.min(i + 1, to) - Math.max(i, from), 0, 1);
      const mid = (from + to) / 2, curve = 1 - 0.25 * ((i + 0.5 - mid) / ((to - from) / 2)) ** 2;
      const hA = g.low * anchor, hM = g.tall * managed * cover * clamp(curve, 0.7, 1);
      ctx.globalAlpha = alpha;
      ctx.fillStyle = css(th.anchor);
      if (hA > 0.5) ctx.fillRect(x, g.base - hA, g.bw, hA);
      if (hM > 0.5) { ctx.fillStyle = css(th.mark); ctx.fillRect(x, g.base - hA - hM, g.bw, hM); }
    }
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = css(th.line); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(g.x0, g.base + 0.5); ctx.lineTo(g.x1, g.base + 0.5); ctx.stroke();
    text('price →', g.x1, g.base + 18, th.muted, { align: 'right', alpha: alpha * (1 - bandA) });
    ctx.globalAlpha = 1;
  }

  // ── scenes ──────────────────────────────────────────────────────────────
  const scenes: Record<Scene, () => void> = {
    deposit() {
      const g = pool();
      // The treasury, above.
      const tx = W / 2, ty = H * 0.16;
      text('treasury', tx, ty - 26, th.muted, { align: 'center' });
      text('2,000,000 TKN + 400,000 USDC', tx, ty, th.fg, { align: 'center', size: narrow() ? 12 : 14, weight: 600 });
      // The hook, framing the pool.
      const fa = range(p, 0.02, 0.15);
      ctx.globalAlpha = fa; ctx.strokeStyle = css(th.line); ctx.lineWidth = 1.5; ctx.setLineDash([4, 6]);
      ctx.beginPath(); ctx.roundRect(g.x0 - 18, g.base - g.tall - g.low - 70, g.x1 - g.x0 + 36, g.tall + g.low + 110, 22); ctx.stroke(); ctx.setLineDash([]);
      ctx.globalAlpha = 1;
      text('leash hook · holds it all', g.x0 - 2, g.base - g.tall - g.low - 48, th.muted, { alpha: fa });
      // Tokens fall, one per bar, and become the anchor where they land.
      let landed = 0;
      for (let i = 0; i < BARS; i++) {
        const order = (i * 11) % BARS; // scattered, not left to right
        const t = ease(range(p, 0.08 + order * 0.011, 0.24 + order * 0.011));
        const x = g.x0 + i * g.step + 2 + g.bw / 2;
        if (t >= 1) { landed++; continue; }
        if (t <= 0) continue;
        const y = lerp(ty + 20, g.base - g.low, t);
        ctx.fillStyle = css(i % 2 ? th.mark : th.fg);
        ctx.globalAlpha = 0.9;
        ctx.fillRect(x - 4, y - 4, 8, 8);
        ctx.globalAlpha = 1;
      }
      const anchor = range(p, 0.2, 0.56);
      const managed = ease(range(p, 0.6, 0.82));
      bars(g, anchor * (landed / BARS > 0 ? 1 : 0), managed, OPEN[0], OPEN[1]);
      // Labels.
      const la = range(p, 0.55, 0.65), lb = range(p, 0.8, 0.9);
      const ax = g.x0 + 2 * g.step;
      ctx.globalAlpha = la; ctx.strokeStyle = css(th.muted); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(ax, g.base - g.low - 6); ctx.lineTo(ax, g.base - g.low - 34); ctx.stroke(); ctx.globalAlpha = 1;
      text('anchor · full range', ax - 4, g.base - g.low - 66, th.fg, { alpha: la });
      if (!narrow()) text('the manager can never move it', ax - 4, g.base - g.low - 46, th.muted, { alpha: la, upper: false, font: SANS, size: 13, weight: 400 });
      const mx = g.x0 + ((OPEN[0] + OPEN[1]) / 2) * g.step;
      text('opening position', mx, g.base - g.low - g.tall - 22, th.fg, { align: 'center', alpha: lb });
      text('only the hook can add liquidity', g.x1 + 2, g.base + 18, th.muted, { align: 'right', alpha: range(p, 0.9, 1) });
    },

    auction() {
      const g = pool();
      bars(g, 1, 1, OPEN[0], OPEN[1], 0.14);
      const bids: [string, string][] = [['0x4f…9c1e', '18,000'], ['0xb8…7c4a', '22,500'], ['0x71…a3c2', '25,000']];
      const at = [0.08, 0.3, 0.52];
      const cy = H * 0.36, cx = W / 2;
      // The clock to auctionEnd.
      const tx0 = W * 0.18, tx1 = W * 0.82, tyy = H * 0.16;
      const clock = range(p, 0, 0.78);
      ctx.strokeStyle = css(th.line); ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(tx0, tyy); ctx.lineTo(tx1, tyy); ctx.stroke();
      ctx.strokeStyle = css(th.fg);
      ctx.beginPath(); ctx.moveTo(tx0, tyy); ctx.lineTo(lerp(tx0, tx1, clock), tyy); ctx.stroke();
      text('bidding', tx0, tyy - 18, th.muted);
      text(clock >= 1 ? 'auctionEnd · closed' : 'auctionEnd', tx1, tyy - 18, th.fg, { align: 'right' });
      // Each new bid takes the top slot; the one it beats drops into the claimable lane.
      bids.forEach(([who, amt], i) => {
        const inn = ease(range(p, at[i], at[i] + 0.1));
        if (inn <= 0) return;
        const beaten = i < 2 ? ease(range(p, at[i + 1], at[i + 1] + 0.12)) : 0;
        // Beaten bids share a row; on a phone they stack.
        const laneY = H * 0.52 + (narrow() ? i * 38 : 0);
        const laneX = narrow() ? W / 2 : W / 2 + (i === 0 ? -1 : 1) * Math.min(W * 0.2, 130);
        const x = lerp(cx, laneX, beaten), y = lerp(cy - 40 * (1 - inn), laneY, beaten);
        const win = i === 2 ? ease(range(p, 0.8, 0.92)) : 0;
        if (win > 0) {
          ctx.globalAlpha = win; ctx.strokeStyle = css(th.bond); ctx.lineWidth = 2;
          ctx.beginPath(); ctx.roundRect(x - 120 - 8 * win, y - 17 - 8 * win, 240 + 16 * win, 34 + 16 * win, 26); ctx.stroke(); ctx.globalAlpha = 1;
        }
        pill(`${who}  ${amt} USDC`, x, y, beaten > 0.5 ? th.card : th.bond, beaten > 0.5 ? th.fg : th.bg, { alpha: inn * (1 - 0.35 * beaten), size: beaten > 0.5 ? 11 : 13, h: beaten > 0.5 ? 30 : 36 });
      });
      text('outbid · claimable at once', W / 2, H * 0.52 + (narrow() ? 84 : 36), th.muted, { align: 'center', alpha: range(p, 0.36, 0.46) });
      text('manager · bond on the line', cx, cy - 46, th.fg, { align: 'center', alpha: range(p, 0.84, 0.94) });
    },

    manage() {
      const g = pool();
      const move = easeInOut(range(p, 0.08, 0.4));
      const from = lerp(OPEN[0], MOVED[0], move), to = lerp(OPEN[1], MOVED[1], move);
      bars(g, 1, 1, from, to);
      const mx = g.x0 + ((from + to) / 2) * g.step, my = g.base - g.low - g.tall - 24;
      pill('rebalance()', mx, my, th.bond, th.bg, { alpha: range(p, 0.04, 0.12), size: 12, h: 30 });
      if (move > 0 && move < 1) {
        ctx.strokeStyle = css(th.bond); ctx.lineWidth = 1.5; ctx.setLineDash([3, 5]);
        const ox = g.x0 + ((OPEN[0] + OPEN[1]) / 2) * g.step;
        ctx.beginPath(); ctx.moveTo(ox, my + 22); ctx.lineTo(mx, my + 22); ctx.stroke(); ctx.setLineDash([]);
      }
      // The fee, inside floor..cap.
      const fy = H * 0.18, fx0 = W * 0.16, fx1 = W * 0.84;
      const fa = range(p, 0.38, 0.48);
      const fee = lerp(0.3, 0.18, easeInOut(range(p, 0.5, 0.72)));
      const fx = lerp(fx0, fx1, (fee - 0.05) / 0.25);
      ctx.globalAlpha = fa;
      ctx.strokeStyle = css(th.line); ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(fx0, fy); ctx.lineTo(fx1, fy); ctx.stroke();
      ctx.strokeStyle = css(th.fg);
      for (const x of [fx0, fx1]) { ctx.beginPath(); ctx.moveTo(x, fy - 7); ctx.lineTo(x, fy + 7); ctx.stroke(); }
      ctx.globalAlpha = 1;
      text('floor 0.05%', fx0, fy + 22, th.muted, { alpha: fa });
      text('cap 0.30%', fx1, fy + 22, th.muted, { align: 'right', alpha: fa });
      if (fa > 0) {
        ctx.globalAlpha = fa; ctx.fillStyle = css(th.bond);
        ctx.beginPath(); ctx.arc(fx, fy, 8, 0, TAU); ctx.fill(); ctx.globalAlpha = 1;
      }
      text(`setFee() ${fee.toFixed(2)}%`, fx, fy - 24, th.fg, { align: 'center', alpha: fa, weight: 600 });
      // The verb that doesn't exist.
      const wa = range(p, 0.76, 0.86);
      const wy = H * (narrow() ? 0.9 : 0.88);
      pill('withdraw()', W / 2, wy, th.card, th.muted, { alpha: wa, stroke: th.line, size: 12, h: 30 });
      if (wa > 0) {
        ctx.font = `600 12px ${MONO}`;
        const half = (ctx.measureText('withdraw()').width) / 2 + 4;
        ctx.globalAlpha = wa; ctx.strokeStyle = css(th.bad); ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(W / 2 - half, wy); ctx.lineTo(W / 2 - half + 2 * half * range(p, 0.82, 0.9), wy); ctx.stroke(); ctx.globalAlpha = 1;
      }
      text('no such function', W / 2, wy + 28, th.muted, { align: 'center', alpha: range(p, 0.86, 0.94) });
    },

    checks() {
      const nar = narrow();
      const x0 = W * (nar ? 0.06 : 0.1), x1 = W * (nar ? 0.94 : 0.9), y0 = H * 0.1, y1 = H * (nar ? 0.4 : 0.44);
      const mid = (y0 + y1) / 2, half = (y1 - y0) * 0.3;
      // The range band, the TWAP and spot, drawn as far as the scroll has got.
      ctx.fillStyle = css(th.card); ctx.fillRect(x0, mid - half, x1 - x0, half * 2);
      ctx.strokeStyle = css(th.line); ctx.lineWidth = 1;
      for (const yy of [mid - half, mid + half]) { ctx.beginPath(); ctx.moveTo(x0, yy); ctx.lineTo(x1, yy); ctx.stroke(); }
      text('range', x0, mid - half - 14, th.muted);
      const upto = lerp(x0, x1, range(p, 0.02, 0.96));
      const f = (x: number) => (x - x0) / (x1 - x0);
      const spotY = (x: number) => mid + half * (0.55 * Math.sin(f(x) * 19) + 0.3 * Math.sin(f(x) * 43 + 1) + 0.15 * Math.sin(f(x) * 97));
      const twapY = (x: number) => mid + half * 0.32 * Math.sin(f(x) * 9 + 0.6);
      ctx.strokeStyle = css(th.fg, 0.45); ctx.lineWidth = 1.2;
      ctx.beginPath(); for (let x = x0; x <= upto; x += 2) x === x0 ? ctx.moveTo(x, spotY(x)) : ctx.lineTo(x, spotY(x)); ctx.stroke();
      ctx.strokeStyle = css(th.mark); ctx.lineWidth = 2.5;
      ctx.beginPath(); for (let x = x0; x <= upto; x += 2) x === x0 ? ctx.moveTo(x, twapY(x)) : ctx.lineTo(x, twapY(x)); ctx.stroke();
      text('twap', x1, twapY(x1) - 16, th.fg, { align: 'right', alpha: range(p, 0.9, 0.96) });
      // Swaps: a dot each, and each one runs the checks.
      const every = (x1 - x0) / 22;
      let last = -1;
      for (let k = 0; k < 22; k++) {
        const x = x0 + every * (k + 0.5);
        if (x > upto) break;
        last = k;
        ctx.fillStyle = css(th.fg); ctx.beginPath(); ctx.arc(x, spotY(x), 3, 0, TAU); ctx.fill();
        ctx.strokeStyle = css(th.line); ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(x, y1 + 6); ctx.lineTo(x, y1 + 14); ctx.stroke();
      }
      text('swaps', x0, y1 + 28, th.muted);
      // The three checks; the latest swap lights them.
      const since = last < 0 ? 1 : (upto - (x0 + every * (last + 0.5))) / every;
      const pulse = clamp(1 - since, 0, 1);
      const rows: [string, string][] = [['in range', 'the TWAP is inside the range'], ['depth', 'liquidity at or above the floor'], ['pace', 'stablecoin share under the glide path']];
      const ry = H * (nar ? 0.56 : 0.6), gap = nar ? 30 : 34;
      rows.forEach(([k, v], i) => {
        const y = ry + i * gap;
        const on = range(p, 0.04 + i * 0.03, 0.1 + i * 0.03);
        text(k, x0, y, th.fg, { alpha: on, weight: 600 });
        if (!nar) text(v, x0 + 110, y, th.muted, { alpha: on, upper: false, font: SANS, size: 14, weight: 400 });
        ctx.globalAlpha = on; ctx.strokeStyle = css(th.fg); ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(x1 - 10, y, 10 + 4 * pulse, 0, TAU); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(x1 - 15, y); ctx.lineTo(x1 - 11, y + 4); ctx.lineTo(x1 - 5, y - 4); ctx.stroke(); ctx.globalAlpha = 1;
      });
      // The clock: seconds, not swaps.
      const cy = ry + 3 * gap + 18;
      ctx.fillStyle = css(th.card); ctx.fillRect(x0, cy - 5, x1 - x0, 10);
      const fill = range(p, 0.02, 0.96);
      ctx.fillStyle = css(th.fg); ctx.fillRect(x0, cy - 5, (x1 - x0) * fill * 0.94, 10);
      ctx.fillStyle = css(th.bad); ctx.fillRect(x0 + (x1 - x0) * fill * 0.94, cy - 5, (x1 - x0) * fill * 0.06, 10);
      text('seconds in compliance', x0, cy + 24, th.fg, { alpha: range(p, 0.1, 0.2) });
      text('out', x0 + (x1 - x0) * fill, cy + 24, th.muted, { align: 'right', alpha: range(p, 0.3, 0.4) });
    },

    settle() {
      const nar = narrow();
      const cards: { n: number; up: number; ok: boolean; out: string; at: number }[] = [
        { n: 3, up: 99.2, ok: true, out: '30% of the fees to the manager', at: 0.04 },
        { n: 4, up: 91.7, ok: false, out: 'bond to the treasury, manager fired', at: 0.5 },
      ];
      // Fixed rows inside each card, so it reads the same at any size.
      const cw = nar ? W - 32 : Math.min(W * 0.4, 380), ch = nar ? 206 : 300, pad = nar ? 20 : 28;
      const big = nar ? 34 : 52;
      cards.forEach((c, i) => {
        const cx = nar ? 16 : W / 2 + (i === 0 ? -cw - 12 : 12);
        const cy0 = nar ? Math.max(12, H / 2 - ch - 10) + i * (ch + 20) : (H - ch) / 2;
        const inn = ease(range(p, c.at - 0.04, c.at + 0.08));
        const cy = cy0 + (1 - inn) * 24;
        ctx.globalAlpha = inn;
        ctx.fillStyle = css(th.card); ctx.beginPath(); ctx.roundRect(cx, cy, cw, ch, 22); ctx.fill();
        ctx.globalAlpha = 1;
        text(`epoch ${c.n}`, cx + pad, cy + pad + 4, th.muted, { alpha: inn });
        const fill = ease(range(p, c.at + 0.04, c.at + 0.3));
        const v = lerp(80, c.up, fill);
        text(`${v.toFixed(1)}%`, cx + pad, cy + pad + 18 + big / 2, th.fg, { alpha: inn, font: SANS, weight: 800, size: big, upper: false });
        text('of the epoch in compliance', cx + pad, cy + pad + 30 + big, th.muted, { alpha: inn, font: SANS, weight: 400, size: 13, upper: false });
        // The bar runs from 80%, so the 95% allowance is readable.
        const bx0 = cx + pad, bx1 = cx + cw - pad, by = cy + pad + (nar ? 74 : 110) + big * 0.5;
        ctx.globalAlpha = inn;
        ctx.fillStyle = css(th.line); ctx.fillRect(bx0, by - 4, bx1 - bx0, 8);
        ctx.fillStyle = css(c.ok ? th.good : th.bad); ctx.fillRect(bx0, by - 4, (bx1 - bx0) * ((v - 80) / 20), 8);
        const lx = lerp(bx0, bx1, 0.75);
        ctx.strokeStyle = css(th.fg); ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(lx, by - 12); ctx.lineTo(lx, by + 12); ctx.stroke();
        ctx.globalAlpha = 1;
        text('95% allowance', lx, by + 24, th.muted, { align: 'center', alpha: inn, size: 10 });
        const stamp = ease(range(p, c.at + 0.32, c.at + 0.4));
        const sy = cy + ch - pad - 12;
        const label = c.ok ? 'PAID' : 'SLASHED';
        ctx.font = `600 12px ${MONO}`;
        const sw = ctx.measureText(label).width + 27;
        pill(label, bx0 + sw / 2, sy, c.ok ? th.good : th.bad, th.bg, { alpha: stamp, size: 12, h: 30 });
        text(c.out, bx0 + sw + 12, sy, th.fg, { alpha: stamp, upper: false, font: SANS, size: nar ? 12.5 : 14, weight: 500 });
      });
    },
  };

  function draw() {
    if (!W) return;
    ctx.clearRect(0, 0, W, H);
    scenes[scene]();
  }

  const ro = new ResizeObserver(resize);
  ro.observe(canvas);
  resize();
  return {
    set(s: Scene, progress: number) { scene = s; p = clamp(progress, 0, 1); draw(); },
    setTheme(t: Theme) { th = t; draw(); },
    redraw: draw,
    destroy() { ro.disconnect(); },
  };
}
