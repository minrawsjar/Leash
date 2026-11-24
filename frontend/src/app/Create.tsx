// Post a mandate (treasury): a term sheet in five numbered sections, every field explained, every createMandate
// check shown at the field it belongs to, and an assistant that drafts the sheet from plain words (never signs).
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { erc20Abi, zeroAddress, type Address } from 'viem';
import { client, dur, feePct, fmtLiq, fmtNum, leashAbi, pct, poolId, short, token } from './chain.ts';
import * as act from './actions.ts';
import { applyDraft, defaultForm, plan, PRESETS, type Field, type Form } from './plan.ts';
import type { Draft } from '../../api/draft.ts';
import { Act, useApp, usePoll } from './ui.tsx';

// What each field is, a typical value, and what goes wrong at either end. True to Leash.sol.
const INFO: Record<Field | 's1' | 's2' | 's3' | 's4' | 's5', string> = {
  s1: 'What you deposit. Leash holds it in the hook and the pool for the whole mandate; only you can take it out, by closing.',
  s2: 'Managers bid a first-loss bond in the stablecoin until the auction ends, and the highest bid is hired. If an epoch misses its uptime, part of the bond is paid to you, in proportion to the time out beyond the allowance; twice the allowance pays all of it and fires the manager.',
  s3: 'The hook checks these on every rebalance and every checkpoint. A manager out of compliance for more than the allowed share of an epoch loses part of the bond; twice the allowance loses all of it and is fired.',
  s4: 'How long the mandate runs, what a clean manager earns, and how fast the inventory may turn into stablecoin.',
  s5: 'The pool is never empty. Your opening position straddles the price, and a permanent full-range anchor puts liquidity at every price so pushing the TWAP costs real capital.',
  token: 'The ERC-20 your treasury holds and wants managed. It must be a deployed contract on this network; Leash pairs it with the stablecoin in a new Uniswap v4 pool.',
  stable: 'The other side of the pool. Bonds are bid and paid in it, and the pace caps measure how much of the inventory has turned into it.',
  tokenAmount: 'How much of the token you deposit. The manager can move it between the hook and the pool, but can never withdraw it.',
  stableAmount: 'The stablecoin deposited alongside. Both sides are needed because the opening position and the anchor straddle the price; keep the two near equal by value or the anchor gets too thin.',
  price: 'Where the new pool starts, in stablecoin per token. Set it at the market price: an off-market price is arbitraged away at your expense on the first trade.',
  tickSpacing: 'The grid that ranges snap to; 60 is usual. Each pool holds one mandate, so a different spacing makes a different pool for the same pair.',
  auctionHours: 'How long managers can bid. It must outlast the TWAP window plus a minute, so the oracle holds a full window before anyone acts. A day is typical for a real mandate.',
  minBond: 'The smallest bond a manager may bid. It is first-loss: an epoch that misses its uptime pays part or all of it to you. It must be at least 2% of the deposit’s value. Too low invites careless managers; too high and nobody bids.',
  twapMins: 'The averaging window the hook uses as fair price. Longer is harder to manipulate but slower to follow real moves; 30 minutes is typical. The auction must last at least this long.',
  maxTickDeviation: 'A rebalance is refused while spot is further than this from the TWAP (100 ticks is about 1%), so nobody re-ranges into a pushed price. It must be smaller than the minimum half-width.',
  minHalfWidth: 'The managed range must always cover the TWAP plus or minus this many ticks. Wider is safer but earns less per unit of liquidity. It must exceed the max spot–TWAP gap, so a pushed spot never reaches the edge.',
  floorPct: 'The depth floor (minLiquidity), as a share of your opening position: the manager can never shrink the position below it. Too low lets depth be withdrawn; 100% forbids any shrinking.',
  minFeePct: 'The lowest swap fee the manager may set, so every round trip through the pool costs something. 0.05% is typical; 0 lets wash trades through for free.',
  maxFeePct: 'The highest swap fee the manager may set, and the fee the pool opens at. Too high sends traders elsewhere. It must be at least the floor and at most 100%.',
  uptimePct: 'The share of each epoch the manager must be compliant: depth at or above the floor, range around the TWAP, stablecoin under the pace cap. 95% is typical; 100% means one bad interval slashes the bond.',
  managerFeePct: 'The manager’s share of a clean epoch’s LP fees; you keep the rest. A breached epoch pays nothing. 20–30% is typical.',
  epochHours: 'One judged period. Compliance is scored and fees are paid per epoch. A week suits a real mandate; an hour suits a demo.',
  epochs: 'How many epochs the mandate runs, from 1 to 104. They settle in order; the mandate lasts epochs × epoch length.',
  startStablePct: 'The most stablecoin the inventory may hold at the start, as a share of its value. If the deposit opens above it, epoch 0 starts off pace and counts against the manager.',
  endStablePct: 'The cap at the end; it glides in a straight line from the start cap. The gap between the two is your selling pace: selling faster than the line counts as non-compliance.',
  rangePct: 'Your opening position spans the opening price plus or minus this much. It must cover the minimum half-width either side, or createMandate refuses it.',
  positionPct: 'The share of each side of the deposit placed in the opening position. What is left (after the anchor) sits idle in the hook for the manager to deploy.',
  anchorPct: 'The share of each side placed in the permanent full-range anchor, which the manager cannot touch. It must hold at least 19% of the deposit’s value, or createMandate reverts with ThinAnchor.',
};

