// Paper (light) by default, dark when the person switches; the choice is remembered and index.html applies it before
// the first paint. Switching fires 'leash-theme' so the canvases repaint in the new colours.
import { useEffect, useState } from 'react';

type Mode = 'light' | 'dark';
const KEY = 'leash.theme';
const current = (): Mode => document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
function apply(m: Mode) {
  try { localStorage.setItem(KEY, m); } catch { /* private mode: this page only */ }
  document.documentElement.dataset.theme = m;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', m === 'dark' ? '#13151b' : '#f5f2eb');
  dispatchEvent(new Event('leash-theme'));
}

export function ThemeToggle() {
  const [mode, setMode] = useState(current);
  useEffect(() => { const f = () => setMode(current()); addEventListener('leash-theme', f); return () => removeEventListener('leash-theme', f); }, []);
  const next = mode === 'dark' ? 'light' : 'dark';
  return (
    <button type="button" className="theme-toggle" aria-label={`Switch to ${next} theme`} title={`Switch to ${next} theme`}
      onClick={() => apply(next)}>
      {mode === 'dark' ? (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
          <circle cx="12" cy="12" r="4.2" />
          <path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M5.3 18.7l1.6-1.6M17.1 6.9l1.6-1.6" />
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" aria-hidden>
          <path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5Z" />
        </svg>
      )}
    </button>
  );
}
