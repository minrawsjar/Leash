import { useEffect, useRef, useState } from 'react';
import sceneUrl from './assets/scene.webp';
import dogUrl from './assets/dog.webp';

type Point = [number, number];
type Pose = { r: number; x: number; y: number };

// Image-space coordinates (the art is 1402×1122). Tune these if the art changes.
const PIVOT: Point = [250, 860]; // hind feet: the dog leans around them
const TAIL: Point = [282, 300]; // tail base
const COLLAR: Point = [486, 448]; // where the clip lands on the bandana
const HAND: Point = [-80, 30]; // the leash comes from off-frame, top left
const CHASE: Pose = { r: 2.2, x: 16, y: -6 };
const HELD: Pose = { r: -3.2, x: -16, y: 2 };
const T = { throw: 1.4, snap: 2.2, settle: 3.6 }; // seconds

const LINES: [at: number, text: string, held: boolean][] = [
  [0, 'A market maker chases every coin…', false],
  [T.throw - 0.3, 'The treasury posts a mandate.', false],
  [T.snap, 'Caught. Funds never leave the hook.', true],
  [T.settle + 0.8, 'Free to make markets. Not free to run.', true],
];

// [x, y, scale, delay in seconds] — glints on the coins in the art
const SPARKS: [number, number, number, number][] = [
  [1196, 312, 1, 0.2], [1112, 548, 1.2, 1.4], [1362, 690, 0.8, 2.3], [1312, 522, 0.7, 0.9],
  [522, 852, 1, 2.9], [286, 606, 0.8, 1.9], [62, 424, 0.7, 0.5], [1148, 898, 0.8, 2.6],
];

const clamp01 = (u: number) => Math.min(1, Math.max(0, u));
const ease = (u: number) => (u = clamp01(u), u * u * (3 - 2 * u));
const mix = (a: number, b: number, u: number) => a + (b - a) * u;

function pose(t: number): Pose {
  if (t < T.snap) { // run up and lunge at the coins
    const u = ease(t / T.snap);
    return { r: CHASE.r * u, x: CHASE.x * u, y: CHASE.y * u + Math.sin(t * 13) * 3 * (1 - u / 2) };
  }
  const s = t - T.snap; // the yank: damped spring from CHASE to HELD, then idle breathing
  const k = Math.exp(-4.5 * s) * Math.cos(13 * s);
  const idle = ease(s / 1.5);
  return {
    r: mix(HELD.r, CHASE.r, k) + Math.sin(t * 1.7) * 0.35 * idle,
    x: mix(HELD.x, CHASE.x, k),
    y: mix(HELD.y, CHASE.y, k) + Math.sin(t * 3.4) * 2 * idle,
  };
}

// Same maths as the SVG transform "translate(x y) rotate(r PIVOT)".
function place([px, py]: Point, p: Pose): Point {
  const a = (p.r * Math.PI) / 180, dx = px - PIVOT[0], dy = py - PIVOT[1];
  return [
    PIVOT[0] + dx * Math.cos(a) - dy * Math.sin(a) + p.x,
    PIVOT[1] + dx * Math.sin(a) + dy * Math.cos(a) + p.y,
  ];
}