// Short on the chip, full in the box: three different shapes of request, not three paraphrases.
const EXAMPLES: [string, string][] = [
  ['Sell 10% over a quarter', 'Sell 10% of our 1M TKN treasury into USDC over a quarter, keep fees between 0.05% and 0.5%, want a bond of at least 25k'],
  ['Two-week trial', 'Two-week trial with 50k TKN at $2, daily epochs, cautious rules, a small 2k bond'],
  ['Six months, no net selling', 'Make a market in 250k TKN for six months without net selling, fee cap 0.3%, strict uptime'],
];

export function Create() {
  const { net, wallet } = useApp();
  useEffect(() => { if (location.hash.endsWith('/ai')) document.getElementById('assist-t')?.focus(); }, []);
  const [f, setF] = useState<Form>(() => defaultForm(net.dep.tkn, net.dep.usdc));
  const [why, setWhy] = useState<Partial<Record<Field, string>>>({});
  const set = (k: Field) => (v: string) => {
    setF((x) => ({ ...x, [k]: typeof x[k] === 'number' ? Number(v) : v.trim() }));
    setWhy((w) => (w[k] ? { ...w, [k]: undefined } : w)); // a hand edit replaces the assistant's reason
  };
  const valid = (a: string) => /^0x[0-9a-fA-F]{40}$/.test(a);

  const env = usePoll(async () => {
    const c = client(net);
    const meta = async (a: string) => (valid(a) && (await c.getCode({ address: a as Address }))?.length ? token(net, a as Address) : null);
    const [tok, stb, blk] = await Promise.all([meta(f.token), meta(f.stable), c.getBlock()]);
    const bal = async (t: Address | undefined) => (t && wallet.account ? c.readContract({ address: t, abi: erc20Abi, functionName: 'balanceOf', args: [wallet.account] }) : null);
    const [bTok, bStb] = await Promise.all([bal(tok?.address), bal(stb?.address)]);
    return { tok, stb, now: net.id === 31337 ? Math.max(Number(blk.timestamp), Math.floor(Date.now() / 1000)) : Number(blk.timestamp), bTok, bStb };
  }, 8_000, [net.id, f.token, f.stable, wallet.account]);

  const e = env.data;
  const p = plan(f, net.dep.leash, e?.tok ?? null, e?.stb ?? null, e?.now ?? Date.now() / 1000);
  // One mandate per pool: if this key is taken, find the nearest free tick spacing to offer instead.
  const taken = usePoll(async () => {
    if (!('key' in p)) return null;
    const used = async (ts: number) => ((await client(net).readContract({ address: net.dep.leash, abi: leashAbi, functionName: 'mandate', args: [poolId({ ...p.key, tickSpacing: ts })] })) as { treasury: Address }).treasury !== zeroAddress;
    if (!(await used(p.key.tickSpacing))) return null;
    for (const ts of [60, 10, 30, 100, 200, 1, 20, 50, 120]) if (ts !== p.key.tickSpacing && !(await used(ts))) return ts;
    return 0;
  }, 8_000, ['id' in p ? p.id : '']);
  const problems = [...p.problems];
  const at = { ...p.at };
  const owner = new Map<string, Field>(Object.entries(p.owner)); // problem → its field, for the receipt's jump links
  const flag = (k: Field, msg: string) => { problems.push(msg); at[k] ??= msg; owner.set(msg, k); };
  if (taken.data != null) flag('tickSpacing', `A mandate already exists for this pair at tick spacing ${f.tickSpacing}; each pool holds one.`);
  if ('key' in p && e?.tok && e.stb && e.bTok !== null && e.bStb !== null) {
    const [needTok, needStb] = p.terms.stableIs0 ? [p.amount1, p.amount0] : [p.amount0, p.amount1];
    if (e.bTok < needTok) flag('tokenAmount', `Your wallet holds ${fmtNum(Number(e.bTok) / 10 ** e.tok.decimals)} ${e.tok.symbol}, less than this.`);
    if (e.bStb < needStb) flag('stableAmount', `Your wallet holds ${fmtNum(Number(e.bStb) / 10 ** e.stb.decimals)} ${e.stb.symbol}, less than this.`);
  }
  const sym = { tok: e?.tok?.symbol ?? 'TKN', stb: e?.stb?.symbol ?? 'USD' };
  const ok = 'key' in p ? p : null;

  async function submit() {
    const ctx = await wallet.ctx(net);
    const blockTs = Number((await ctx.pub.getBlock()).timestamp); // auctionEnd from chain time at signing (anvil: never behind the wall clock)
    const now = net.id === 31337 ? Math.max(blockTs, Math.floor(Date.now() / 1000)) : blockTs;
    const q = plan(f, net.dep.leash, e!.tok, e!.stb, now);
    if (!('key' in q) || q.problems.length) throw new Error(q.problems[0]);
    const hash = await act.createMandate(ctx, q.key, q.sqrtPriceX96, q.terms, q.amount0, q.amount1, q.initial);
    location.hash = `#/m/${q.id}`;
    return hash;
  }

  const review = useRef<HTMLElement>(null);
  const field = (k: Field, label: string, o: { unit?: string; sub?: ReactNode; wide?: boolean; mono?: boolean; text?: boolean } = {}) => (
    <Fld k={k} label={label} value={String(f[k])} onChange={set(k)} err={at[k]} why={why[k]} {...o} />
  );
  const holds = (t: { symbol: string; decimals: number } | null, a: string) =>
    !valid(a) ? 'an ERC-20 you hold' : t ? `${t.symbol} · ${t.decimals} decimals` : env.data ? 'no token at this address on this network' : 'reading…';
  const tick = (n: number) => `≈ ${((Math.pow(1.0001, n) - 1) * 100).toFixed(2)}%`;
  const pips = (s: string) => `${Math.round(Number(s) * 10_000).toLocaleString('en-US')} pips`;

  return (
    <>
      <section className="head">
        <p className="eyebrow">Treasury · new mandate</p>
        <h1>Post a mandate</h1>
        <p className="lede">Write the terms a manager must work under. The hook creates the pool, places your opening position and a permanent anchor, and runs a bond auction. Nobody but you can ever take the inventory out.</p>
      </section>

      <Assist ctx={{ token0: f.token, token1: f.stable, symbols: { token: e?.tok?.symbol, stable: e?.stb?.symbol }, decimals: { token: e?.tok?.decimals, stable: e?.stb?.decimals }, spot: Number(f.price) || undefined }}
        onDraft={(d) => {
          // Mark only what the draft changed: a mint dot on every field would mark nothing.
          const r = applyDraft(f, d);
          const changed = Object.fromEntries(Object.entries(r.why).filter(([k]) => String(r.form[k as Field]) !== String(f[k as Field])));
          setF(r.form); setWhy(changed);
          return Object.keys(changed).length;
        }} />

      <button type="button" className={`create-status ${problems.length ? 'bad' : 'ok'}`} onClick={() => review.current?.scrollIntoView({ behavior: 'smooth' })}>
        {problems.length ? `${problems.length} to fix before posting` : 'Ready to post'}<span aria-hidden>Review ↓</span>
      </button>
      <div className="create">
        <form className="sheet" onSubmit={(ev) => ev.preventDefault()} noValidate>
          <p className="starts">Start from
            {Object.entries(PRESETS).map(([k, v]) => (
              <button key={k} type="button" className="link" onClick={() => { setF((x) => ({ ...x, ...v.f })); setWhy({}); }} title={v.note}>{v.label}</button>
            ))}
          </p>

          <Sec n="01" title="Inventory" info={INFO.s1}>
            {field('token', 'Treasury token', { wide: true, mono: true, text: true, sub: holds(e?.tok ?? null, f.token) })}
            {field('stable', 'Stablecoin', { wide: true, mono: true, text: true, sub: holds(e?.stb ?? null, f.stable) })}
            {field('tokenAmount', 'Token deposit', { unit: sym.tok, text: true })}
            {field('stableAmount', 'Stablecoin deposit', { unit: sym.stb, text: true, sub: ok ? `opens at ${pct(ok.openStableBps)} stablecoin by value` : undefined })}
            {field('price', 'Opening price', { unit: `${sym.stb} / ${sym.tok}`, text: true, sub: ok ? `opening tick ${ok.openTick}` : undefined })}
            {field('tickSpacing', 'Tick spacing', { unit: 'ticks' })}
            {!!taken.data && <p className="fld wide"><button type="button" className="link" onClick={() => set('tickSpacing')(String(taken.data))}>Use tick spacing {taken.data} instead: that pool is free</button></p>}
          </Sec>

          <Sec n="02" title="Auction and bond" info={INFO.s2}>
            {field('auctionHours', 'Auction length', { unit: 'hours', sub: ok ? `bidding closes ${when(ok.terms.auctionEnd)}` : undefined })}
            {field('minBond', 'Minimum bond', { unit: sym.stb, text: true })}
          </Sec>

          <Sec n="03" title="Rules the manager must follow" info={INFO.s3}>
            {field('twapMins', 'TWAP window', { unit: 'min' })}
            {field('uptimePct', 'Required uptime', { unit: '%', sub: 'of each epoch' })}
            {field('maxTickDeviation', 'Max spot–TWAP gap', { unit: 'ticks', sub: tick(f.maxTickDeviation) })}
            {field('minHalfWidth', 'Minimum half-width', { unit: 'ticks', sub: `${tick(f.minHalfWidth)} either side of the TWAP` })}
            {field('minFeePct', 'Fee floor', { unit: '%', text: true, sub: pips(f.minFeePct) })}
            {field('maxFeePct', 'Fee cap', { unit: '%', text: true, sub: pips(f.maxFeePct) })}
            {field('floorPct', 'Depth floor', { unit: '%', sub: ok ? `of the opening position · ${fmtLiq(ok.terms.minLiquidity)} liquidity` : 'of the opening position' })}
          </Sec>

          <Sec n="04" title="Pay and pace" info={INFO.s4}>
            {field('epochHours', 'Epoch length', { unit: 'hours', sub: `= ${dur(f.epochHours * 3600)}` })}
            {field('epochs', 'Epochs', { sub: `runs ${dur(f.epochs * f.epochHours * 3600)} in all` })}
            {field('managerFeePct', 'Manager’s share of fees', { unit: '%', sub: 'paid per clean epoch' })}
            <span className="fld" aria-hidden />
            {field('startStablePct', 'Stablecoin cap at start', { unit: '%' })}
            {field('endStablePct', 'Stablecoin cap at end', { unit: '%', sub: `${(f.endStablePct - f.startStablePct).toFixed(1).replace(/\.0$/, '')} points over the mandate` })}
          </Sec>

          <Sec n="05" title="Opening position" info={INFO.s5}>
            {field('rangePct', 'Opening range', { unit: '± %', sub: ok ? `ticks ${ok.initial.tickLower} to ${ok.initial.tickUpper}` : undefined })}
            {field('positionPct', 'In the position', { unit: '%', sub: 'of each side' })}
            {field('anchorPct', 'In the anchor', { unit: '%', sub: ok ? `holds ${pct(ok.anchorBps)} of value · needs 19%` : 'needs 19% of value' })}
          </Sec>
        </form>

        <aside className="receipt" aria-label="Review" ref={review}>
          <p className="eyebrow">Review</p>
          <dl className="rcpt">
            <Row k="You deposit">{f.tokenAmount ? fmtNum(Number(f.tokenAmount)) : '–'} {sym.tok}<br />{f.stableAmount ? fmtNum(Number(f.stableAmount)) : '–'} {sym.stb}</Row>
            <Row k="Opening price">{f.price} {sym.stb} / {sym.tok}</Row>
            <Row k="Auction ends">{ok ? when(ok.terms.auctionEnd) : '–'}</Row>
            <Row k="Runs">{ok ? <>{ok.terms.epochs} × {dur(ok.terms.epochLength)}<small>{dur(ok.terms.epochs * ok.terms.epochLength)} after the auction</small></> : '–'}</Row>
            <Row k="Bond floor" tone="violet">{f.minBond ? fmtNum(Number(f.minBond)) : '–'} {sym.stb}</Row>
            <Row k="Fee band" tone={ok && ok.terms.minFee > ok.terms.maxFee ? 'rose' : undefined}>{ok ? `${feePct(ok.terms.minFee)} – ${feePct(ok.terms.maxFee)}` : '–'}</Row>
            <Row k="Pace">{f.startStablePct}% → {f.endStablePct}% stablecoin</Row>
            <Row k="Anchor" tone={ok && ok.anchorBps < 1900 ? 'rose' : undefined}>{ok ? <>{pct(ok.anchorBps)} of value<small>needs 19%</small></> : '–'}</Row>
            <Row k="Manager">{f.uptimePct}% uptime · {f.managerFeePct}% of fees</Row>
          </dl>

          {problems.length > 0 && (
            <div className="rcpt-issues" aria-live="polite">
              <p className="eyebrow rose">{problems.length} to fix</p>
              <ul>
                {problems.map((x) => {
                  const k = owner.get(x);
                  return <li key={x}>{k ? <button type="button" className="link" onClick={() => document.getElementById(`f-${k}`)?.focus()}>{x}</button> : x}</li>;
                })}
              </ul>
            </div>
          )}
          {ok && ok.warnings.length > 0 && <ul className="rcpt-warn">{ok.warnings.map((x) => <li key={x}>{x}</li>)}</ul>}
          {!problems.length && ok && <p className="rcpt-ok">Every createMandate check passes.</p>}

          {ok && (
            <details className="exact">
              <summary>Exact call</summary>
              <pre className="mono">{exactCall(ok, sym)}</pre>
            </details>
          )}
          <Act label="Approve and post mandate" disabled={problems.length > 0} why={problems.length ? 'Nothing is sent until every check passes.' : 'Up to three signatures: approve each token (skipped if already enough), then createMandate. Simulated first.'} run={submit} />
        </aside>
      </div>
    </>
  );
}

