import { useEffect, useRef, useState } from 'react';
import sceneUrl from './assets/scene.webp';
import dogUrl from './assets/dog.webp';
import { Rope, type Hold, type Point } from './rope';

type Pose = { r: number; x: number; y: number };

// Image-space coordinates (the art is 1402×1122). Tune these if the art changes.
const PIVOT: Point = [250, 860]; // hind feet: the dog leans around them
const TAIL: Point = [282, 300]; // tail base
const COLLAR: Point = [486, 448]; // where the snap hook catches the bandana's D-ring
const HAND: Point = [-80, 30]; // the leash is held off-frame, top left
const CHASE: Pose = { r: 2.2, x: 16, y: -6 };
const HELD: Pose = { r: -3.2, x: -16, y: 2 };
const T = { throw: 1.4, snap: 2.2, settle: 3.6 }; // seconds

// Leash build: a 30px strap (≈2.5cm at this scale) ending in a bolt snap drawn 104 units long at scale K.
const STRAP = 30;
const K = 1.6;
const REACH = 104 * K; // strap end → D-ring
const SEGS = 34; // strap links; the hardware is one more, rigid link

const LINES: [at: number, text: string][] = [
  [0, 'The manager goes for the coins.'],
  [T.throw - 0.3, 'The treasury posts a mandate.'],
  [T.snap, 'Clipped. The inventory stays in the hook.'],
  [T.settle + 0.8, 'Free to make markets. Not free to run.'],
];

// [x, y, scale, delay in seconds] — glints on the coins in the art
const SPARKS: [number, number, number, number][] = [
  [1196, 312, 1, 0.2], [1112, 548, 1.2, 1.4], [1362, 690, 0.8, 2.3], [1312, 522, 0.7, 0.9],
  [522, 852, 1, 2.9], [286, 606, 0.8, 1.9], [62, 424, 0.7, 0.5], [1148, 898, 0.8, 2.6],
];

const clamp01 = (u: number) => Math.min(1, Math.max(0, u));
const ease = (u: number) => (u = clamp01(u), u * u * (3 - 2 * u));
const mix = (a: number, b: number, u: number) => a + (b - a) * u;
const line = (ps: Point[]) => 'M' + ps.join('L');

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

// Where the leash's two ends are at time t: in the hand, then thrown, then clipped to the collar.
function hold(t: number): Hold {
  if (t < T.throw) return { head: HAND, tail: HAND }; // folded in the hand, off-frame
  const collar = place(COLLAR, pose(t));
  if (t >= T.snap) return { head: HAND, tail: collar };
  const u = ease((t - T.throw) / (T.snap - T.throw)); // the snap hook arcs in
  return { head: HAND, tail: [mix(HAND[0], collar[0], u), mix(HAND[1], collar[1], u) - Math.sin(Math.PI * u) * 160] };
}

// Just long enough to go taut at the peak of the lunge.
const LENGTH = 1.02 * Math.hypot(...(place(COLLAR, CHASE).map((v, i) => v - HAND[i]) as Point));
const LINKS = [...Array<number>(SEGS).fill((LENGTH - REACH) / SEGS), REACH];
const folded = (): Point[] => LINKS.concat(0).map((_, i, all) => {
  const along = (i / (all.length - 1)) * LENGTH;
  return [HAND[0] + (along < LENGTH / 2 ? -5 : 5), HAND[1] + Math.min(along, LENGTH - along)];
});

// Nylon webbing colour for a strip whose face is turned `lit` (0 edge-on … 1 facing us) toward the light.
function webbing(lit: number) {
  const dark = [62, 12, 20], base = [214, 54, 42], spec = [255, 132, 110];
  const c = dark.map((d, i) => mix(d, base[i], Math.min(lit / 0.85, 1)));
  const s = clamp01((lit - 0.85) / 0.15) * 0.55;
  return `rgb(${c.map((v, i) => Math.round(mix(v, spec[i], s))).join(',')})`;
}

