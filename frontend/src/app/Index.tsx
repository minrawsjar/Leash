// The explorer home: search, network stats, latest mandates and activity, then every mandate with filters.
import { useMemo, useState, type FormEvent } from 'react';
import { zeroAddress } from 'viem';
import {
  ago, blockTime, chainNow, describe, dur, endOf, fmt, fmtNum, leashLogs, mandatesFrom, short, snapshot, stableOf,
  type LeashLog, type Snapshot,
} from './chain.ts';
import { Dot, TxLink, useApp, useClock, usePoll } from './ui.tsx';

export const STATUS: Record<string, string> = {
  auction: 'Auction', active: 'Active', unhired: 'No bids', ended: 'Ended · to close', breached: 'Breached', closed: 'Closed',
};
const EVENT: Record<string, string> = {
  MandateCreated: 'Posted', Bid: 'Bid', Rebalanced: 'Rebalance', FeeSet: 'Fee set', EpochSettled: 'Settled', Closed: 'Closed',
};
const pairOf = (s: Snapshot) => {
  const t = s.m.terms;
  return { token: s.tok[t.stableIs0 ? 1 : 0], stable: s.tok[stableOf(s.key, t) === s.key.currency0 ? 0 : 1] };
};
type Filter = 'all' | 'live' | 'mine' | 'closed';

