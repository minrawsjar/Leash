// The Leash dApp at /app. Hash routes: #/ mandates (#/?who=<address> filters), #/managers, #/create, #/m/<poolId>[/<tab>].
import { Mark } from '../Mark';
import { ThemeToggle } from '../ThemeToggle';
import { useEffect, useState } from 'react';
import type { Address, Hex } from 'viem';
import { NETS, short, type Net } from './chain.ts';
import { useWallet } from './wallet.ts';
import { AppCtx } from './ui.tsx';
import { Index } from './Index.tsx';
import { MandatePage } from './Mandate.tsx';
import { Create } from './Create.tsx';
import { Managers } from './Managers.tsx';
import './app.css';

function pickNet(): Net {
  const q = new URLSearchParams(location.search).get('chain');
  let saved: string | null = null;
  try { saved = localStorage.getItem('leash.chain'); } catch { /* private mode */ }
  const id = Number(q ?? saved ?? (/^(localhost|127\.)/.test(location.hostname) ? 31337 : 1301));
  return NETS[id] ?? NETS[1301];
}

function useHash() {
  const [h, setH] = useState(location.hash);
  useEffect(() => { const f = () => { setH(location.hash); window.scrollTo(0, 0); }; addEventListener('hashchange', f); return () => removeEventListener('hashchange', f); }, []);
  return h.replace(/^#\/?/, '').split('/').filter(Boolean);
}

/** The address chip; it opens a native popover menu (Esc and click-outside close it): copy, explorer, disconnect. */
function Account({ address, warn, explorer, onDisconnect }: { address: Address; warn: string; explorer: string; onDisconnect: () => void }) {
  const [copied, setCopied] = useState(false);
  const menu = () => document.getElementById('acct-menu') as HTMLElement & { hidePopover(): void } | null;
  const place = (b: HTMLElement) => {
    const m = menu(); if (!m) return;
    const r = b.getBoundingClientRect();
    m.style.top = `${r.bottom + 8}px`;
    m.style.right = `${Math.max(16, document.documentElement.clientWidth - r.right)}px`;
  };
  return (
    <>
      <button type="button" className={`acct ${warn ? 'warn' : ''}`} popoverTarget="acct-menu" title={warn || address} aria-haspopup="menu" onClick={(e) => place(e.currentTarget)}>{short(address)}</button>
      <div id="acct-menu" popover="auto" className="tip acct-menu" role="menu">
        <b className="mono">{short(address)}</b>
        <button type="button" role="menuitem" onClick={() => { navigator.clipboard?.writeText(address).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }, () => {}); }}>{copied ? 'Copied' : 'Copy address'}</button>
        {explorer && <a role="menuitem" href={`${explorer}/address/${address}`} target="_blank" rel="noreferrer">View on explorer</a>}
        <button type="button" role="menuitem" className="danger" onClick={() => { menu()?.hidePopover(); onDisconnect(); }}>Disconnect</button>
      </div>
    </>
  );
}

export function App() {
  const [net, setNet] = useState(pickNet);
  const [tick, setTick] = useState(0);
  const wallet = useWallet();
  const route = useHash();
  const [connErr, setConnErr] = useState('');

  function chooseNet(id: number) {
    try { localStorage.setItem('leash.chain', String(id)); } catch { /* ignore */ }
    const u = new URL(location.href); u.searchParams.delete('chain'); history.replaceState(null, '', u);
    setNet(NETS[id]);
  }
  const wrongChain = wallet.account && wallet.chainId !== null && wallet.chainId !== net.id;

  return (
    <AppCtx.Provider value={{ net, wallet, bump: () => setTick((t) => t + 1) }}>
      <div className="lx">
        <header className="lx-top">
          <div className="lx-bar">
            <a href="../" className="lx-mark" aria-label="Leash home"><Mark size={30} /><span>leash</span></a>
            <nav className="lx-nav" aria-label="App">
              <a href="#/" aria-current={route.length === 0 || route[0] === 'm' || route[0].startsWith('?') ? 'page' : undefined}>Mandates</a>
              <a href="#/managers" aria-current={route[0] === 'managers' ? 'page' : undefined}>Managers</a>
              <a href="#/create" aria-current={route[0] === 'create' ? 'page' : undefined}>Post a mandate</a>
              <a href="../">About</a>
            </nav>
            <div className="lx-right">
              <ThemeToggle />
              <label className="net">
                <span className="net-dot" aria-hidden />
                <span className="sr">Network</span>
                <select value={net.id} onChange={(e) => chooseNet(Number(e.target.value))}>
                  {Object.values(NETS).map((n) => <option key={n.id} value={n.id}>{n.short}</option>)}
                </select>
              </label>
              {wallet.account
                ? <Account address={wallet.account} warn={wrongChain ? `Wallet is on chain ${wallet.chainId}; it will be asked to switch when you sign` : ''} explorer={net.explorer} onDisconnect={wallet.disconnect} />
                : <button type="button" className="btn primary sm" onClick={() => wallet.connect().catch((e) => setConnErr(e.message))}>Connect</button>}
            </div>
          </div>
        </header>
        {connErr && <p className="banner" role="alert">{connErr}</p>}
        <main className="lx-main" key={net.id}>
          {route[0] === 'create' ? <Create />
            : route[0] === 'managers' ? <Managers refresh={tick} />
            : route[0] === 'm' && route[1] ? <MandatePage id={route[1] as Hex} tab={route[2] ?? 'dashboard'} refresh={tick} />
            : <Index refresh={tick} />}
        </main>
        <footer className="lx-foot">
          <span>{net.name} · hook <span className="mono">{short(net.dep.leash)}</span></span>
          {net.explorer && <a href={`${net.explorer}/address/${net.dep.leash}`} target="_blank" rel="noreferrer">Verified source</a>}
          <a href="../">About Leash</a>
        </footer>
      </div>
    </AppCtx.Provider>
  );
}
