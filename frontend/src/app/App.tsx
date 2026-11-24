// The Leash dApp at /app. Hash routes: #/ mandates, #/create, #/m/<poolId>[/<tab>].
import { Mark } from '../Mark';
import { useEffect, useState } from 'react';
import type { Hex } from 'viem';
import { NETS, short, type Net } from './chain.ts';
import { useWallet } from './wallet.ts';
import { AppCtx } from './ui.tsx';
import { Index } from './Index.tsx';
import { MandatePage } from './Mandate.tsx';
import { Create } from './Create.tsx';
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
              <a href="#/" aria-current={route.length === 0 || route[0] === 'm' ? 'page' : undefined}>Mandates</a>
              <a href="#/create" aria-current={route[0] === 'create' ? 'page' : undefined}>Post a mandate</a>
              <a href="../">About</a>
            </nav>
            <div className="lx-right">
              <label className="net">
                <span className="net-dot" aria-hidden />
                <span className="sr">Network</span>
                <select value={net.id} onChange={(e) => chooseNet(Number(e.target.value))}>
                  {Object.values(NETS).map((n) => <option key={n.id} value={n.id}>{n.short}</option>)}
                </select>
              </label>
              {wallet.account
                ? <span className={`acct ${wrongChain ? 'warn' : ''}`} title={wrongChain ? `Wallet is on chain ${wallet.chainId}; it will be asked to switch when you sign` : wallet.account}>{short(wallet.account)}</span>
                : <button type="button" className="btn primary sm" onClick={() => wallet.connect().catch((e) => setConnErr(e.message))}>Connect</button>}
            </div>
          </div>
        </header>
        {connErr && <p className="banner" role="alert">{connErr}</p>}
        <main className="lx-main" key={net.id}>
          {route[0] === 'create' ? <Create />
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
