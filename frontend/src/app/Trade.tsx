// Trade through a mandate's pool: the order flow a testnet lacks. Every trade pays the swap fee into the treasury's
// position (a clean epoch pays the manager its share at settle); a big enough one drags the TWAP out of the manager's
// range, which is a breach unless the manager rebalances.
import { useState } from 'react';
import { erc20Abi, parseUnits, zeroAddress } from 'viem';
import { client, dur, feePct, fmt, fmtNum, fmtPrice, pct, priceAt, swapPreview, type Snapshot } from './chain.ts';
import * as act from './actions.ts';
import { Act, Stat, useApp, usePoll } from './ui.tsx';

const GIFT = 100_000n; // whole units of each test token that "Get test tokens" mints

export function Trade({ s }: { s: Snapshot }) {
  const { net, wallet } = useApp();
  const t = s.m.terms, router = net.dep.swapRouter;
  const [token, stable] = t.stableIs0 ? [s.tok[1], s.tok[0]] : [s.tok[0], s.tok[1]];
  const [buy, setBuy] = useState(true); // buy the token with the stablecoin, or sell it for the stablecoin
  const [amt, setAmt] = useState('');
  const pay = buy ? stable : token, get = buy ? token : stable;
  const zeroForOne = pay.address.toLowerCase() === s.key.currency0.toLowerCase();
  let raw: bigint | null = null;
  try { raw = amt ? parseUnits(amt, pay.decimals) : null; } catch { raw = null; }

  const bal = usePoll(() => (wallet.account
    ? Promise.all([token, stable].map((x) => client(net).readContract({ address: x.address, abi: erc20Abi, functionName: 'balanceOf', args: [wallet.account!] })))
    : Promise.resolve(null)), 6_000, [wallet.account, s.block]);
  const [bTok, bStb] = bal.data ?? [null, null];
  const have = buy ? bStb : bTok;

  const price = (tick: number) => priceAt(tick, s.key, t, s.tok);
  const leaves = (tick: number) => tick < s.m.tickLower || tick >= s.m.tickUpper;
  const q = raw && raw > 0n ? swapPreview(s, zeroForOne, Number(raw)) : null;
  const inH = raw ? Number(raw) / 10 ** pay.decimals : 0, outH = q ? q.out / 10 ** get.decimals : 0;
  const avg = outH && inH ? (buy ? inH / outH : outH / inH) : NaN;
  const [rLo, rHi] = [price(s.m.tickLower), price(s.m.tickUpper)].sort((a, b) => a - b);
  const isTest = [net.dep.tkn, net.dep.usdc].every((a) => a && [token.address, stable.address].some((x) => x.toLowerCase() === a.toLowerCase()));

  /** The smallest trade this way that ends outside the manager's range (bisection over the preview). */
  function pushOut() {
    let hi = 10 ** pay.decimals;
    for (let i = 0; i < 80 && !leaves(swapPreview(s, zeroForOne, hi).tickAfter); i++) hi *= 2;
    let lo = 0;
    for (let i = 0; i < 50; i++) { const m = (lo + hi) / 2; if (leaves(swapPreview(s, zeroForOne, m).tickAfter)) hi = m; else lo = m; }
    setAmt(String(Math.ceil((hi * 1.02) / 10 ** pay.decimals)));
  }

  const problem = !router ? 'No swap router is configured for this network.'
    : s.m.closed ? 'This mandate is closed: its liquidity has left the pool, so there is nothing to trade against.'
    : raw === null || raw <= 0n ? `Enter an amount of ${pay.symbol} to pay.`
    : have !== null && raw > have ? `Your wallet holds ${fmt(have, pay.decimals)} ${pay.symbol}, less than this.`
    : q?.unfilled ? 'Larger than the pool can fill.' : '';
  const presets = buy ? [1_000, 10_000] : [500, 5_000];
  const sweepFirst = !s.m.swept && s.m.manager !== zeroAddress && s.now >= t.auctionEnd;

  return (
    <div className="grid">
      <section className="card">
        <div className="card-head"><h2>Trade</h2><span className="quiet">anyone · through Uniswap's v4 test router</span></div>
        <div className="x-chips" role="tablist" aria-label="Direction">
          {[true, false].map((b) => (
            <button key={String(b)} type="button" role="tab" className="x-chip" aria-selected={buy === b} onClick={() => { setBuy(b); setAmt(''); }}>
              {b ? `Buy ${token.symbol}` : `Sell ${token.symbol}`}
            </button>
          ))}
        </div>
        <label className="field">
          <span>You pay ({pay.symbol})</span>
          <input inputMode="decimal" placeholder="0" value={amt} onChange={(e) => setAmt(e.target.value.trim())} />
          {have !== null && <small>Wallet: {fmt(have, pay.decimals)} {pay.symbol}</small>}
        </label>
        <div className="row-btns">
          {presets.map((v) => <button key={v} type="button" className="btn secondary sm" onClick={() => setAmt(String(v))}>{fmtNum(v, 0)}</button>)}
          {s.m.liquidity > 0n && !s.m.closed && <button type="button" className="btn secondary sm" onClick={pushOut} title="The smallest trade that ends outside the manager's range">Push out of range</button>}
          {have !== null && have > 0n && <button type="button" className="btn secondary sm" onClick={() => setAmt(fmt(have, pay.decimals, pay.decimals).replace(/,/g, ''))}>Max</button>}
        </div>
        {q && (
          <dl className="ledger">
            <div className="lrow"><dt>You receive ≈</dt><dd>{fmtNum(outH, 4)} {get.symbol}</dd></div>
            <div className="lrow"><dt>Average price</dt><dd>{fmtPrice(avg)} {stable.symbol} per {token.symbol}</dd></div>
            <div className="lrow"><dt>Fee on this trade</dt><dd>≈ {fmtNum((inH * q.fee) / 1e6, 4)} {pay.symbol} · {feePct(q.fee)}{q.fee > s.lpFee && <small> (set {feePct(s.lpFee)} + off-TWAP surcharge)</small>}</dd></div>
            <div className="lrow"><dt>Spot after ≈</dt><dd>{fmtPrice(price(q.tickAfter))} <small>from {fmtPrice(price(s.spot))}</small></dd></div>
            <div className="lrow"><dt>Manager's range</dt><dd>{fmtPrice(rLo)} – {fmtPrice(rHi)}</dd></div>
          </dl>
        )}
        {q && leaves(q.tickAfter) && !s.m.closed && (
          <p className="banner">This trade ends outside the manager's range. Held there, the TWAP ({dur(t.twapWindow)} window) follows it out, and every second after that counts against the manager until they rebalance: past {pct(10_000 - t.uptimeBps, 0)} of an epoch the bond is slashed.</p>
        )}
        <Act label="Swap" disabled={!!problem} why={problem || (sweepFirst ? 'First trade since bidding closed: a checkpoint goes first, so the auction\'s fees go to the treasury and this trade\'s fees count toward the manager\'s epoch (one more signature). ' : '') + 'Estimated above; the chain decides. The first trade in each token also approves the test router.'}
          run={async () => {
            const ctx = await wallet.ctx(net);
            // The contract hands fees earned before the epochs to the treasury at the first checkpoint after bidding
            // closes, and swaps don't trigger it. Without a keeper running, do it here, or this trade's fees count as pre-hire.
            if (sweepFirst) await act.checkpoint(ctx, s.key);
            return act.swap(ctx, router!, s.key, zeroForOne, raw!);
          }} />
      </section>

      <section className="card">
        <div className="card-head"><h2>Your wallet</h2><span className="quiet">{wallet.account ? 'connected' : 'connect to see balances'}</span></div>
        <div className="stats">
          <Stat label={token.symbol}>{bTok === null ? '–' : fmt(bTok, token.decimals)}</Stat>
          <Stat label={stable.symbol}>{bStb === null ? '–' : fmt(bStb, stable.decimals)}</Stat>
        </div>
        {isTest && (
          <Act label="Get test tokens" kind="secondary" why={`Mints ${fmtNum(Number(GIFT), 0)} ${token.symbol} and ${fmtNum(Number(GIFT), 0)} ${stable.symbol} to the connected wallet (two signatures). Test tokens, worth nothing.`}
            run={async () => { const ctx = await wallet.ctx(net); await act.mintTest(ctx, token.address, GIFT * 10n ** BigInt(token.decimals)); return act.mintTest(ctx, stable.address, GIFT * 10n ** BigInt(stable.decimals)); }} />
        )}
        <p className="quiet">Every trade pays the swap fee into the treasury's position. When the epoch settles clean, the manager earns {pct(t.managerFeeBps, 0)} of it and the treasury keeps the rest. Trading while spot is off the TWAP costs more, so pushing the price pays the treasury.</p>
      </section>
    </div>
  );
}
