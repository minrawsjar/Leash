// One mandate: dashboard, auction, manager console, keeper actions.
import { useEffect, useMemo, useRef, useState } from 'react';
import { parseUnits, zeroAddress, type Address, type Hex } from 'viem';
import {
  ago, amountsAt, describe, blockTime, chainNow, client, dur, endOf, epochRecords, feePct, fmt, fmtLiq, fmtNum, fmtPrice, glideAt, GROW_BPS, leashLogs, MAX_GROW_GAP,
  mandatesFrom, maxTick, minTick, owed, pct, priceAt, short, slot0, snapshot, stableOf, trackRecord, leashAbi,
  type EpochRecord, type LeashLog, type Net, type Snapshot,
} from './chain.ts';
import * as act from './actions.ts';
import { Chart, type Sample } from './Chart.tsx';
import { STATUS } from './Index.tsx';
import { Act, Check, Dot, Stat, Ticker, TxLink, useApp, useClock, usePoll } from './ui.tsx';

const TABS = [['dashboard', 'Dashboard'], ['auction', 'Auction'], ['manage', 'Manager console'], ['settle', 'Settle & claim']] as const;

export function MandatePage({ id, tab, refresh }: { id: Hex; tab: string; refresh: number }) {
  const { net } = useApp();
  const logsQ = usePoll(() => leashLogs(net), net.logsApi ? 20_000 : 5_000, [net.id, refresh]);
  const entry = logsQ.data && mandatesFrom(logsQ.data).find((x) => x.id.toLowerCase() === id.toLowerCase());
  const snapQ = usePoll(() => (entry ? snapshot(net, entry.id, entry.key) : Promise.resolve(undefined)), net.rpcs ? 6_000 : 3_000, [entry?.id, refresh]);
  const s = snapQ.data;
  const recQ = usePoll(() => (s ? epochRecords(net, s.id, s.m.terms.epochs) : Promise.resolve([])), 6_000, [s?.id, s?.m.settled, refresh]);
  const logs = useMemo(() => (logsQ.data ?? []).filter((l) => String(l.args.id).toLowerCase() === id.toLowerCase()), [logsQ.data, id]);
  const samples = useSamples(net, s);

  if (logsQ.err) return <p className="banner" role="alert">Can't read the chain: {logsQ.err}</p>;
  if (logsQ.data && !entry) return <p className="empty card">No mandate with pool id <span className="mono">{short(id)}</span> on {net.name}.</p>;
  if (!s) return <p className="empty">{snapQ.err || 'Reading the mandate…'}</p>;

  const token = s.tok[s.m.terms.stableIs0 ? 1 : 0], stable = s.tok[s.m.terms.stableIs0 ? 0 : 1];
  return (
    <>
      <section className="head mhead">
        <p className="eyebrow"><a href="#/">Mandates</a> / <span className="mono">{short(s.id)}</span></p>
        <h1>{token.symbol} <i>/</i> {stable.symbol}</h1>
        <div className="mmeta">
          <span className={`pill ${s.status}`}>{STATUS[s.status]}</span>
          <span>Treasury <Addr a={s.m.treasury} /></span>
          <span>Manager {s.m.manager === zeroAddress ? <em>none yet</em> : <Addr a={s.m.manager} tone="violet" />}</span>
        </div>
      </section>
      <nav className="tabs" aria-label="Mandate sections">
        {TABS.map(([k, label]) => <a key={k} href={`#/m/${s.id}/${k}`} aria-current={tab === k ? 'page' : undefined}>{label}</a>)}
      </nav>
      {snapQ.err && <p className="banner" role="alert">Last refresh failed: {snapQ.err}</p>}
      {tab === 'auction' ? <Auction s={s} logs={logs} />
        : tab === 'manage' ? <Manage s={s} />
        : tab === 'settle' ? <Settle s={s} records={recQ.data ?? []} />
        : <Dashboard s={s} samples={samples} records={recQ.data ?? []} logs={logs} />}
    </>
  );
}

function Addr({ a, tone }: { a: Address; tone?: string }) {
  const { net, wallet } = useApp();
  const me = wallet.account?.toLowerCase() === a.toLowerCase();
  const inner = <span className={`mono ${tone ?? ''}`}>{short(a)}{me ? ' (you)' : ''}</span>;
  return net.explorer ? <a href={`${net.explorer}/address/${a}`} target="_blank" rel="noreferrer">{inner}</a> : inner;
}

/** Spot/TWAP history: backfilled from past blocks once, then one sample per new block. */
function useSamples(net: Net, s: Snapshot | undefined): Sample[] {
  const [list, setList] = useState<Sample[]>([]);
  const filled = useRef('');
  useEffect(() => {
    if (!s) return;
    const cur: Sample = { t: s.now, spot: s.spot, twap: s.twap, lo: s.m.tickLower, hi: s.m.tickUpper };
    setList((l) => (l.length && l[l.length - 1].t >= cur.t ? l.map((x, i) => (i === l.length - 1 ? cur : x)) : [...l, cur].slice(-400)));
    if (filled.current === s.id) return;
    filled.current = s.id;
    backfill(net, s).then((past) => setList((l) => [...past.filter((p) => !l.length || p.t < l[0].t), ...l]), () => {});
  }, [s?.block, s?.id]);
  return list;
}

