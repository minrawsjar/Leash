// Manager leaderboard: every address that ever bid, ranked from the hook's events (Bid, EpochSettled) and the
// records read. Pay and slashes come from EpochSettled; clean and breached counts from records.
import { useMemo, useState } from 'react';
import { zeroAddress, type Address } from 'viem';
import { fmtNum, leashLogs, mandatesFrom, pct, priceAt, short, snapshot, trackRecord, type Snapshot } from './chain.ts';
import { useApp, usePoll } from './ui.tsx';

type Row = {
  who: Address; bids: number; won: number; active: number; leading: number; clean: number; breached: number;
  pay: Map<string, number>; slashed: Map<string, number>; payValue: number;
};
const add = (m: Map<string, number>, k: string, v: number) => { if (v) m.set(k, (m.get(k) ?? 0) + v); };
const sums = (m: Map<string, number>) => (m.size ? [...m].map(([k, v]) => `${fmtNum(v, 4)} ${k}`).join(' + ') : '0');

export function Managers({ refresh }: { refresh: number }) {
  const { net, wallet } = useApp();
  const { data, err } = usePoll(async () => {
    const logs = await leashLogs(net);
    const snaps = await Promise.all(mandatesFrom(logs).map((x) => snapshot(net, x.id, x.key)));
    const who = [...new Set(logs.filter((l) => l.eventName === 'Bid').map((l) => (l.args.bidder as Address).toLowerCase()))] as Address[];
    const recs = await Promise.all(who.map((a) => trackRecord(net, a)));
    return { logs, snaps, who, recs };
  }, net.logsApi ? 20_000 : 5_000, [net.id, refresh]);
  const [sort, setSort] = useState<'rate' | 'pay'>('rate');

  const rows = useMemo(() => {
    if (!data) return [];
    const byId = new Map<string, Snapshot>(data.snaps.map((s) => [s.id.toLowerCase(), s]));
    const out = new Map<string, Row>(data.who.map((a, i) => [a, {
      who: a, bids: 0, won: 0, active: 0, leading: 0, clean: data.recs[i].clean, breached: data.recs[i].breached,
      pay: new Map(), slashed: new Map(), payValue: 0,
    }]));
    for (const l of data.logs) {
      const s = byId.get(String(l.args.id).toLowerCase());
      if (!s) continue;
      if (l.eventName === 'Bid') out.get((l.args.bidder as string).toLowerCase())!.bids++;
      if (l.eventName === 'EpochSettled') { // the manager of a mandate never changes after its auction
        const r = out.get(s.m.manager.toLowerCase());
        if (!r) continue;
        const t = s.m.terms, [p0, p1] = [l.args.pay0 as bigint, l.args.pay1 as bigint];
        const v0 = Number(p0) / 10 ** s.tok[0].decimals, v1 = Number(p1) / 10 ** s.tok[1].decimals;
        add(r.pay, s.tok[0].symbol, v0); add(r.pay, s.tok[1].symbol, v1);
        const price = priceAt(s.twap, s.key, t, s.tok); // stable per token, at today's TWAP
        r.payValue += t.stableIs0 ? v0 + v1 * price : v0 * price + v1;
        const stable = s.tok[t.stableIs0 ? 0 : 1];
        add(r.slashed, stable.symbol, Number(l.args.slashed as bigint) / 10 ** stable.decimals);
      }
    }
    for (const s of data.snaps) {
      const r = s.m.manager !== zeroAddress && out.get(s.m.manager.toLowerCase());
      if (!r) continue;
      if (s.status === 'auction') r.leading++; else r.won++;
      if (s.status === 'active') r.active++;
    }
    const rate = (r: Row) => (r.clean + r.breached ? r.clean / (r.clean + r.breached) : -1);
    return [...out.values()].sort((a, b) => sort === 'pay'
      ? b.payValue - a.payValue || rate(b) - rate(a)
      : rate(b) - rate(a) || b.clean - a.clean || b.payValue - a.payValue);
  }, [data, sort]);

  const me = wallet.account?.toLowerCase();
  return (
    <>
      <section className="head">
        <p className="eyebrow">{net.name} · managers</p>
        <h1>Managers</h1>
        <p className="lede">Every address that has bid for a mandate, with its record across this hook. A clean epoch pays the manager its share of the fees; a breached one slashes the bond to the treasury.</p>
      </section>

      {err && <p className="banner" role="alert">Can't read the chain: {err}</p>}
      {!data && !err && <p className="empty">Reading bids and settlements from the hook…</p>}
      {data && !rows.length && (
        <div className="empty card">
          <p>No manager has bid on {net.name} yet.</p>
          <p className="quiet">To become one, open a mandate in auction and bid a bond in its stablecoin, at least the minimum and more than the leader. The highest bid when the auction ends is hired, runs the liquidity within the rules, and is paid per clean epoch.</p>
          <a className="btn primary" href="#/">Find a mandate in auction</a>
        </div>
      )}

      {rows.length > 0 && (
        <section className="lb" aria-label="Leaderboard">
          <div className="x-bar">
            <h2>{rows.length} manager{rows.length > 1 ? 's' : ''}</h2>
            <div className="x-chips" role="tablist" aria-label="Sort by">
              <button type="button" role="tab" aria-selected={sort === 'rate'} className="x-chip" onClick={() => setSort('rate')}>Clean rate</button>
              <button type="button" role="tab" aria-selected={sort === 'pay'} className="x-chip" onClick={() => setSort('pay')}>Pay earned</button>
            </div>
          </div>
          <div className="lb-scroll">
            <table className="lb-t">
              <thead>
                <tr><th>#</th><th>Manager</th><th>Won</th><th>Clean</th><th>Breached</th><th>Clean rate</th><th>Pay earned</th><th>Slashed</th><th>Active now</th></tr>
              </thead>
              <tbody>
                {rows.map((r, i) => {
                  const n = r.clean + r.breached;
                  return (
                    <tr key={r.who}>
                      <td className="lb-n">{i + 1}</td>
                      <td><a className="mono violet" href={`#/?who=${r.who}`} title="Their mandates in the explorer">{short(r.who)}</a>{r.who === me && <small> you</small>}</td>
                      <td data-k="Won">{r.won}{r.leading > 0 && <small> +{r.leading} leading</small>}</td>
                      <td data-k="Clean" className="mint">{r.clean}</td>
                      <td data-k="Breached" className={r.breached ? 'rose' : undefined}>{r.breached}</td>
                      <td data-k="Clean rate"><b>{n ? pct((r.clean * 10_000) / n, 0) : '–'}</b>{n > 0 && <span className="lb-bar" aria-hidden><i style={{ width: `${(r.clean / n) * 100}%` }} /></span>}</td>
                      <td data-k="Pay earned" className="mono">{sums(r.pay)}</td>
                      <td data-k="Slashed" className={`mono ${r.slashed.size ? 'rose' : ''}`}>{sums(r.slashed)}</td>
                      <td data-k="Active now">{r.active ? <span className="pill active">{r.active} active</span> : <span className="quiet">–</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="quiet small">Clean and breached are the hook's own records per address. Pay and slashes are summed from EpochSettled events, per token. Sorting by pay values each payment at its pool's current TWAP. Bids made: {rows.reduce((a, r) => a + r.bids, 0)}.</p>
        </section>
      )}
    </>
  );
}