const when = (t: number) => new Date(t * 1000).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

function exactCall(p: NonNullable<Extract<ReturnType<typeof plan>, { key: unknown }>>, sym: { tok: string; stb: string }) {
  const t = p.terms;
  const [s0, s1] = t.stableIs0 ? [sym.stb, sym.tok] : [sym.tok, sym.stb];
  return `createMandate(
  key: { currency0: ${short(p.key.currency0)} (${s0}), currency1: ${short(p.key.currency1)} (${s1}),
         fee: dynamic, tickSpacing: ${p.key.tickSpacing}, hooks: ${short(p.key.hooks)} },
  sqrtPriceX96: ${p.sqrtPriceX96},
  terms: {
    stableIs0: ${t.stableIs0}, maxFee: ${t.maxFee}, auctionEnd: ${t.auctionEnd},
    epochLength: ${t.epochLength}, epochs: ${t.epochs}, minBond: ${t.minBond},
    twapWindow: ${t.twapWindow}, maxTickDeviation: ${t.maxTickDeviation},
    minLiquidity: ${t.minLiquidity}, uptimeBps: ${t.uptimeBps},
    managerFeeBps: ${t.managerFeeBps}, startStableBps: ${t.startStableBps},
    endStableBps: ${t.endStableBps}, minFee: ${t.minFee}, minHalfWidth: ${t.minHalfWidth},
    anchorLiquidity: ${t.anchorLiquidity} },
  amount0: ${p.amount0}, amount1: ${p.amount1},
  initial: { tickLower: ${p.initial.tickLower}, tickUpper: ${p.initial.tickUpper}, liquidity: ${p.initial.liquidity} }
)
pool ${p.id}`;
}