export function LeashScene() {
  const svgRef = useRef<SVGSVGElement>(null);
  const worldRef = useRef<SVGGElement>(null);
  const dogRef = useRef<SVGGElement>(null);
  const tailRef = useRef<SVGImageElement>(null);
  const leashRef = useRef<SVGGElement>(null);
  const shadowRef = useRef<SVGPathElement>(null);
  const strapRef = useRef<SVGGElement>(null);
  const clipRef = useRef<SVGGElement>(null);
  const dogRingRef = useRef<SVGPathElement>(null);
  const clipRingRef = useRef<SVGPathElement>(null);
  const flashRef = useRef<SVGCircleElement>(null);
  const progressRef = useRef<HTMLElement>(null);
  const replay = useRef(() => {});
  const [line_, setLine] = useState(0);

  // Per-frame updates write SVG attributes directly; React only re-renders when the caption changes.
  useEffect(() => {
    const world = worldRef.current!, dog = dogRef.current!, tail = tailRef.current!;
    const leash = leashRef.current!, shadow = shadowRef.current!, clip = clipRef.current!, flash = flashRef.current!;
    const dogRing = dogRingRef.current!, clipRing = clipRingRef.current!, progress = progressRef.current!;
    const [base, quads, weaveA, weaveB, sheen, rim] = strapRef.current!.children as unknown as [
      SVGPathElement, SVGGElement, SVGPathElement, SVGPathElement, SVGPathElement, SVGPathElement,
    ];
    const rope = new Rope(LINKS, folded);
    let shown = -1;

    function drawLeash(t: number) {
      const pts = rope.pts, strap = pts.slice(0, -1), n = strap.length;
      const left: Point[] = [], right: Point[] = [], inA: Point[] = [], inB: Point[] = [], lit: number[] = [];
      for (let i = 0; i < n; i++) {
        const a = strap[Math.max(0, i - 1)], b = strap[Math.min(n - 1, i + 1)], p = strap[i];
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
        const nx = -(b[1] - a[1]) / len, ny = (b[0] - a[0]) / len;
        // One slow twist along the strap: edge-on it narrows and darkens, like real webbing.
        const face = Math.cos(1.35 * Math.sin(Math.PI * 1.7 * (i / (n - 1)) + 0.6 + 0.35 * Math.sin(t * 0.9)));
        const half = (STRAP / 2) * (0.22 + 0.78 * Math.abs(face));
        const at = (o: number): Point => [p[0] + nx * half * o, p[1] + ny * half * o];
        left.push(at(1)); right.push(at(-1)); inA.push(at(0.45)); inB.push(at(-0.45));
        // The room is dim by the monitor (left) and warm toward the dog: light the strap to match.
        const room = 0.68 + 0.32 * clamp01((p[0] + 80) / 650);
        lit.push(Math.abs(face) * (face < 0 ? 0.85 : 1) * room);
      }
      Array.from(quads.children).forEach((q, i) => {
        q.setAttribute('d', `M${left[i]}L${left[i + 1]}L${right[i + 1]}L${right[i]}Z`);
        q.setAttribute('fill', webbing((lit[i] + lit[i + 1]) / 2));
      });
      base.setAttribute('d', line(strap));
      weaveA.setAttribute('d', line(inA));
      weaveB.setAttribute('d', line(inB));
      sheen.setAttribute('d', line(left));
      rim.setAttribute('d', line(right));
      shadow.setAttribute('d', line(pts));

      const [s0, s1] = [pts[pts.length - 2], pts[pts.length - 1]];
      const angle = (Math.atan2(s1[1] - s0[1], s1[0] - s0[0]) * 180) / Math.PI;
      clip.setAttribute('transform', `translate(${s0}) rotate(${angle})`);
    }

    function render(t: number) {
      const p = pose(t);
      dog.setAttribute('transform', `translate(${p.x} ${p.y}) rotate(${p.r} ${PIVOT})`);
      const fast = t < T.snap;
      tail.setAttribute('transform', `rotate(${Math.sin(t * (fast ? 20 : 8)) * (fast ? 9 : 6)} ${TAIL})`);

      rope.advance(t, hold);
      drawLeash(t);
      const clipped = t >= T.snap;
      leash.setAttribute('visibility', t < T.throw ? 'hidden' : 'visible');
      dogRing.setAttribute('visibility', clipped ? 'hidden' : 'visible');
      clipRing.setAttribute('visibility', clipped ? 'visible' : 'hidden');

      const collar = place(COLLAR, p), s = t - T.snap; // snap flash and a short camera shake
      const f = s >= 0 && s < 0.5 ? s / 0.5 : 1;
      flash.setAttribute('r', String(12 + 90 * f));
      flash.setAttribute('cx', String(collar[0]));
      flash.setAttribute('cy', String(collar[1]));
      flash.setAttribute('opacity', String(1 - f));
      const shake = s >= 0 && s < 0.3 ? 5 * (1 - s / 0.3) : 0;
      world.setAttribute('transform', shake ? `translate(${Math.sin(s * 95) * shake} ${Math.cos(s * 80) * shake})` : '');

      const i = LINES.findLastIndex(([at]) => t >= at);
      if (i !== shown) setLine((shown = i));
      progress.style.transform = `scaleX(${clamp01(t / (T.settle + 0.8))})`;
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

  const caption = LINES[line_][1];
  const dRing = 'M104 -12A12 12 0 0 0 104 12Z'; // D-ring: straight edge on the collar, bow toward the hook
  return (
    <figure className="plate">
      <svg ref={svgRef} viewBox="0 0 1402 1122" role="img"
        aria-label="A golden retriever puppy lunges at a pile of crypto coins until a red leash clips onto its bandana and holds it back.">
        <defs>
          {/* Tail is drawn separately so it can wag; the body excludes a slightly smaller tail region so the seam overlaps. */}
          <clipPath id="tailClip"><path d="M190 50H420V205L362 266L300 306L232 318L190 290Z" /></clipPath>
          <clipPath id="bodyClip">
            <path clipRule="evenodd" d="M0 0H1402V1122H0Z M195 55H415V200L358 258L298 292L236 300L195 280Z" />
          </clipPath>
          <linearGradient id="metal" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#fff1dd" /><stop offset=".35" stopColor="#cbbab3" />
            <stop offset=".55" stopColor="#6b5e69" /><stop offset=".8" stopColor="#d6c4bb" /><stop offset="1" stopColor="#3c313d" />
          </linearGradient>
          <linearGradient id="webbing" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#5a100c" /><stop offset=".5" stopColor="#d8402f" /><stop offset="1" stopColor="#5a100c" />
          </linearGradient>
          <filter id="glow" x="-1" y="-1" width="3" height="3">
            <feGaussianBlur stdDeviation="4" result="b" />
            <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>
          <filter id="soft" x="-10%" y="-10%" width="120%" height="120%"><feGaussianBlur stdDeviation="7" /></filter>
          <path id="spark" d="M0-22C2-6 6-2 22 0C6 2 2 6 0 22C-2 6-6 2-22 0C-6-2-2-6 0-22Z" />
        </defs>

        <g ref={worldRef}>
          <image href={sceneUrl} width="1402" height="1122" />
          <g ref={dogRef}>
            <image ref={tailRef} href={dogUrl} width="1402" height="1122" clipPath="url(#tailClip)" />
            <image href={dogUrl} width="1402" height="1122" clipPath="url(#bodyClip)" />
            {/* the bandana's D-ring, hanging until the hook catches it */}
            <path ref={dogRingRef} d={dRing} fill="none" stroke="url(#metal)" strokeWidth="3.5"
              transform={`translate(${COLLAR}) rotate(-90) scale(${K}) translate(-104 0)`} />
          </g>
          <g filter="url(#glow)" aria-hidden="true">
            {SPARKS.map(([x, y, k, delay]) => (
              <g key={`${x},${y}`} transform={`translate(${x} ${y}) scale(${k})`}>
                <use className="spark" href="#spark" style={{ animationDelay: `${delay}s` }} />
              </g>
            ))}
          </g>

          <g ref={leashRef} visibility="hidden">
            <path ref={shadowRef} fill="none" stroke="#000" strokeOpacity=".5" strokeWidth={STRAP}
              strokeLinecap="round" strokeLinejoin="round" filter="url(#soft)" transform="translate(-4 20)" />
            <g ref={strapRef} fill="none" strokeLinejoin="round">
              <path stroke="#3a0a08" strokeWidth={STRAP * 0.5} />
              <g>{Array.from({ length: SEGS }, (_, i) => <path key={i} />)}</g>
              <path stroke="#2a0504" strokeOpacity=".2" strokeWidth="1.1" strokeDasharray="2.5 2.5" />
              <path stroke="#2a0504" strokeOpacity=".2" strokeWidth="1.1" strokeDasharray="2.5 2.5" strokeDashoffset="2.5" />
              <path stroke="#ffd9cc" strokeOpacity=".4" strokeWidth="1.6" />
              <path stroke="#1c0302" strokeOpacity=".55" strokeWidth="1.8" />
            </g>
            {/* bolt snap: strap end folded and box-X stitched, swivel eye, barrel, hook and spring bolt */}
            <g ref={clipRef}>
              <g transform={`scale(${K})`}>
                <rect x="-2" y="-9" width="36" height="18" rx="2" fill="url(#webbing)" />
                <rect x="24" y="-9.5" width="10" height="19" rx="2" fill="#000" opacity=".28" />
                <path d="M3-6H21V6H3Z M3-6L21 6 M3 6L21-6" fill="none" stroke="#f6dccd" strokeOpacity=".65"
                  strokeWidth="1" strokeDasharray="2 1.6" />
                <rect x="30" y="-12" width="16" height="24" rx="7" fill="none" stroke="url(#metal)" strokeWidth="4" />
                <rect x="45" y="-4" width="7" height="8" rx="2" fill="url(#metal)" />
                <rect x="51" y="-7.5" width="26" height="15" rx="5" fill="url(#metal)" stroke="#2b2730" strokeWidth="1.2" />
                <path d="M57-7V7 M62-7V7" stroke="#2b2730" strokeOpacity=".45" strokeWidth="1" />
                <path d="M77-4C86-13 101-10 101 0C101 9 90 12 85 6" fill="none" stroke="url(#metal)"
                  strokeWidth="4.5" strokeLinecap="round" />
                <path d="M76 3L85 6" stroke="#d8d3dc" strokeWidth="2.6" strokeLinecap="round" />
                <path ref={clipRingRef} d={dRing} fill="none" stroke="url(#metal)" strokeWidth="3.5" visibility="hidden" />
              </g>
            </g>
          </g>
          <circle ref={flashRef} r="0" fill="none" stroke="#fff" strokeWidth="6" />
        </g>
      </svg>
      <div className="progress" aria-hidden="true"><i ref={progressRef} /></div>
      <figcaption>
        <span className="mono">Plate I</span>
        <span className="caption" aria-live="polite">{caption}</span>
        <button className="mono replay" type="button" onClick={() => replay.current()}>Replay</button>
      </figcaption>
    </figure>
  );
}
