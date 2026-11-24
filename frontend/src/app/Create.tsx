// Post a mandate (treasury): inventory, the opening position, and all 16 terms, checked before signing.
import { useRef, useState, type ReactNode } from 'react';
import { erc20Abi, zeroAddress, type Address } from 'viem';
import { client, dur, fmtLiq, fmtNum, leashAbi, poolId, short, token, type Terms } from './chain.ts';
import * as act from './actions.ts';
import { defaultForm, plan, PRESETS, type Form } from './plan.ts';
import { Act, useApp, usePoll } from './ui.tsx';

export function Create() {
  const { net, wallet } = useApp();
  const [f, setF] = useState<Form>(() => defaultForm(net.dep.tkn, net.dep.usdc));
  const set = <K extends keyof Form>(k: K) => (v: Form[K]) => setF((x) => ({ ...x, [k]: v }));
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
  if (taken.data != null) problems.push(`A mandate already exists for this pair at tick spacing ${f.tickSpacing} (each pool holds one).`);
  if ('key' in p && e?.tok && e.stb && e.bTok !== null && e.bStb !== null) {
    const [needTok, needStb] = p.terms.stableIs0 ? [p.amount1, p.amount0] : [p.amount0, p.amount1];
    if (e.bTok < needTok) problems.push(`Your wallet holds ${fmtNum(Number(e.bTok) / 10 ** e.tok.decimals)} ${e.tok.symbol}, less than the deposit.`);
    if (e.bStb < needStb) problems.push(`Your wallet holds ${fmtNum(Number(e.bStb) / 10 ** e.stb.decimals)} ${e.stb.symbol}, less than the deposit.`);
  }
  const sym = { tok: e?.tok?.symbol ?? 'token', stb: e?.stb?.symbol ?? 'stable' };

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
  const num = (k: keyof Form) => (v: string) => set(k)(Number(v) as never);
  return (
    <>
      <section className="head">
        <p className="eyebrow">Treasury</p>
        <h1>Post a mandate</h1>
        <p className="lede">Deposit inventory, set the rules, open the bond auction. The hook creates the pool, places your opening position and a permanent full-range anchor, and nobody but you can ever take the inventory out.</p>
      </section>

      <div className="presets" role="group" aria-label="Presets">
        {Object.entries(PRESETS).map(([k, v]) => (
          <button key={k} type="button" className="btn secondary sm" onClick={() => setF((x) => ({ ...x, ...v.f }))} title={v.note}>{v.label}</button>
        ))}
      </div>

      <button type="button" className={`create-status ${problems.length ? "bad" : "ok"}`} onClick={() => review.current?.scrollIntoView({ behavior: "smooth" })}>
        {problems.length ? `${problems.length} thing${problems.length > 1 ? "s" : ""} to fix before posting · review` : "Ready to post · review"}
      </button>
      <div className="create">
        <form className="create-form" onSubmit={(ev) => ev.preventDefault()}>
          <Group title="Inventory" note="What you deposit. Leash holds it; it only ever moves between the hook and the pool until you close.">
            <F label="Treasury token address" hint={e?.tok ? `${e.tok.symbol} · ${e.tok.decimals} decimals` : 'an ERC-20 you hold'} wide><input className="mono" value={f.token} onChange={(x) => set('token')(x.target.value.trim())} /></F>
            <F label="Stablecoin address" hint={e?.stb ? `${e.stb.symbol} · ${e.stb.decimals} decimals · bonds are paid in it` : 'bonds are paid in it'} wide><input className="mono" value={f.stable} onChange={(x) => set('stable')(x.target.value.trim())} /></F>
            <F label={`Deposit (${sym.tok})`}><input inputMode="decimal" value={f.tokenAmount} onChange={(x) => set('tokenAmount')(x.target.value)} /></F>
            <F label={`Deposit (${sym.stb})`}><input inputMode="decimal" value={f.stableAmount} onChange={(x) => set('stableAmount')(x.target.value)} /></F>
            <F label={`Opening price (${sym.stb} per ${sym.tok})`} hint="the pool starts here"><input inputMode="decimal" value={f.price} onChange={(x) => set('price')(x.target.value)} /></F>
            <F label="Tick spacing" hint="one mandate per pool; 60 is the usual"><input type="number" min={1} value={f.tickSpacing} onChange={(x) => num('tickSpacing')(x.target.value)} /></F>
          </Group>

          <Group title="Opening position and anchor" note="The pool is never empty: your opening position straddles the price, and the anchor puts liquidity at every price so pushing the TWAP costs real capital.">
            <F label="Opening range (± %)" hint={'key' in p ? `ticks ${p.initial.tickLower} … ${p.initial.tickUpper}` : ''}><input type="number" step={1} value={f.rangePct} onChange={(x) => num('rangePct')(x.target.value)} /></F>
            <F label="Share of deposit in the position (%)"><input type="number" value={f.positionPct} onChange={(x) => num('positionPct')(x.target.value)} /></F>
            <F label="Share of deposit in the anchor (%)" hint={'key' in p ? `≈ ${(p.anchorBps / 100).toFixed(1)}% of value · needs ≥ 19%` : 'needs ≥ 19% of value'}><input type="number" value={f.anchorPct} onChange={(x) => num('anchorPct')(x.target.value)} /></F>
            <F label="Depth floor (% of opening liquidity)" hint="minLiquidity: the manager can never go below it"><input type="number" value={f.floorPct} onChange={(x) => num('floorPct')(x.target.value)} /></F>
          </Group>

          <Group title="Auction and epochs" note="Managers bid a first-loss bond until the auction ends; then the winner runs the mandate epoch by epoch.">
            <F label="Auction length (minutes)" hint={`auctionEnd ≈ now + ${dur(f.auctionMins * 60)}; must outlast the TWAP window`}><input type="number" value={f.auctionMins} onChange={(x) => num('auctionMins')(x.target.value)} /></F>
            <F label={`Minimum bond (${sym.stb})`}><input inputMode="decimal" value={f.minBond} onChange={(x) => set('minBond')(x.target.value)} /></F>
            <F label="Epoch length (seconds)" hint={dur(f.epochLength)}><input type="number" value={f.epochLength} onChange={(x) => num('epochLength')(x.target.value)} /></F>
            <F label="Epochs" hint={`1–104 · mandate runs ${dur(f.epochs * f.epochLength)}`}><input type="number" value={f.epochs} onChange={(x) => num('epochs')(x.target.value)} /></F>
            <F label="Uptime to count as clean (%)" hint="share of each epoch in compliance"><input type="number" step={0.5} value={f.uptimePct} onChange={(x) => num('uptimePct')(x.target.value)} /></F>
            <F label="Manager's share of fees (%)" hint="paid for each clean epoch"><input type="number" value={f.managerFeePct} onChange={(x) => num('managerFeePct')(x.target.value)} /></F>
          </Group>

          <Group title="Guards" note="What stops a manager from mispricing your inventory instead of withdrawing it.">
            <F label="TWAP window (seconds)" hint={dur(f.twapWindow)}><input type="number" value={f.twapWindow} onChange={(x) => num('twapWindow')(x.target.value)} /></F>
            <F label="Max spot–TWAP gap to rebalance (ticks)" hint={`~${(f.maxTickDeviation / 100).toFixed(1)}%`}><input type="number" value={f.maxTickDeviation} onChange={(x) => num('maxTickDeviation')(x.target.value)} /></F>
            <F label="Minimum half-width (ticks)" hint="must exceed the max gap"><input type="number" value={f.minHalfWidth} onChange={(x) => num('minHalfWidth')(x.target.value)} /></F>
            <F label="Fee floor (%)"><input inputMode="decimal" value={f.minFeePct} onChange={(x) => set('minFeePct')(x.target.value)} /></F>
            <F label="Fee cap (%)"><input inputMode="decimal" value={f.maxFeePct} onChange={(x) => set('maxFeePct')(x.target.value)} /></F>
          </Group>

          <Group title="Pace" note="The most stablecoin the inventory may hold, by value, gliding linearly from start to end. Selling faster than this is dumping.">
            <F label="Start cap (% stable)" hint={'key' in p ? `deposit opens at ${(p.openStableBps / 100).toFixed(1)}%` : ''}><input type="number" value={f.startStablePct} onChange={(x) => num('startStablePct')(x.target.value)} /></F>
            <F label="End cap (% stable)"><input type="number" value={f.endStablePct} onChange={(x) => num('endStablePct')(x.target.value)} /></F>
          </Group>
        </form>

        <aside className="card summary" aria-label="Review" ref={review}>
          <div className="card-head"><h2>Review</h2><span className="quiet">exactly what is sent</span></div>
          {'key' in p ? <TermsTable t={p.terms} bond={`${f.minBond} ${sym.stb}`} /> : null}
          {'key' in p && <p className="quiet small mono">pool {short(p.id)} · opening tick {p.openTick}</p>}
          <ul className="problems" aria-live="polite">
            {problems.map((x) => <li key={x} className="bad">{x}</li>)}
            {'warnings' in p && p.warnings.map((x) => <li key={x} className="warn">{x}</li>)}
            {!problems.length && <li className="ok">All of createMandate's checks pass.</li>}
          </ul>
          {!!taken.data && <button type="button" className="btn secondary sm" onClick={() => set('tickSpacing')(taken.data!)}>Use tick spacing {taken.data} (free)</button>}
          <Act label="Approve and post mandate" disabled={problems.length > 0} why={problems.length ? '' : 'Up to three signatures: approve each token (skipped if already enough), then createMandate. It is simulated first.'} run={submit} />
        </aside>
      </div>
    </>
  );
}

function Group({ title, note, children }: { title: string; note: string; children: ReactNode }) {
  return <fieldset className="group"><legend>{title}</legend><p className="quiet small">{note}</p><div className="form-grid">{children}</div></fieldset>;
}
function F({ label, hint, wide, children }: { label: string; hint?: string; wide?: boolean; children: ReactNode }) {
  return <label className={`field ${wide ? 'wide' : ''}`}><span>{label}</span>{children}{hint ? <small>{hint}</small> : null}</label>;
}

function TermsTable({ t, bond }: { t: Terms; bond: string }) {
  const rows: [string, string][] = [
    ['stableIs0', String(t.stableIs0)], ['maxFee', `${t.maxFee} pips`], ['auctionEnd', new Date(t.auctionEnd * 1000).toLocaleString()],
    ['epochLength', `${t.epochLength}s`], ['epochs', String(t.epochs)], ['minBond', `${bond} (${t.minBond})`], ['twapWindow', `${t.twapWindow}s`],
    ['maxTickDeviation', String(t.maxTickDeviation)], ['minLiquidity', fmtLiq(t.minLiquidity)], ['uptimeBps', String(t.uptimeBps)],
    ['managerFeeBps', String(t.managerFeeBps)], ['startStableBps', String(t.startStableBps)], ['endStableBps', String(t.endStableBps)],
    ['minFee', `${t.minFee} pips`], ['minHalfWidth', String(t.minHalfWidth)], ['anchorLiquidity', fmtLiq(t.anchorLiquidity)],
  ];
  return <dl className="ledger terms">{rows.map(([k, v]) => <div className="lrow" key={k}><dt className="mono">{k}</dt><dd>{v}</dd></div>)}</dl>;
}
