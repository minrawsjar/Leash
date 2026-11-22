export type Point = [number, number];
export type Hold = { head: Point; tail: Point };

const DT = 1 / 120; // fixed step: the same timeline always gives the same shape (replay, ?t= screenshots)
const GRAVITY = 5200; // image px/s²
const DAMPING = 0.99; // per step; webbing is light and draggy
const ITERATIONS = 30;

/**
 * A Verlet rope: point masses joined by links of fixed length. Both ends are held
 * (by the hand and by whatever the clip is attached to); the rest swings freely.
 */
export class Rope {
  pts: Point[] = [];
  private prev: Point[] = [];
  private time = 0;

  constructor(private readonly links: number[], private readonly rest: () => Point[]) {
    this.reset();
  }

  private reset() {
    this.pts = this.rest();
    this.prev = this.pts.map(([x, y]) => [x, y]);
    this.time = 0;
  }

  /** Simulates up to `to` seconds; `hold(t)` says where both ends are at time t. */
  advance(to: number, hold: (t: number) => Hold) {
    if (to < this.time) this.reset();
    for (let n = 0; this.time + DT <= to; n++) {
      // ponytail: after a long pause (hidden tab) jump ahead instead of replaying minutes of physics
      if (n === 1200) { this.time = to; break; }
      this.step(hold(this.time));
      this.time += DT;
    }
  }

  private step({ head, tail }: Hold) {
    const { pts, prev, links } = this, last = pts.length - 1;
    for (let i = 0; i <= last; i++) {
      const p = pts[i], q = prev[i];
      const vx = (p[0] - q[0]) * DAMPING, vy = (p[1] - q[1]) * DAMPING;
      q[0] = p[0]; q[1] = p[1];
      p[0] += vx; p[1] += vy + GRAVITY * DT * DT;
    }
    for (let k = 0; k < ITERATIONS; k++) {
      pin(pts[0], head);
      pin(pts[last], tail);
      for (let i = 0; i < last; i++) relax(pts[i], pts[i + 1], links[i], 0.5);
      // Webbing resists folding sharply: keep every other point at least ~90% of the straight distance apart.
      for (let i = 0; i < last - 2; i++) relax(pts[i], pts[i + 2], (links[i] + links[i + 1]) * 0.9, 0.1, true);
    }
    pin(pts[0], head);
    pin(pts[last], tail);
  }
}

function pin(p: Point, at: Point) {
  p[0] = at[0];
  p[1] = at[1];
}

/** Moves a and b toward distance `len`; `pushOnly` only separates points that are too close. */
function relax(a: Point, b: Point, len: number, k: number, pushOnly = false) {
  const dx = b[0] - a[0], dy = b[1] - a[1], d = Math.hypot(dx, dy) || 1e-6;
  if (pushOnly && d >= len) return;
  const f = ((d - len) / d) * k;
  a[0] += dx * f; a[1] += dy * f;
  b[0] -= dx * f; b[1] -= dy * f;
}