function Row({ k, children, tone }: { k: string; children: ReactNode; tone?: 'violet' | 'rose' }) {
  return <div className="rrow"><dt>{k}</dt><dd className={tone}>{children}</dd></div>;
}

/** The ⓘ: a native popover (Esc and click-outside close it), placed under its button. */
function Info({ id, about, children }: { id: string; about: string; children: string }) {
  const place = (b: HTMLButtonElement) => {
    const tip = document.getElementById(id);
    if (!tip) return;
    const r = b.getBoundingClientRect(), vw = document.documentElement.clientWidth, w = Math.min(320, vw - 32);
    tip.style.width = `${w}px`;
    tip.style.left = `${Math.max(16, Math.min(r.left - 12, vw - w - 16))}px`;
    tip.style.top = `${r.bottom + 8}px`;
  };
  return (
    <>
      <button type="button" className="i" popoverTarget={id} aria-label={`About ${about}`} onClick={(ev) => place(ev.currentTarget)}>i</button>
      <div id={id} popover="auto" className="tip" role="note" ref={(el) => {
        if (!el) return;
        const follow = () => { const b = el.previousElementSibling; if (b instanceof HTMLButtonElement && el.matches(':popover-open')) place(b); };
        addEventListener('scroll', follow, { passive: true });
        return () => removeEventListener('scroll', follow);
      }}><b>{about}</b>{children}</div>
    </>
  );
}

