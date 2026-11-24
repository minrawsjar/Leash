// Small shared pieces: the animated number, live dots, the action button that runs a write and says what happened.
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type { Hex } from 'viem';
import { explain } from './actions.ts';
import type { Net } from './chain.ts';
import type { Wallet } from './wallet.ts';

export const AppCtx = createContext<{ net: Net; wallet: Wallet; bump: () => void }>(null!);
export const useApp = () => useContext(AppCtx);

const still = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** A number that rolls to its new value. */
export function Ticker({ value, format }: { value: number; format: (v: number) => string }) {
  const [shown, setShown] = useState(value);
  const from = useRef(value);
  useEffect(() => {
    if (still || !isFinite(value) || !isFinite(from.current) || from.current === value) { setShown(value); from.current = value; return; }
    const a = from.current, t0 = performance.now();
    let raf = 0;
    const step = (t: number) => {
      const k = Math.min(1, (t - t0) / 700), e = 1 - Math.pow(1 - k, 3);
      setShown(a + (value - a) * e);
      if (k < 1) raf = requestAnimationFrame(step); else from.current = value;
    };
    raf = requestAnimationFrame(step);
    return () => { cancelAnimationFrame(raf); from.current = value; };
  }, [value]);
  return <span className="num">{format(shown)}</span>;
}

export function Dot({ ok, label, live }: { ok: boolean | null; label: string; live?: boolean }) {
  return <span className={`dot ${ok === null ? 'idle' : ok ? 'ok' : 'bad'} ${live ? 'live' : ''}`} role="img" aria-label={`${label}: ${ok === null ? 'n/a' : ok ? 'yes' : 'no'}`} title={label} />;
}

export function Check({ ok, children }: { ok: boolean | null; children: ReactNode }) {
  return <li className={`check ${ok === null ? 'idle' : ok ? 'ok' : 'bad'}`}><Dot ok={ok} label="" />{children}</li>;
}

export function TxLink({ hash }: { hash: Hex }) {
  const { net } = useApp();
  return net.explorer ? <a href={`${net.explorer}/tx/${hash}`} target="_blank" rel="noreferrer" className="mono">{hash.slice(0, 10)}…</a> : <span className="mono">{hash.slice(0, 10)}…</span>;
}

/** A button that runs a write, then reports the tx or the revert in plain words, and refreshes the page data. */
export function Act({ label, run, disabled, kind = 'primary', why }: { label: string; run: () => Promise<Hex | void>; disabled?: boolean; kind?: 'primary' | 'secondary' | 'violet' | 'rose'; why?: string }) {
  const { bump } = useApp();
  const [state, setState] = useState<{ busy?: boolean; err?: string; hash?: Hex }>({});
  async function go() {
    setState({ busy: true });
    try { const hash = await run(); setState({ hash: hash || undefined }); bump(); }
    catch (e) { setState({ err: explain(e) }); }
  }
  return (
    <div className="act">
      <button type="button" className={`btn ${kind}`} disabled={disabled || state.busy} onClick={go} aria-busy={state.busy}>{state.busy ? 'Waiting for wallet…' : label}</button>
      <p className="act-note" role="status" aria-live="polite">
        {state.err ? <span className="err">{state.err}</span> : state.hash ? <>Done · <TxLink hash={state.hash} /></> : why ?? ''}
      </p>
    </div>
  );
}

export function Stat({ label, children, tone }: { label: string; children: ReactNode; tone?: 'mint' | 'violet' | 'rose' }) {
  return <div className={`stat ${tone ?? ''}`}><span className="eyebrow">{label}</span><strong>{children}</strong></div>;
}

/** Runs `load` now, every `ms`, and whenever a dep changes; keeps the last good value and the last error. */
export function usePoll<T>(load: () => Promise<T>, ms: number, deps: unknown[]): { data: T | undefined; err: string } {
  const [data, setData] = useState<T>();
  const [err, setErr] = useState('');
  useEffect(() => {
    let live = true;
    const run = () => load().then((d) => { if (live) { setData(d); setErr(''); } }, (e) => { if (live) setErr(explain(e)); });
    run();
    const i = setInterval(run, ms);
    return () => { live = false; clearInterval(i); };
  }, deps);
  return { data, err };
}

/** Ticks once a second so countdowns move between chain polls. */
export function useClock(): number {
  const [t, setT] = useState(() => Date.now());
  useEffect(() => { const i = setInterval(() => setT(Date.now()), 1000); return () => clearInterval(i); }, []);
  return t;
}