async function backfill(net: Net, s: Snapshot): Promise<Sample[]> {
  const c = client(net), n = 40;
  const created = BigInt(net.dep.block);
  const span = s.block - created;
  if (span < 2n) return [];
  const step = span > BigInt(n * 30) ? 30n : span / BigInt(n) || 1n; // ~the last 20 minutes on 1s blocks
  const blocks = Array.from({ length: n }, (_, i) => s.block - step * BigInt(n - i)).filter((b) => b > created);
  const rows = await Promise.all(blocks.map(async (blockNumber) => {
    try {
      const [b, s0, twap, m] = await Promise.all([
        c.getBlock({ blockNumber }), slot0(net, s.id, blockNumber).then((x) => x.tick),
        c.readContract({ address: net.dep.leash, abi: leashAbi, functionName: 'twapTick', args: [s.key], blockNumber }) as Promise<number>,
        c.readContract({ address: net.dep.leash, abi: leashAbi, functionName: 'mandate', args: [s.id], blockNumber }) as Promise<Snapshot['m']>,
      ]);
      if (m.treasury === zeroAddress) return null;
      return { t: Number(b.timestamp), spot: s0, twap: Number(twap), lo: m.tickLower, hi: m.tickUpper };
    } catch { return null; }
  }));
  const out: Sample[] = [];
  for (const r of rows) if (r && (!out.length || r.t > out[out.length - 1].t)) out.push(r);
  return out;
}

// ---------------------------------------------------------------- dashboard
function Dashboard({ s, samples, records, logs }: { s: Snapshot; samples: Sample[]; records: EpochRecord[]; logs: LeashLog[] }) {
  const t = s.m.terms;
  const [token, stable] = s.m.terms.stableIs0 ? [s.tok[1], s.tok[0]] : [s.tok[0], s.tok[1]];
  const price = (tick: number) => priceAt(tick, s.key, t, s.tok);
  const now = chainNow(s, useClock());
  const live = s.status === 'active' || s.status === 'auction';
  const cap = glideAt(t, now);
  const ledger = inventory(s);
  const p = price(s.twap);
  return (
    <div className="grid">
      <section className="stats span" aria-label="Now">
        <Stat label={`Spot · ${stable.symbol} per ${token.symbol}`}><Ticker value={spotPrice(s)} format={fmtPrice} /></Stat>
        <Stat label={`TWAP · ${t.twapWindow}s window`} tone="mint"><Ticker value={p} format={fmtPrice} /></Stat>
        <Stat label="Bond at stake" tone="violet"><Ticker value={Number(s.m.bond) / 10 ** stable.decimals} format={(v) => fmtNum(v)} /> <small>{stable.symbol}</small></Stat>
        <Stat label="Swap fee">{feePct(s.lpFee)} <small>of {feePct(t.minFee)}–{feePct(t.maxFee)}</small></Stat>
        <Stat label={s.status === 'auction' ? 'Bidding closes in' : s.status === 'active' ? `Epoch ${s.epoch + 1} of ${t.epochs} ends in` : 'Epochs settled'}>
          {s.status === 'auction' ? dur(t.auctionEnd - now) : s.status === 'active' ? dur(t.auctionEnd + (s.epoch + 1) * t.epochLength - now) : `${s.m.settled} / ${t.epochs}`}
        </Stat>
      </section>

      <section className="card span">
        <div className="card-head"><h2>Price, TWAP and range</h2><span className="quiet"><Dot ok live label="live" /> block {String(s.block)}</span></div>
        <Chart samples={samples} price={price} needLo={s.twap - t.minHalfWidth} needHi={s.twap + t.minHalfWidth} unit={`${stable.symbol} per ${token.symbol}`} />
      </section>

      <section className="card">
        <div className="card-head"><h2>Compliance now</h2><span className="quiet">{live ? 'as the next checkpoint judges it' : 'mandate not live'}</span></div>
        <ul className="checks">
          <Check ok={s.comp.inRange}>TWAP tick <b className="mono">{s.twap}</b> {s.comp.inRange ? 'inside' : 'outside'} range <b className="mono">[{s.m.tickLower}, {s.m.tickUpper})</b></Check>
          <Check ok={s.comp.deep}>Liquidity {fmtNum(Number(s.m.liquidity) / Number(t.minLiquidity || 1n), 2)}× the depth floor</Check>
          <Check ok={s.comp.onPace}>Stable share {pct(s.comp.stableBps)} vs glide cap {pct(cap)}</Check>
          <Check ok={s.lpFee >= t.minFee && s.lpFee <= t.maxFee}>Fee {feePct(s.lpFee)} inside {feePct(t.minFee)}–{feePct(t.maxFee)}</Check>
        </ul>
        <div className="glide" aria-hidden>
          <span className="glide-fill" style={{ width: `${s.comp.stableBps / 100}%` }} />
          <span className="glide-cap" style={{ left: `${cap / 100}%` }} />
        </div>
        <p className="quiet small">Glide path {pct(t.startStableBps, 0)} → {pct(t.endStableBps, 0)} stable over the mandate. {s.m.lastCheck ? `Compliance booked up to ${new Date(s.m.lastCheck * 1000).toLocaleTimeString()}; the last check was ${s.m.lastOk ? 'compliant' : 'out of compliance'}.` : 'No compliance booked yet: the first checkpoint after the auction starts the clock.'}</p>
      </section>

      <section className="card">
        <div className="card-head"><h2>Ledger</h2><span className="quiet">valued at the TWAP</span></div>
        <dl className="ledger">
          <Row k="Idle (outside the pool)" v={`${fmt(s.m.terms.stableIs0 ? s.m.idle1 : s.m.idle0, token.decimals)} ${token.symbol} · ${fmt(s.m.terms.stableIs0 ? s.m.idle0 : s.m.idle1, stable.decimals)} ${stable.symbol}`} />
          <Row k="Managed position" v={`${fmtNum(ledger.pos[0] / 10 ** token.decimals)} ${token.symbol} · ${fmtNum(ledger.pos[1] / 10 ** stable.decimals)} ${stable.symbol}`} />
          <Row k="Anchor (full range, fixed)" v={`${fmtNum(ledger.anc[0] / 10 ** token.decimals)} ${token.symbol} · ${fmtNum(ledger.anc[1] / 10 ** stable.decimals)} ${stable.symbol}`} />
          <Row k="Fees collected, unsettled" v={`${fmt(s.m.terms.stableIs0 ? s.m.fees1 : s.m.fees0, token.decimals, 4)} ${token.symbol} · ${fmt(s.m.terms.stableIs0 ? s.m.fees0 : s.m.fees1, stable.decimals, 4)} ${stable.symbol}`} />
          <Row k="Liquidity · floor" v={<span className="mono">{fmtLiq(s.m.liquidity)} · {fmtLiq(t.minLiquidity)}</span>} />
          <Row k="Inventory value" v={<b><Ticker value={ledger.value} format={(v) => fmtNum(v)} /> {stable.symbol}</b>} />
        </dl>
      </section>

      <section className="card span">
        <div className="card-head"><h2>Epochs</h2><span className="quiet">{t.epochs} × {dur(t.epochLength)} · clean needs {pct(t.uptimeBps, 0)} uptime · manager earns {pct(t.managerFeeBps, 0)} of fees</span></div>
        <Timeline s={s} records={records} now={now} />
      </section>

      <section className="card">
        <div className="card-head"><h2>Activity</h2><span className="quiet">{logs.length} events</span></div>
        <Feed s={s} logs={logs} />
      </section>

      <section className="card">
        <div className="card-head"><h2>Terms</h2><span className="quiet">fixed at creation</span></div>
        <TermsList s={s} />
      </section>
    </div>
  );
}