function Sec({ n, title, info, children }: { n: string; title: string; info: string; children: ReactNode }) {
  return (
    <fieldset className="sec">
      <legend className="sec-h"><span className="sec-n">{n}</span>{title}<Info id={`tip-s${n}`} about={title}>{info}</Info></legend>
      <div className="flds">{children}</div>
    </fieldset>
  );
}

function Fld({ k, label, value, onChange, err, why, unit, sub, wide, mono, text }: {
  k: Field; label: string; value: string; onChange: (v: string) => void; err?: string; why?: string; unit?: string; sub?: ReactNode; wide?: boolean; mono?: boolean; text?: boolean;
}) {
  const id = `f-${k}`;
  return (
    <div className={`fld${wide ? ' wide' : ''}${err ? ' bad' : ''}${why ? ' drafted' : ''}`}>
      <div className="fld-l"><label htmlFor={id}>{label}</label><Info id={`tip-${k}`} about={label}>{INFO[k]}</Info></div>
      <div className="inp">
        <input id={id} className={mono ? 'mono' : undefined} value={value} onChange={(x) => onChange(x.target.value)} inputMode={mono ? 'text' : 'decimal'}
          type={text ? 'text' : 'number'} step="any" spellCheck={false} autoComplete="off" aria-invalid={!!err} aria-describedby={err ? `${id}-e` : undefined} />
        {unit && <span className="unit">{unit}</span>}
      </div>
      {err ? <small className="err" id={`${id}-e`}>{err}</small> : sub ? <small className="sub">{sub}</small> : null}
      {why && <small className="why">{why}</small>}
    </div>
  );
}