export function Index({ refresh }: { refresh: number }) {
  const { net, wallet } = useApp();
  const { data, err } = usePoll(async () => {
    const logs = await leashLogs(net);
    const snaps = await Promise.all(mandatesFrom(logs).map((x) => snapshot(net, x.id, x.key)));
    return { logs, snaps: snaps.reverse() };
  }, net.logsApi ? 20_000 : 5_000, [net.id, refresh]);

  const [filter, setFilter] = useState<Filter>('all');
  const [who, setWho] = useState('');
  const [q, setQ] = useState('');
  const [miss, setMiss] = useState('');

  const byId = useMemo(() => new Map((data?.snaps ?? []).map((s) => [s.id.toLowerCase(), s])), [data]);
  const recent = useMemo(() => [...(data?.logs ?? [])].reverse().slice(0, 8), [data]);
  const created = useMemo(() => new Map((data?.logs ?? []).filter((l) => l.eventName === 'MandateCreated').map((l) => [String(l.args.id).toLowerCase(), l])), [data]);
  const timed = useMemo(() => [...recent, ...(data?.snaps ?? []).slice(0, 6).map((s) => created.get(s.id.toLowerCase())!).filter(Boolean)], [recent, data, created]);
  const times = usePoll(async () => new Map(await Promise.all(timed.map(async (l) => [String(l.blockNumber), await blockTime(net, l.blockNumber)] as const))), 30_000, [timed.map((l) => String(l.blockNumber)).join()]);

  function search(e: FormEvent) {
    e.preventDefault();
    const v = q.trim().toLowerCase();
    setMiss('');
    if (!v || !data) return;
    if (byId.has(v)) { location.hash = `#/m/${byId.get(v)!.id}`; return; }
    const tx = data.logs.find((l) => l.transactionHash.toLowerCase() === v);
    if (tx) { location.hash = `#/m/${String(tx.args.id)}`; return; }
    if (/^0x[0-9a-f]{40}$/.test(v)) { setWho(v); setFilter('all'); document.getElementById('all')?.scrollIntoView({ behavior: 'smooth' }); return; }
    setMiss('No mandate, transaction or address matches that.');
  }

  const snaps = data?.snaps ?? [];
  const me = wallet.account?.toLowerCase();
  const involves = (s: Snapshot, a: string) => s.m.treasury.toLowerCase() === a || s.m.manager.toLowerCase() === a;
  const shown = snaps.filter((s) =>
    (!who || involves(s, who)) &&
    (filter === 'all' || (filter === 'live' && (s.status === 'auction' || s.status === 'active'))
      || (filter === 'closed' && s.status === 'closed') || (filter === 'mine' && !!me && involves(s, me))));

  // headline numbers
  const live = snaps.filter((s) => s.status === 'auction' || s.status === 'active').length;
  const bonds = new Map<string, number>();
  for (const s of snaps) if (s.m.manager !== zeroAddress && s.status !== 'closed') {
    const { stable } = pairOf(s);
    bonds.set(stable.symbol, (bonds.get(stable.symbol) ?? 0) + Number(s.m.bond) / 10 ** stable.decimals);
  }
  const managers = new Set(snaps.filter((s) => s.m.manager !== zeroAddress).map((s) => s.m.manager.toLowerCase())).size;
  const head = snaps[0];

  return (
    <>
      <section className="head x-head">
        <p className="eyebrow">{net.name} · mandate explorer</p>
        <h1>Mandates</h1>
        <form className="x-search" role="search" onSubmit={search}>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by pool id, transaction hash, treasury or manager address" aria-label="Search mandates" spellCheck={false} />
          <button className="btn primary sm" type="submit">Search</button>
        </form>
        {miss && <p className="quiet" role="status">{miss}</p>}
      </section>

      {err && <p className="banner" role="alert">Can't read the chain: {err}{net.id === 31337 ? ' Is ./scripts/local.sh running?' : ''}</p>}
      {!data && !err && <p className="empty">Reading mandates from the hook…</p>}

      {data && (
        <>
          <div className="stats x-stats">
            <div className="stat"><span className="eyebrow">Mandates</span><strong>{snaps.length} <small>posted</small></strong></div>
            <div className="stat mint"><span className="eyebrow">Live now</span><strong>{live} <small>auction or active</small></strong></div>
            <div className="stat violet"><span className="eyebrow">Bonds at stake</span><strong>{bonds.size ? [...bonds].map(([k, v]) => `${fmtNum(v)} ${k}`).join(' + ') : '0'}</strong></div>
            <div className="stat"><span className="eyebrow">Managers</span><strong>{managers} <small>hired</small></strong></div>
            <div className="stat"><span className="eyebrow">Hook events</span><strong>{data.logs.length}</strong></div>
            <div className="stat"><span className="eyebrow">Latest block</span><strong className="mono">{head ? String(head.block) : '–'}</strong></div>
          </div>

          <section className="x-cta" aria-labelledby="cta">
            <div>
              <h2 id="cta">Create your own mandate</h2>
              <p>Deposit a token pair, set the rules (range, depth, fee band, uptime) and auction the job. The winning manager runs your liquidity under a bond, and you can take everything back at the end.</p>
            </div>
            <div className="x-cta-acts">
              <a className="btn primary" href="#/create">Post a mandate</a>
              <a className="btn secondary" href="#/create/ai">Draft it with AI</a>
            </div>
          </section>

          {snaps.length === 0 ? (
            <div className="empty card">
              <p>No mandates on {net.name} yet.</p>
              <a className="btn primary" href="#/create">Post the first mandate</a>
            </div>
          ) : (
            <div className="x-grid">
              <section className="card x-panel" aria-labelledby="lm">
                <div className="card-head"><h2 id="lm">Latest mandates</h2></div>
                <ul className="x-list">
                  {snaps.slice(0, 6).map((s) => {
                    const c = created.get(s.id.toLowerCase());
                    const { token, stable } = pairOf(s);
                    const a = c?.args as Record<string, bigint> | undefined;
                    const t = times.data?.get(String(c?.blockNumber));
                    return (
                      <li key={s.id}>
                        <span className="x-ico" aria-hidden>M</span>
                        <span className="x-main">
                          <a href={`#/m/${s.id}`}><b>{token.symbol} / {stable.symbol}</b> <span className="mono">{short(s.id)}</span></a>
                          <small>{t ? ago(s.now - t) : `block ${String(c?.blockNumber ?? '')}`} · treasury <button type="button" className="x-addr mono" onClick={() => setWho(s.m.treasury.toLowerCase())}>{short(s.m.treasury)}</button></small>
                        </span>
                        <span className="x-side">
                          <span className={`pill ${s.status}`}>{STATUS[s.status]}</span>
                          {a && <span className="x-badge mono">{fmt(s.m.terms.stableIs0 ? a.amount0 : a.amount1, stable.decimals)} {stable.symbol}</span>}
                        </span>
                      </li>
                    );
                  })}
                </ul>
                <a className="x-more" href="#all" onClick={(e) => { e.preventDefault(); document.getElementById('all')?.scrollIntoView({ behavior: 'smooth' }); }}>View all mandates →</a>
              </section>

              <section className="card x-panel" aria-labelledby="la">
                <div className="card-head"><h2 id="la">Latest activity</h2></div>
                <ul className="x-list">
                  {recent.map((l) => <Activity key={`${l.transactionHash}-${l.logIndex}`} l={l} s={byId.get(String(l.args.id).toLowerCase())} t={times.data?.get(String(l.blockNumber))} />)}
                </ul>
              </section>
            </div>
          )}

          {snaps.length > 0 && (
            <section id="all" className="x-all">
              <div className="x-bar">
                <h2>All mandates</h2>
                <div className="x-chips" role="tablist" aria-label="Filter">
                  {(['all', 'live', 'mine', 'closed'] as Filter[]).map((f) => (
                    <button key={f} type="button" role="tab" aria-selected={filter === f} className="x-chip" onClick={() => setFilter(f)} disabled={f === 'mine' && !me} title={f === 'mine' && !me ? 'Connect a wallet' : undefined}>
                      {f === 'all' ? 'All' : f === 'live' ? 'Live' : f === 'mine' ? 'Mine' : 'Closed'}
                    </button>
                  ))}
                  {who && <button type="button" className="x-chip on" onClick={() => setWho('')}>{short(who)} ✕</button>}
                </div>
              </div>
              {shown.length ? <ul className="rows" aria-label="Mandates">{shown.map((s) => <Row key={s.id} s={s} />)}</ul> : <p className="empty">Nothing matches this filter.</p>}
            </section>
          )}
        </>
      )}
    </>
  );
}

function Activity({ l, s, t }: { l: LeashLog; s?: Snapshot; t?: number }) {
  const [tone, text] = s ? describe(l, s) : ['', l.eventName];
  const pair = s && pairOf(s);
  return (
    <li>
      <span className={`x-ico ${tone}`} aria-hidden>{(EVENT[l.eventName] ?? l.eventName)[0]}</span>
      <span className="x-main">
        <span><b>{EVENT[l.eventName] ?? l.eventName}</b> <TxLink hash={l.transactionHash} /></span>
        <small>{text}</small>
      </span>
      <span className="x-side">
        {s && pair && <a className="x-badge" href={`#/m/${s.id}`}>{pair.token.symbol}/{pair.stable.symbol}</a>}
        <small className="quiet">{t && s ? ago(s.now - t) : `block ${String(l.blockNumber)}`}</small>
      </span>
    </li>
  );
}

function Row({ s }: { s: Snapshot }) {
  const now = useClock() / 1000;
  const t = s.m.terms;
  const { token, stable } = pairOf(s);
  const tNow = chainNow(s, now * 1000);
  const live = s.status === 'active' || s.status === 'auction';
  return (
    <li>
      <a className="row" href={`#/m/${s.id}`}>
        <span className="row-pair">
          <b>{token.symbol} <i>/</i> {stable.symbol}</b>
          <small className="mono">{short(s.id)} · spacing {s.key.tickSpacing}</small>
        </span>
        <span className={`pill ${s.status}`}>{STATUS[s.status]}</span>
        <span className="row-cell"><small>Bond</small><b className="violet">{s.m.manager === zeroAddress ? '—' : `${fmt(s.m.bond, stable.decimals)} ${stable.symbol}`}</b></span>
        <span className="row-cell">
          <small>{s.status === 'auction' ? 'Bidding closes' : 'Epoch'}</small>
          <b>{s.status === 'auction' ? `in ${dur(t.auctionEnd - tNow)}` : s.status === 'active' ? `${s.epoch + 1} of ${t.epochs}` : `${s.m.settled} of ${t.epochs} settled`}</b>
        </span>
        <span className="row-dots" aria-label="Compliance now">
          <Dot ok={live ? s.comp.inRange : null} label="TWAP in range" live={live} />
          <Dot ok={live ? s.comp.deep : null} label="Depth at floor" live={live} />
          <Dot ok={live ? s.comp.onPace : null} label="On the glide path" live={live} />
        </span>
        <span className="row-cell end"><small>Ends</small><b>{s.status === 'closed' ? 'closed' : endOf(t) > tNow ? `in ${dur(endOf(t) - tNow)}` : 'ended'}</b></span>
      </a>
    </li>
  );
}