export function LeashScene() {
  const svgRef = useRef<SVGSVGElement>(null);
  const worldRef = useRef<SVGGElement>(null);
  const dogRef = useRef<SVGGElement>(null);
  const tailRef = useRef<SVGImageElement>(null);
  const ringRef = useRef<SVGCircleElement>(null);
  const leashRef = useRef<SVGGElement>(null);
  const clipRef = useRef<SVGGElement>(null);
  const flashRef = useRef<SVGCircleElement>(null);
  const replay = useRef(() => {});
  const [line, setLine] = useState(0);

  // Per-frame updates write SVG attributes directly; React only re-renders when the caption changes.
  useEffect(() => {
    const world = worldRef.current!, dog = dogRef.current!, tail = tailRef.current!, ring = ringRef.current!;
    const leash = leashRef.current!, clip = clipRef.current!, flash = flashRef.current!;
    const strands = leash.querySelectorAll('.strand');
    let shown = -1;

    function render(t: number) {
      const p = pose(t);
      dog.setAttribute('transform', `translate(${p.x} ${p.y}) rotate(${p.r} ${PIVOT})`);
      const fast = t < T.snap;
      tail.setAttribute('transform', `rotate(${Math.sin(t * (fast ? 20 : 8)) * (fast ? 9 : 6)} ${TAIL})`);

      const collar = place(COLLAR, p);
      let end: Point, sag: number;
      if (t < T.snap) { // thrown: the clip arcs in from the hand
        const u = ease((t - T.throw) / (T.snap - T.throw));
        end = [mix(HAND[0], collar[0], u), mix(HAND[1], collar[1], u) - Math.sin(Math.PI * u) * 160];
        sag = mix(260, 60, u);
      } else { // taut on the yank, then a gentle slack that breathes with the dog
        const s = t - T.snap;
        end = collar;
        sag = mix(6, 90, ease(s / 1.2)) + Math.sin(t * 3.4) * 8 * ease(s / 1.5);
      }
      const ctrl: Point = [(HAND[0] + end[0]) / 2, (HAND[1] + end[1]) / 2 + sag];
      const d = `M${HAND} Q${ctrl} ${end}`;
      strands.forEach((s) => s.setAttribute('d', d));
      const angle = (Math.atan2(end[1] - ctrl[1], end[0] - ctrl[0]) * 180) / Math.PI;
      clip.setAttribute('transform', `translate(${end}) rotate(${angle})`);
      leash.setAttribute('visibility', t < T.throw ? 'hidden' : 'visible');
      ring.setAttribute('visibility', t < T.snap ? 'hidden' : 'visible');

      const s = t - T.snap; // snap flash and a short camera shake
      const f = s >= 0 && s < 0.5 ? s / 0.5 : 1;
      flash.setAttribute('r', String(12 + 90 * f));
      flash.setAttribute('cx', String(collar[0]));
      flash.setAttribute('cy', String(collar[1]));
      flash.setAttribute('opacity', String(1 - f));
      const shake = s >= 0 && s < 0.3 ? 5 * (1 - s / 0.3) : 0;
      world.setAttribute('transform', shake ? `translate(${Math.sin(s * 95) * shake} ${Math.cos(s * 80) * shake})` : '');

      const i = LINES.findLastIndex(([at]) => t >= at);
      if (i !== shown) setLine((shown = i));
    }

    // ?t=2.5 freezes the scene at that second (handy for screenshots).
    const frozen = parseFloat(new URLSearchParams(location.search).get('t') ?? '');
    const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
    let t0 = performance.now(), raf = 0, visible = true;

    const frame = (now: number) => {
      // The first frame's timestamp can predate t0; clamp so the timeline never goes negative.
      render(Number.isFinite(frozen) ? frozen : still ? T.settle + 2 : Math.max(0, (now - t0) / 1000));
      raf = visible && !still && !Number.isFinite(frozen) ? requestAnimationFrame(frame) : 0;
    };
    const start = () => { if (!raf) raf = requestAnimationFrame(frame); };

    const io = new IntersectionObserver(([e]) => { visible = e.isIntersecting; if (visible) start(); });
    io.observe(svgRef.current!);
    replay.current = () => { t0 = performance.now(); start(); };
    start();
    return () => { cancelAnimationFrame(raf); io.disconnect(); };
  }, []);

  const [, caption, held] = LINES[line];
  return (
    <figure className="stage">
      <svg ref={svgRef} viewBox="0 0 1402 1122" role="img"
        aria-label="A golden retriever puppy lunges at a pile of crypto coins until a red leash clips onto its bandana and holds it back.">
        <defs>
          {/* Tail is drawn separately so it can wag; the body excludes a slightly smaller tail region so the seam overlaps. */}
          <clipPath id="tailClip"><path d="M190 50H420V205L362 266L300 306L232 318L190 290Z" /></clipPath>
          <clipPath id="bodyClip">
            <path clipRule="evenodd" d="M0 0H1402V1122H0Z M195 55H415V200L358 258L298 292L236 300L195 280Z" />
          </clipPath>
          <linearGradient id="metal" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#f4f1ee" /><stop offset=".5" stopColor="#a49ea8" /><stop offset="1" stopColor="#5b5560" />
          </linearGradient>
          <filter id="glow" x="-1" y="-1" width="3" height="3">
            <feGaussianBlur stdDeviation="4" result="b" />
            <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>
          <path id="spark" d="M0-22C2-6 6-2 22 0C6 2 2 6 0 22C-2 6-6 2-22 0C-6-2-2-6 0-22Z" />
        </defs>

        <g ref={worldRef}>
          <image href={sceneUrl} width="1402" height="1122" />
          <g ref={dogRef}>
            <image ref={tailRef} href={dogUrl} width="1402" height="1122" clipPath="url(#tailClip)" />
            <image href={dogUrl} width="1402" height="1122" clipPath="url(#bodyClip)" />
            <circle ref={ringRef} cx={COLLAR[0]} cy={COLLAR[1]} r="10" fill="none" stroke="url(#metal)" strokeWidth="5" visibility="hidden" />
          </g>
          <g filter="url(#glow)" aria-hidden="true">
            {SPARKS.map(([x, y, k, delay]) => (
              <g key={`${x},${y}`} transform={`translate(${x} ${y}) scale(${k})`}>
                <use className="spark" href="#spark" style={{ animationDelay: `${delay}s` }} />
              </g>
            ))}
          </g>
          <g ref={leashRef} visibility="hidden" fill="none" strokeLinecap="round">
            <path className="strand" stroke="#2a0d0b" strokeWidth="22" />
            <path className="strand" stroke="var(--leash)" strokeWidth="15" />
            <path className="strand" stroke="#ffc2b8" strokeWidth="3" opacity=".55" />
            <g ref={clipRef}>
              <g transform="scale(1.3)">
                <rect x="-44" y="-8" width="18" height="16" rx="3" fill="var(--leash)" stroke="#2a0d0b" strokeWidth="3" />
                <rect x="-30" y="-10" width="32" height="20" rx="10" fill="url(#metal)" stroke="#3a3540" strokeWidth="2.5" />
                <circle cx="8" r="8" stroke="url(#metal)" strokeWidth="5" />
              </g>
            </g>
          </g>
          <circle ref={flashRef} r="0" fill="none" stroke="#fff" strokeWidth="6" />
        </g>
      </svg>
      <figcaption className="chip" data-held={held ? '' : undefined}><i /><span>{caption}</span></figcaption>
      <button className="replay" type="button" aria-label="Replay animation" onClick={() => replay.current()}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
          strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M3 12a9 9 0 1 0 3-6.7" /><path d="M3 4v5h5" />
        </svg>
      </button>
    </figure>
  );
}