type Ctx = { token0?: string; token1?: string; symbols?: { token?: string; stable?: string }; decimals?: { token?: number; stable?: number }; spot?: number };

/** "Describe what you need": the server drafts, this fills the form, the person reviews. Nothing is signed here. */
function Assist({ ctx, onDraft }: { ctx: Ctx; onDraft: (d: Draft) => number }) {
  const [text, setText] = useState('');
  const [s, setS] = useState<{ busy?: boolean; err?: string; done?: Draft; changed?: number }>({});
  async function go(req = text) {
    if (!req.trim()) return;
    setS({ busy: true });
    try {
      const r = await fetch('/api/draft', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ requirements: req, context: ctx }) });
      const body = await r.json().catch(() => ({ error: `The assistant is not available here (HTTP ${r.status}).` }));
      if (!r.ok || !body.draft) return setS({ err: body.error ?? `The assistant failed (HTTP ${r.status}).` });
      setS({ done: body.draft, changed: onDraft(body.draft) });
    } catch {
      setS({ err: 'Could not reach the assistant. The form still works by hand.' });
    }
  }
  const d = s.done;
  return (
    <section className="assist" aria-labelledby="assist-h">
      <div className="assist-top">
        <label id="assist-h" htmlFor="assist-t" className="eyebrow">Describe what you need</label>
        <span className="quiet small">The assistant drafts the sheet below. It never posts or signs; you review every field.</span>
      </div>
      <textarea id="assist-t" rows={3} value={text} onChange={(x) => setText(x.target.value)} maxLength={4000}
        placeholder="e.g. sell 5% of our treasury over two months, keep fees low, bond at least 10k"
        onKeyDown={(x) => { if (x.key === 'Enter' && (x.metaKey || x.ctrlKey)) go(); }} />
      <div className="assist-row">
        <div className="chips" role="group" aria-label="Examples">
          <span className="chips-l" aria-hidden>Try</span>
          {EXAMPLES.map(([k, x]) => <button key={k} type="button" className="chip" title={x} onClick={() => setText(x)}>{k}</button>)}
        </div>
        <button type="button" className="btn secondary sm" disabled={s.busy || !text.trim()} onClick={() => go()} aria-busy={s.busy}>{s.busy ? 'Drafting…' : 'Draft the terms'}</button>
      </div>
      <p className="assist-note" role="status" aria-live="polite">
        {s.busy ? 'Reading your requirements. This takes a few seconds.' : s.err ? <span className="err">{s.err}</span> : d ? (s.changed ? `Changed ${s.changed} field${s.changed > 1 ? 's' : ''}, each marked in mint with the reason. Check them, then the review.` : 'The draft matches what the form already says.') : ''}
      </p>
      {d && (d.assumptions.length > 0 || d.questions.length > 0) && (
        <div className="assist-out">
          {d.assumptions.length > 0 && <div><p className="eyebrow">Assumed</p><ul>{d.assumptions.map((x) => <li key={x}>{x}</li>)}</ul></div>}
          {d.questions.length > 0 && <div><p className="eyebrow">Needs your answer</p><ul>{d.questions.map((x) => <li key={x}>{x}</li>)}</ul></div>}
        </div>
      )}
    </section>
  );
}
