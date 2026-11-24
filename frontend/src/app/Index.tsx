// Every mandate the hook holds, from its MandateCreated logs, with live state.
import { zeroAddress } from 'viem';
import { chainNow, dur, endOf, fmt, leashLogs, mandatesFrom, short, snapshot, stableOf, type Snapshot } from './chain.ts';
import { Dot, useApp, useClock, usePoll } from './ui.tsx';

export const STATUS: Record<string, string> = {
  auction: 'Auction', active: 'Active', unhired: 'No bids', ended: 'Ended · to close', breached: 'Breached', closed: 'Closed',
};

export function Index({ refresh }: { refresh: number }) {
  const { net } = useApp();
  const { data, err } = usePoll(async () => {
    const list = mandatesFrom(await leashLogs(net));
    return Promise.all(list.map((x) => snapshot(net, x.id, x.key))).then((s) => s.reverse());
  }, net.logsApi ? 20_000 : 5_000, [net.id, refresh]);

  return (
    <>
      <section className="head">
        <p className="eyebrow">{net.name}</p>
        <h1>Mandates</h1>
        <p className="lede">Each one is a treasury's inventory held by the hook, a set of rules, and a bonded manager who can move the liquidity but never withdraw it.</p>
      </section>
      {err && <p className="banner" role="alert">Can't read the chain: {err}{net.id === 31337 ? ' Is ./scripts/local.sh running?' : ''}</p>}
      {!data && !err && <p className="empty">Reading mandates from the hook…</p>}
      {data && data.length === 0 && (
        <div className="empty card">
          <p>No mandates on {net.name} yet.</p>
          <a className="btn primary" href="#/create">Post the first mandate</a>
        </div>
      )}
      {data && data.length > 0 && <ul className="rows" aria-label="Mandates">{data.map((s) => <Row key={s.id} s={s} />)}</ul>}
    </>
  );
}

function Row({ s }: { s: Snapshot }) {
  const now = useClock() / 1000;
  const t = s.m.terms;
  const stable = s.tok[stableOf(s.key, t) === s.key.currency0 ? 0 : 1];
  const token = s.tok[t.stableIs0 ? 1 : 0];
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