/** Spot from sqrtPriceX96 (exact), not the tick (floored, up to 1bp low). */
function spotPrice(s: Snapshot) {
  const r = (Number(s.sqrtPriceX96) / 2 ** 96) ** 2 * 10 ** (s.tok[0].decimals - s.tok[1].decimals);
  return s.m.terms.stableIs0 ? 1 / r : r;
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return <div className="lrow"><dt>{k}</dt><dd>{v}</dd></div>;
}

/** Token amounts as [token, stable] raw, and total value in stable (human), at the TWAP. */
function inventory(s: Snapshot) {
  const t = s.m.terms, swap = (x: [number, number]): [number, number] => (t.stableIs0 ? [x[1], x[0]] : x);
  const pos = swap(amountsAt(s.twap, s.m.tickLower, s.m.tickUpper, s.m.liquidity));
  const anc = s.m.closed ? [0, 0] as [number, number] : swap(amountsAt(s.twap, minTick(s.key.tickSpacing), maxTick(s.key.tickSpacing), t.anchorLiquidity));
  const [tokD, stD] = t.stableIs0 ? [s.tok[1].decimals, s.tok[0].decimals] : [s.tok[0].decimals, s.tok[1].decimals];
  const idle = swap([Number(s.m.idle0), Number(s.m.idle1)]);
  const p = priceAt(s.twap, s.key, t, s.tok);
  const value = ((pos[0] + anc[0] + idle[0]) / 10 ** tokD) * p + (pos[1] + anc[1] + idle[1]) / 10 ** stD;
  return { pos, anc, value };
}

