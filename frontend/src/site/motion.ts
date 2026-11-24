// The page's motion, wired once the markup is in: the hero canvas, the story the scroll plays, the nav's
// menus, reveals and counters, the phone's screens. Returns a cleanup for React.
import { mountHero } from './hero';
import { THEMES, blendTheme, createStory, css, readThemes, type Scene } from './story';

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const SCENES: Scene[] = ['deposit', 'auction', 'manage', 'checks', 'settle'];
const LOOK: (keyof typeof THEMES)[] = ['dark', 'violet', 'cream', 'mint', 'dark'];
const STILL = [0.92, 0.95, 0.95, 0.9, 0.95]; // each scene's most telling moment, for the still version

export function mount(root: HTMLElement) {
  readThemes();
  const $ = <T extends Element = HTMLElement>(s: string) => root.querySelector(s) as T;
  const $$ = <T extends Element = HTMLElement>(s: string) => [...root.querySelectorAll(s)] as T[];
  const params = new URLSearchParams(location.search);
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches || params.has('still');
  root.classList.toggle('reduced', reduced);
  // Every listener hangs off one signal, so React's cleanup (and StrictMode's second mount) drops them all.
  const ac = new AbortController();
  const sig = { signal: ac.signal };
  const off: (() => void)[] = [() => ac.abort()];
  const on = <K extends keyof WindowEventMap>(type: K, fn: (e: WindowEventMap[K]) => void, opts: AddEventListenerOptions = {}) =>
    addEventListener(type, fn, { ...opts, signal: ac.signal });

  // ── hero ────────────────────────────────────────────────────────────────
  const t = params.get('t');
  off.push(mountHero($('.hero'), $<HTMLCanvasElement>('.hero__canvas'), { reduced, freeze: t === null ? null : Number(t) || 0 }));

  // ── story ───────────────────────────────────────────────────────────────
  const story = $('.story'), stage = $('.story__stage');
  const steps = $$('.step'), rail = $$('.rail li');
  if (reduced) {
    // No pinning: each scene is its own block, its canvas stopped at its key moment.
    const stills = steps.map((step, i) => {
      const theme = THEMES[LOOK[i]];
      step.style.setProperty('--step-bg', css(theme.bg));
      step.style.setProperty('--step-fg', css(theme.fg));
      const canvas = document.createElement('canvas');
      canvas.setAttribute('aria-hidden', 'true');
      step.append(canvas);
      const s = createStory(canvas);
      s.setTheme(theme);
      s.set(SCENES[i], STILL[i]);
      off.push(() => { s.destroy(); canvas.remove(); });
      return s;
    });
    void document.fonts?.ready.then(() => stills.forEach((s) => s.redraw()));
  } else {
    const s = createStory($<HTMLCanvasElement>('.story__canvas'));
    let shown = -1;
    const update = () => {
      const box = story.getBoundingClientRect();
      const progress = clamp(-box.top / (box.height - innerHeight), 0, 1);
      const x = Math.min(progress * SCENES.length, SCENES.length - 1e-4);
      const i = Math.floor(x), p = x - i;
      // Each scene plays over the middle of its stretch, so it holds finished before the next one.
      s.set(SCENES[i], clamp((p - 0.06) / 0.78, 0, 1));
      const theme = blendTheme(THEMES[LOOK[Math.max(0, i - 1)]], THEMES[LOOK[i]], i === 0 ? 1 : Math.min(1, p / 0.1));
      s.setTheme(theme);
      stage.style.setProperty('--stage-bg', css(theme.bg));
      stage.style.setProperty('--stage-fg', css(theme.fg));
      stage.style.setProperty('--stage-muted', css(theme.muted));
      stage.style.setProperty('--stage-line', css(theme.line));
      if (i !== shown) { steps.forEach((el, n) => el.classList.toggle('is-active', n === i)); shown = i; }
      rail.forEach((li, n) => li.style.setProperty('--fill', String(n < i ? 1 : n === i ? p : 0)));
    };
    on('scroll', update, { passive: true });
    on('resize', update);
    update();
    void document.fonts?.ready.then(update);
    off.push(() => s.destroy());
  }

  // ── the phone takes turns between its screens ───────────────────────────
  const phone = $('.phone');
  let beat = 0;
  if (!reduced) {
    const id = setInterval(() => { phone.dataset.screen = ['home', 'send', 'sent'][(beat = (beat + 1) % 3)]; }, 2800);
    off.push(() => clearInterval(id));
  }
  // Each flow row twice over, so sliding it by half loops without a seam.
  for (const r of $$('.flow__row')) if (!r.dataset.doubled) { r.dataset.doubled = '1'; r.append(...[...r.children].map((c) => c.cloneNode(true))); }

  // ── nav menus: hover or click opens one panel; Esc, or a click away, closes ──
  const nav = $('#nav');
  const triggers = $$<HTMLButtonElement>('.menu__trigger');
  const panelOf = (b: Element) => root.querySelector(`#${b.getAttribute('aria-controls')}`)!;
  const hoverable = matchMedia('(hover: hover) and (min-width: 861px)');
  let closing = 0;
  const openMenu = (trigger: Element | null) => {
    clearTimeout(closing);
    for (const b of triggers) { b.setAttribute('aria-expanded', String(b === trigger)); panelOf(b).toggleAttribute('data-open', b === trigger); }
  };
  const closeSoon = () => { closing = window.setTimeout(() => openMenu(null), 180); };
  for (const b of triggers) {
    b.addEventListener('click', () => openMenu(b.getAttribute('aria-expanded') === 'true' ? null : b), sig);
    b.addEventListener('pointerenter', () => { if (hoverable.matches) openMenu(b); }, sig);
    b.addEventListener('pointerleave', () => { if (hoverable.matches) closeSoon(); }, sig);
    const panel = panelOf(b);
    panel.addEventListener('pointerenter', () => clearTimeout(closing), sig);
    panel.addEventListener('pointerleave', () => { if (hoverable.matches) closeSoon(); }, sig);
    panel.querySelectorAll<HTMLElement>('.menu__link, .menu__card').forEach((el, i) => el.style.setProperty('--i', String(i)));
  }
  const toggle = $('.menu__toggle');
  const setSheet = (open: boolean) => { nav.toggleAttribute('data-sheet', open); toggle.setAttribute('aria-expanded', String(open)); };
  toggle.addEventListener('click', () => setSheet(!nav.hasAttribute('data-sheet')), sig);
  nav.addEventListener('click', (e) => { if ((e.target as Element).closest('.menu__sheet a')) { openMenu(null); setSheet(false); } }, sig);
  on('click', (e) => { if (!nav.contains(e.target as Node)) { openMenu(null); setSheet(false); } });
  on('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const open = triggers.find((b) => b.getAttribute('aria-expanded') === 'true');
    openMenu(null); setSheet(false); open?.focus();
  });

  // ── reveals and counters ────────────────────────────────────────────────
  const count = (el: HTMLElement) => {
    const to = Number(el.dataset.count), from = Number(el.dataset.from ?? 0), suffix = el.dataset.suffix ?? '';
    if (reduced || from === to && to === 0) return;
    const start = performance.now();
    const tick = (now: number) => {
      const k = Math.min(1, (now - start) / 1100);
      el.textContent = String(Math.round(from + (to - from) * (1 - (1 - k) ** 3))) + suffix;
      if (k < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  };
  const reveal = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      e.target.classList.add('is-in');
      e.target.querySelectorAll<HTMLElement>('[data-count]').forEach(count);
      reveal.unobserve(e.target);
    }
  }, { threshold: 0.15 });
  $$('[data-reveal]').forEach((el) => reveal.observe(el));
  off.push(() => reveal.disconnect());

  // ── ?shot=<id> or ?shot=story-<scene>: jump there, for screenshots ──────
  const shot = params.get('shot');
  if (shot) {
    root.querySelectorAll('[data-reveal]').forEach((el) => el.classList.add('is-in'));
    requestAnimationFrame(() => {
      const m = /^story-([\d.]+)$/.exec(shot);
      let y = 0;
      if (m) y = story.offsetTop + (story.offsetHeight - innerHeight) * clamp(Number(m[1]) / SCENES.length, 0, 1);
      else { const el = document.getElementById(shot); if (el) y = el.getBoundingClientRect().top + scrollY - (shot === 'story' ? 0 : 80); }
      scrollTo({ top: y, behavior: 'instant' });
    });
  }

  return () => off.forEach((f) => f());
}