function Timeline({ s, records, now }: { s: Snapshot; records: EpochRecord[]; now: number }) {
  const t = s.m.terms;
  const stable = s.tok[t.stableIs0 ? 0 : 1];
  const token = s.tok[t.stableIs0 ? 1 : 0];
  return (
    <ol className="epochs">
      {Array.from({ length: t.epochs }, (_, e) => {
        const r = records[e];
        const start = t.auctionEnd + e * t.epochLength, end = start + t.epochLength;
        const state = r?.settled ? (r.clean ? 'clean' : 'breached') : now >= end ? 'due' : now >= start && s.status === 'active' ? 'now' : 'later';
        const total = r ? r.inSecs + r.outSecs : 0;
        const up = total ? (r!.inSecs * 10_000) / total : 0;
        const f = r ? [t.stableIs0 ? r.fees1 : r.fees0, t.stableIs0 ? r.fees0 : r.fees1] : [0n, 0n];
        return (
          <li key={e} className={`ep ${state}`}>
            <span className="ep-n">E{e + 1}</span>
            <span className="ep-bar" aria-label={`${r?.inSecs ?? 0}s in, ${r?.outSecs ?? 0}s out of compliance`}>
              <i className="in" style={{ width: `${total ? (r!.inSecs / t.epochLength) * 100 : 0}%` }} />
              <i className="out" style={{ width: `${total ? (r!.outSecs / t.epochLength) * 100 : 0}%` }} />
              <i className="cut" style={{ left: `${t.uptimeBps / 100}%` }} />
            </span>
            <span className="ep-txt">
              <b>{state === 'clean' ? 'Clean' : state === 'breached' ? 'Breached' : state === 'due' ? 'Ended · settle' : state === 'now' ? 'In progress' : 'Upcoming'}</b>
              <small>{total ? `${dur(r!.inSecs)} in · ${dur(r!.outSecs)} out · ${pct(up, 1)} up` : new Date(start * 1000).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</small>
              {(f[0] > 0n || f[1] > 0n) && <small>fees {fmt(f[0], token.decimals, 4)} {token.symbol} · {fmt(f[1], stable.decimals, 4)} {stable.symbol}</small>}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function Feed({ s, logs }: { s: Snapshot; logs: LeashLog[] }) {
  const { net } = useApp();
  const shown = [...logs].reverse().slice(0, 30);
  const times = usePoll(() => Promise.all(shown.map((l) => blockTime(net, l.blockNumber))), 15_000, [shown.length, String(shown[0]?.blockNumber)]);
  if (!logs.length) return <p className="quiet">No events yet.</p>;
  return (
    <ol className="feed">
      {shown.map((l, i) => { const [tone, text] = describe(l, s); return (
        <li key={`${l.transactionHash}-${l.logIndex}`}><i className={`fdot ${tone}`} /><span>{text}</span><small>{times.data ? `${ago(s.now - times.data[i])} · ` : ''}block {String(l.blockNumber)} · <TxLink hash={l.transactionHash} /></small></li>
      ); })}
    </ol>
  );
}

function TermsList({ s }: { s: Snapshot }) {
  const t = s.m.terms, stable = s.tok[t.stableIs0 ? 0 : 1];
  const rows: [string, string][] = [
    ['Stablecoin', `${stable.symbol} (currency${t.stableIs0 ? 0 : 1})`],
    ['Auction ends', new Date(t.auctionEnd * 1000).toLocaleString()],
    ['Epochs', `${t.epochs} × ${dur(t.epochLength)}`],
    ['Min bond', `${fmt(t.minBond, stable.decimals)} ${stable.symbol}`],
    ['Fee band', `${feePct(t.minFee)} – ${feePct(t.maxFee)}`],
    ['TWAP window', dur(t.twapWindow)],
    ['Max spot–TWAP gap to rebalance', `${t.maxTickDeviation} ticks (~${(t.maxTickDeviation / 100).toFixed(1)}%)`],
    ['Min half-width', `${t.minHalfWidth} ticks (~${(t.minHalfWidth / 100).toFixed(1)}%)`],
    ['Depth floor', fmtLiq(t.minLiquidity)],
    ['Uptime to be clean', pct(t.uptimeBps, 0)],
    ['Manager fee share', pct(t.managerFeeBps, 0)],
    ['Stable share cap', `${pct(t.startStableBps, 0)} → ${pct(t.endStableBps, 0)}`],
    ['Anchor liquidity', fmtLiq(t.anchorLiquidity)],
  ];
  return <dl className="ledger">{rows.map(([k, v]) => <Row key={k} k={k} v={v} />)}</dl>;
}

// ---------------------------------------------------------------- auction
function Auction({ s, logs }: { s: Snapshot; logs: LeashLog[] }) {
  const { net, wallet } = useApp();
  const t = s.m.terms, stableAddr = stableOf(s.key, t), stable = s.tok[t.stableIs0 ? 0 : 1];
  const now = chainNow(s, useClock());
  const open = s.status === 'auction';
  const floor = s.m.bond >= t.minBond ? s.m.bond + 1n : t.minBond;
  const [amt, setAmt] = useState('');
  const bids = logs.filter((l) => l.eventName === 'Bid');
  const bidders = [...new Set(bids.map((b) => b.args.bidder as Address))];
  const owedQ = usePoll(() => Promise.all(bidders.map((b) => owed(net, b, stableAddr))), 6_000, [bidders.join(), s.block]);
  const mine = usePoll(() => (wallet.account ? owed(net, wallet.account, stableAddr) : Promise.resolve(0n)), 6_000, [wallet.account, s.block]);
  let parsed: bigint | null = null;
  try { parsed = amt ? parseUnits(amt, stable.decimals) : null; } catch { parsed = null; }
  const problem = !open ? (s.m.manager === zeroAddress ? 'The auction ended with no bids. The treasury can close the mandate.' : 'Bidding has closed.')
    : parsed === null ? `Enter a bond of at least ${fmt(floor, stable.decimals)} ${stable.symbol}.`
    : parsed < floor ? (s.m.bond ? `Too low: the bond must be more than the leader's ${fmt(s.m.bond, stable.decimals, 6)} ${stable.symbol}.` : `Too low: the minimum bond is ${fmt(floor, stable.decimals)} ${stable.symbol}.`) : '';
  const recQ = usePoll(() => (s.m.manager !== zeroAddress ? trackRecord(net, s.m.manager) : Promise.resolve(null)), 10_000, [s.m.manager]);

  return (
    <div className="grid">
      <section className="card hero-card">
        <p className="eyebrow">{open ? 'Leading bond' : s.m.manager === zeroAddress ? 'No winner' : 'Winning bond'}</p>
        <p className="big violet"><Ticker value={Number(s.m.bond) / 10 ** stable.decimals} format={(v) => fmtNum(v)} /> <small>{stable.symbol}</small></p>
        <p className="quiet">{s.m.manager === zeroAddress ? 'Nobody has bid yet.' : <>by <Addr a={s.m.manager} tone="violet" />{recQ.data && ` · track record ${recQ.data.clean} clean, ${recQ.data.breached} breached`}</>}</p>
        <div className="count">
          <Stat label={open ? 'Bidding closes in' : 'Bidding closed'}>{open ? dur(t.auctionEnd - now) : new Date(t.auctionEnd * 1000).toLocaleTimeString()}</Stat>
          <Stat label="Minimum bond">{fmt(t.minBond, stable.decimals)} {stable.symbol}</Stat>
          {open && <Stat label={s.m.bond ? 'Next bid must exceed' : 'Opening bid from'}>{fmt(s.m.bond || floor, stable.decimals)} {stable.symbol}</Stat>}
        </div>
      </section>

      {open ? (
        <section className="card">
          <div className="card-head"><h2>Bid</h2><span className="quiet">your bond is first-loss: slashed to the treasury on a breach</span></div>
          <label className="field">
            <span>Bond ({stable.symbol})</span>
            <input inputMode="decimal" placeholder={fmt(floor, stable.decimals).replace(/,/g, '')} value={amt} onChange={(e) => setAmt(e.target.value.trim())} aria-describedby="bid-why" />
          </label>
          <div className="row-btns">
            <button type="button" className="btn secondary sm" onClick={() => setAmt(String(s.m.bond ? Math.floor(Number(s.m.bond) / 10 ** stable.decimals) + 1 : Number(floor) / 10 ** stable.decimals))}>{s.m.bond ? 'Leader + 1' : 'Minimum'}</button>
            <button type="button" className="btn secondary sm" onClick={() => setAmt(String(Math.ceil((Number(floor) * 1.1) / 10 ** stable.decimals)))}>+10%</button>
          </div>
          <Act label="Approve and bid" kind="violet" disabled={!!problem} why={problem || 'Two signatures: the token approval (skipped if already enough), then the bid. An outbid bond becomes claimable at once.'}
            run={async () => act.bid(await wallet.ctx(net), s.key, stableAddr, parsed!)} />
          <p id="bid-why" className="quiet small">Winning gives the right to run the liquidity for {t.epochs} × {dur(t.epochLength)} and earn {pct(t.managerFeeBps, 0)} of each clean epoch's fees. It never gives custody.</p>
        </section>
      ) : (
        <section className="card">
          <div className="card-head"><h2>Result</h2><span className="quiet">bidding closed {new Date(t.auctionEnd * 1000).toLocaleString()}</span></div>
          <p className="quiet">{s.m.manager === zeroAddress
            ? 'Nobody bid. The treasury can close the mandate and take its inventory back (Settle & claim).'
            : s.m.breached ? 'The winner breached an epoch: the bond was slashed to the treasury and the manager fired.'
            : <>The winner runs the liquidity until {new Date(endOf(t) * 1000).toLocaleString()}. Their bond stays locked until the last clean epoch settles, or goes to the treasury on a breach.</>}</p>
          {s.m.manager !== zeroAddress && !s.m.breached && <a className="btn secondary sm" href={`#/m/${s.id}/manage`}>Open the manager console</a>}
        </section>
      )}

      <section className="card span">
        <div className="card-head"><h2>Bids</h2><span className="quiet">an outbid bond is refunded at once, as a claimable balance</span></div>
        {!bids.length ? <p className="quiet">No bids yet.</p> : (
          <ol className="feed">
            {[...bids].reverse().map((b, i) => (
              <li key={`${b.transactionHash}-${b.logIndex}`}>
                <i className={`fdot ${i === 0 ? 'violet' : ''}`} />
                <span><Addr a={b.args.bidder as Address} tone={i === 0 ? 'violet' : ''} /> · {fmt(b.args.amount as bigint, stable.decimals)} {stable.symbol} {i === 0 ? <b className="violet">{open ? 'leading' : 'won'}</b> : <em>outbid · refunded</em>}</span>
                <small>block {String(b.blockNumber)} · <TxLink hash={b.transactionHash} /></small>
              </li>
            ))}
          </ol>
        )}
        {bidders.some((_, i) => (owedQ.data?.[i] ?? 0n) > 0n) && (
          <dl className="ledger">
            {bidders.map((b, i) => (owedQ.data?.[i] ?? 0n) > 0n && <Row key={b} k={`${short(b)} can claim`} v={`${fmt(owedQ.data![i], stable.decimals)} ${stable.symbol}`} />)}
          </dl>
        )}
        <p className="quiet small">Claimable balances are per account across every mandate on this hook, and include refunds, returned bonds and pay; each account withdraws its own with claim.</p>
        {wallet.account && (mine.data ?? 0n) > 0n && (
          <div className="claim-box">
            <p>You have <b>{fmt(mine.data!, stable.decimals)} {stable.symbol}</b> claimable.</p>
            <Act label="Claim" kind="secondary" run={async () => act.claim(await wallet.ctx(net), stableAddr)} />
          </div>
        )}
      </section>
    </div>
  );
}

// ---------------------------------------------------------------- manager console
function Manage({ s }: { s: Snapshot }) {
  const { net, wallet } = useApp();
  const t = s.m.terms, ts = s.key.tickSpacing;
  const now = chainNow(s, useClock());
  const [token, stable] = t.stableIs0 ? [s.tok[1], s.tok[0]] : [s.tok[0], s.tok[1]];
  const price = (tick: number) => priceAt(tick, s.key, t, s.tok);
  const isManager = !!wallet.account && wallet.account.toLowerCase() === s.m.manager.toLowerCase();
  const curHalf = Math.max(t.minHalfWidth, Math.round((s.m.tickUpper - s.m.tickLower) / 2));
  const [half, setHalf] = useState(curHalf);
  const [edit, setEdit] = useState<{ lo: number; hi: number } | null>(null);
  const centred = { lo: Math.floor((s.twap - half) / ts) * ts, hi: Math.ceil((s.twap + half) / ts) * ts };
  const { lo, hi } = edit ?? centred;
  // Size as % of the current position; presets pin an exact value so Floor and +5% land on the contract's bounds.
  const [size, setSize] = useState<{ pct: string; exact: bigint | null }>({ pct: '100', exact: null });
  const bp = Math.round(Number(size.pct) * 100);
  const liq = size.exact ?? (isFinite(bp) && bp > 0 ? (s.m.liquidity * BigInt(bp)) / 10_000n : 0n);
  const asPct = (x: bigint) => (s.m.liquidity ? (Number((x * 1_000_000n) / s.m.liquidity) / 10_000).toString() : '0');
  const growCap = (s.m.liquidity * BigInt(10_000 + GROW_BPS)) / 10_000n;

  const gap = Math.abs(s.spot - s.twap), grow = liq > s.m.liquidity;
  const growWait = s.m.lastGrow + t.twapWindow - now;
  // Will the mandate's own inventory cover the new position? (float estimate; the simulation is exact)
  const swapT = (x: [number, number]) => (t.stableIs0 ? [x[1], x[0]] : x);
  const have = swapT(amountsAt(s.spot, s.m.tickLower, s.m.tickUpper, s.m.liquidity)).map((v, i) => v + Number(i === 0 ? (t.stableIs0 ? s.m.idle1 : s.m.idle0) : (t.stableIs0 ? s.m.idle0 : s.m.idle1)));
  const need = lo < hi ? swapT(amountsAt(s.spot, lo, hi, liq > 0n ? liq : 0n)) : [0, 0];
  const fits = need[0] <= have[0] && need[1] <= have[1];
  const checks: [boolean, string][] = [
    [s.status === 'active', s.status === 'active' ? 'Mandate is active' : `Mandate is not active (${STATUS[s.status].toLowerCase()})`],
    [isManager, isManager ? 'Connected as the manager' : `Only the manager ${short(s.m.manager)} can sign this`],
    [gap <= t.maxTickDeviation, `Spot is ${gap} tick${gap === 1 ? '' : 's'} from the TWAP (limit ${t.maxTickDeviation})`],
    [lo % ts === 0 && hi % ts === 0 && lo < hi, `Ticks on the ${ts}-tick grid, lower below upper`],
    [lo <= s.twap - t.minHalfWidth && hi >= s.twap + t.minHalfWidth, `Covers TWAP ± ${t.minHalfWidth} ticks (${s.twap - t.minHalfWidth} … ${s.twap + t.minHalfWidth})`],
    [lo < s.spot && s.spot < hi, `Spot tick ${s.spot} strictly inside`],
    [liq >= t.minLiquidity, `Liquidity at or above the floor (${fmtLiq(t.minLiquidity)})`],
    [fits, fits ? 'Fits the mandate\'s own inventory' : `Needs ${fmtNum(need[0] / 10 ** token.decimals)} ${token.symbol} + ${fmtNum(need[1] / 10 ** stable.decimals)} ${stable.symbol}; the mandate holds ${fmtNum(have[0] / 10 ** token.decimals)} + ${fmtNum(have[1] / 10 ** stable.decimals)}`],
  ];
  if (grow) checks.push(
    [gap <= MAX_GROW_GAP, `Growing needs spot within ${MAX_GROW_GAP} ticks of the TWAP (now ${gap})`],
    [liq <= growCap, `Growth at most +5% per step (max ${fmtLiq(growCap)})`],
    [growWait <= 0, growWait <= 0 ? 'A TWAP window has passed since the last growth' : `Next growth allowed in ${dur(growWait)}`],
  );
  const firstBad = checks.find(([ok]) => !ok);

  const [feeStr, setFeeStr] = useState((s.lpFee / 10_000).toString());
  const fee = Math.round(Number(feeStr) * 10_000);
  const feeBad = !feeStr || isNaN(fee) ? 'Enter a fee in percent.' : fee > t.maxFee ? `Above the cap of ${feePct(t.maxFee)}.` : fee < t.minFee ? `Below the floor of ${feePct(t.minFee)}.` : '';

  // the range picker's scale: twap ± 4 × the wider of the chosen and required half-widths
  const reach = Math.max(hi - s.twap, s.twap - lo, t.minHalfWidth, gap) * 1.4 + ts;
  const at = (tick: number) => `${Math.min(100, Math.max(0, ((tick - (s.twap - reach)) / (2 * reach)) * 100))}%`;
  const [pa, pb] = [price(lo), price(hi)].sort((x, y) => x - y);

  return (
    <div className="grid">
      {!isManager && <p className="banner span">{wallet.account ? `You are connected as ${short(wallet.account)}; this console signs only for the manager, ${s.m.manager === zeroAddress ? 'once someone wins the auction' : short(s.m.manager)}.` : 'Connect the manager\'s wallet to sign. The checks below are live either way.'}</p>}
      <section className="card span">
        <div className="card-head"><h2>Rebalance</h2><span className="quiet">move the treasury's liquidity · funds only ever go between the hook and the pool</span></div>
        <div className="picker" aria-hidden>
          <span className="pk-need" style={{ left: at(s.twap - t.minHalfWidth), width: `calc(${at(s.twap + t.minHalfWidth)} - ${at(s.twap - t.minHalfWidth)})` }} />
          <span className="pk-dev" style={{ left: at(s.twap - t.maxTickDeviation), width: `calc(${at(s.twap + t.maxTickDeviation)} - ${at(s.twap - t.maxTickDeviation)})` }} />
          <span className="pk-cur" style={{ left: at(s.m.tickLower), width: `calc(${at(s.m.tickUpper)} - ${at(s.m.tickLower)})` }} />
          <span className="pk-new" style={{ left: at(lo), width: `calc(${at(hi)} - ${at(lo)})` }} />
          <span className="pk-twap" style={{ left: at(s.twap) }}><em>TWAP</em></span>
          <span className="pk-spot" style={{ left: at(s.spot) }}><em>spot</em></span>
        </div>
        <ul className="legend"><li><i className="k-band" />New range {fmtPrice(pa)}–{fmtPrice(pb)} {stable.symbol}</li><li><i className="k-cur" />Current</li><li><i className="k-need" />Must cover</li><li><i className="k-dev" />Spot may sit here (max gap)</li></ul>
        <div className="form-grid">
          <label className="field wide">
            <span>Half-width around the TWAP: {half} ticks (~{(half / 100).toFixed(1)}%)</span>
            <input type="range" min={t.minHalfWidth} max={Math.max(t.minHalfWidth * 10, curHalf * 2)} step={ts} value={half} onChange={(e) => { setHalf(Number(e.target.value)); setEdit(null); }} />
          </label>
          <label className="field"><span>Lower tick</span><input type="number" step={ts} value={lo} onChange={(e) => setEdit({ lo: Number(e.target.value), hi })} /></label>
          <label className="field"><span>Upper tick</span><input type="number" step={ts} value={hi} onChange={(e) => setEdit({ lo, hi: Number(e.target.value) })} /></label>
          <label className="field wide">
            <span>Size, % of the current position (floor ≈ {Math.ceil(Number(asPct(t.minLiquidity)))}%, growth caps at 105%)</span>
            <input inputMode="decimal" value={size.pct} onChange={(e) => setSize({ pct: e.target.value.trim(), exact: null })} />
            <small className="mono">liquidity {liq.toString()} · {fmtLiq(liq)}</small>
          </label>
          <div className="row-btns wide">
            <button type="button" className="btn secondary sm" onClick={() => setSize({ pct: asPct(t.minLiquidity), exact: t.minLiquidity })}>Floor</button>
            <button type="button" className="btn secondary sm" onClick={() => setSize({ pct: '100', exact: s.m.liquidity })}>Keep size</button>
            <button type="button" className="btn secondary sm" onClick={() => setSize({ pct: asPct(growCap), exact: growCap })}>+5% (max growth)</button>
            <button type="button" className="btn secondary sm" onClick={() => setEdit(null)}>Centre on TWAP</button>
          </div>
        </div>
        <ul className="checks">{checks.map(([ok, text]) => <Check key={text} ok={ok}>{text}</Check>)}</ul>
        <Act label="Rebalance" disabled={!!firstBad} why={firstBad ? `Blocked: ${firstBad[1]}.` : 'One rebalance per block. Simulated first, so a refusal costs nothing.'}
          run={async () => act.rebalance(await wallet.ctx(net), s.key, lo, hi, liq)} />
      </section>

      <section className="card">
        <div className="card-head"><h2>Swap fee</h2><span className="quiet">now {feePct(s.lpFee)}</span></div>
        <label className="field">
          <span>Fee in percent ({feePct(t.minFee)} – {feePct(t.maxFee)})</span>
          <input inputMode="decimal" value={feeStr} onChange={(e) => setFeeStr(e.target.value.trim())} />
        </label>
        <input type="range" aria-label="Fee" min={t.minFee} max={t.maxFee} step={50} value={isNaN(fee) ? t.minFee : fee} onChange={(e) => setFeeStr(String(Number(e.target.value) / 10_000))} />
        <Act label="Set fee" disabled={!!feeBad || !isManager || s.status !== 'active'} why={feeBad || (!isManager ? 'Only the manager can set the fee.' : s.status !== 'active' ? 'Only while the mandate is active.' : `${fee} pips. Higher fees earn more per trade but invite less flow.`)}
          run={async () => act.setFee(await wallet.ctx(net), s.key, fee)} />
      </section>

      <section className="card">
        <div className="card-head"><h2>Limits</h2><span className="quiet">why a rebalance can be refused</span></div>
        <dl className="ledger">
          <Row k="Spot – TWAP gap" v={`${gap} of ${t.maxTickDeviation} ticks`} />
          <Row k="Last rebalance" v={s.m.lastRebalance ? `${dur(now - s.m.lastRebalance)} ago` : 'never'} />
          <Row k="Last growth" v={s.m.lastGrow ? `${dur(now - s.m.lastGrow)} ago` : 'never'} />
          <Row k="Growth step" v={`+5% once per ${dur(t.twapWindow)}`} />
          <Row k="Price moved this block?" v="growth refused if so (SameBlock)" />
        </dl>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------- keeper, settle, close, claim
function Settle({ s, records }: { s: Snapshot; records: EpochRecord[] }) {
  const { net, wallet } = useApp();
  const t = s.m.terms;
  const now = chainNow(s, useClock());
  const next = s.m.settled;
  const dueAt = t.auctionEnd + (next + 1) * t.epochLength;
  const hired = s.m.manager !== zeroAddress;
  const isTreasury = wallet.account?.toLowerCase() === s.m.treasury.toLowerCase();
  const closeAt = s.m.breached ? 0 : hired ? endOf(t) : t.auctionEnd;
  const settleWhy = s.m.closed ? 'Closed.' : !hired ? 'Nobody was hired, so there is nothing to settle.' : s.m.breached ? 'Breached: settlement stopped and the bond went to the treasury.'
    : next >= t.epochs ? 'Every epoch is settled.' : now < dueAt ? `Epoch ${next + 1} can settle in ${dur(dueAt - now)}.` : '';
  const closeWhy = s.m.closed ? 'Already closed.' : !isTreasury ? `Only the treasury (${short(s.m.treasury)}) can close.` : now < closeAt ? `Opens in ${dur(closeAt - now)}${hired ? ', when the last epoch ends' : ', when the auction ends with no bids'}.` : '';
  const [c0, c1] = [s.key.currency0, s.key.currency1];
  const mine = usePoll(async () => {
    if (!wallet.account) return null;
    const [o0, o1, r] = await Promise.all([owed(net, wallet.account, c0), owed(net, wallet.account, c1), trackRecord(net, wallet.account)]);
    return { o0, o1, r };
  }, 6_000, [wallet.account, s.block]);
  const mgr = usePoll(async () => (hired ? { r: await trackRecord(net, s.m.manager), o: [await owed(net, s.m.manager, c0), await owed(net, s.m.manager, c1)] } : null), 8_000, [s.m.manager, s.block]);
  const r = records[next];

  return (
    <div className="grid">
      <section className="card">
        <div className="card-head"><h2>Checkpoint</h2><span className="quiet">anyone · keepers call it every minute</span></div>
        <p className="quiet">Books the seconds since the last check as in or out of compliance. Each interval counts as in only if it was compliant at both ends. {s.m.lastCheck ? `Booked up to ${dur(now - s.m.lastCheck)} ago.` : 'Nothing booked yet.'}</p>
        <Act label="Checkpoint" kind="secondary" disabled={s.m.closed} why={s.m.closed ? 'Closed.' : ''} run={async () => act.checkpoint(await wallet.ctx(net), s.key)} />
      </section>

      <section className="card">
        <div className="card-head"><h2>Settle epoch {Math.min(next + 1, t.epochs)}</h2><span className="quiet">anyone · in order</span></div>
        {r && next < t.epochs && <p className="quiet">So far {dur(r.inSecs)} in, {dur(r.outSecs)} out: {r.inSecs + r.outSecs ? pct((r.inSecs * 10_000) / (r.inSecs + r.outSecs)) : '–'} uptime against {pct(t.uptimeBps, 0)} needed. Clean pays the manager {pct(t.managerFeeBps, 0)} of the epoch's fees; a miss slashes the whole bond to the treasury.</p>}
        <Act label={`Settle epoch ${next + 1}`} disabled={!!settleWhy} why={settleWhy} run={async () => act.settle(await wallet.ctx(net), s.key, next)} />
      </section>

      <section className="card" style={closeWhy && s.status !== 'unhired' && s.status !== 'ended' && !s.m.breached ? undefined : { order: -1 }}>
        <div className="card-head"><h2>Close</h2><span className="quiet">treasury only</span></div>
        <p className="quiet">Settles any remaining epochs, pulls the managed position and the anchor out of the pool, and sends all inventory and fees back to the treasury. The manager's bond (if not slashed) becomes claimable.</p>
        <Act label="Close mandate" kind="secondary" disabled={!!closeWhy} why={closeWhy} run={async () => act.close(await wallet.ctx(net), s.key)} />
      </section>

      <section className="card">
        <div className="card-head"><h2>Claim</h2><span className="quiet">pull payments: refunds, returned bonds, pay</span></div>
        {!wallet.account ? <p className="quiet">Connect to see what you can claim.</p> : !mine.data ? <p className="quiet">Reading…</p> : (
          <>
            <dl className="ledger">
              <Row k={s.tok[0].symbol} v={fmt(mine.data.o0, s.tok[0].decimals, 4)} />
              <Row k={s.tok[1].symbol} v={fmt(mine.data.o1, s.tok[1].decimals, 4)} />
              <Row k="Your track record" v={`${mine.data.r.clean} clean · ${mine.data.r.breached} breached`} />
            </dl>
            <div className="row-btns">
              <Act label={`Claim ${s.tok[0].symbol}`} kind="secondary" disabled={!mine.data.o0} run={async () => act.claim(await wallet.ctx(net), c0)} />
              <Act label={`Claim ${s.tok[1].symbol}`} kind="secondary" disabled={!mine.data.o1} run={async () => act.claim(await wallet.ctx(net), c1)} />
            </div>
          </>
        )}
      </section>

      <section className="card span">
        <div className="card-head"><h2>Manager's track record</h2><span className="quiet">settled epochs across every mandate</span></div>
        {!hired ? <p className="quiet">No manager.</p> : !mgr.data ? <p className="quiet">Reading…</p> : (
          <div className="stats">
            <Stat label="Manager"><Addr a={s.m.manager} tone="violet" /></Stat>
            <Stat label="Clean epochs" tone="mint">{mgr.data.r.clean}</Stat>
            <Stat label="Breached epochs" tone="rose">{mgr.data.r.breached}</Stat>
            <Stat label="Claimable">{fmt(mgr.data.o[0], s.tok[0].decimals, 4)} {s.tok[0].symbol} · {fmt(mgr.data.o[1], s.tok[1].decimals, 4)} {s.tok[1].symbol}</Stat>
          </div>
        )}
      </section>
    </div>
  );
}
