// Drives every write the app makes against a fresh ./scripts/local.sh chain, through the same functions the
// screens call (actions.ts, plan.ts), and checks the result on-chain. Anvil's public dev keys only.
//   cd frontend && node --experimental-strip-types src/app/verify.ts
import { createTestClient, createWalletClient, http, erc20Abi, type Address } from 'viem';
import { mnemonicToAccount } from 'viem/accounts';
import { NETS, client, token, leashLogs, mandatesFrom, owed, snapshot, trackRecord, epochRecords, viemChain } from './chain.ts';
import * as act from './actions.ts';
import { defaultForm, plan } from './plan.ts';

const net = NETS[31337];
const pub = client(net);
const test = createTestClient({ mode: 'anvil', chain: viemChain(net), transport: http(net.rpc) });
const MN = 'test test test test test test test test test test test junk';
const ctx = (i: number): act.Ctx => {
  const account = mnemonicToAccount(MN, { addressIndex: i });
  return { pub, wallet: createWalletClient({ account, chain: viemChain(net), transport: http(net.rpc) }), account: account.address, leash: net.dep.leash };
};
const [treasury, m1, m2, , keeper] = [0, 1, 2, 3, 4].map(ctx);
let fails = 0;
const ok = (cond: boolean, what: string) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${what}`); if (!cond) fails++; };
/** Expects `p` to revert, and the app's explanation to match. */
async function refuses(p: Promise<unknown>, words: RegExp, what: string) {
  try { await p; ok(false, `${what}: expected a revert`); } catch (e) { const s = act.explain(e); ok(words.test(s), `${what} -> "${s}"`); }
}
const skip = async (s: number) => { await test.increaseTime({ seconds: s }); await test.mine({ blocks: 1 }); };

const [seed] = mandatesFrom(await leashLogs(net));
const key = seed.key;
let s = await snapshot(net, seed.id, key);
if (s.status !== 'auction') throw new Error(`Seeded mandate is "${s.status}", not in auction: restart ./scripts/local.sh for a fresh chain.`);
const usdc = net.dep.usdc!;
const U = 1_000_000n;

// ---- auction: outbid, refund, claim
ok(s.m.manager === m2.account, 'seeded leader is manager #2');
await refuses(act.bid(m1, key, usdc, 1_500n * U), /too low/, 'bid at the leader\'s bond');
await act.bid(m1, key, usdc, 2_000n * U);
s = await snapshot(net, seed.id, key);
ok(s.m.manager === m1.account && s.m.bond === 2_000n * U, 'bid 2,000: manager #1 leads');
ok((await owed(net, m2.account, usdc)) === 1_500n * U, 'outbid #2 has 1,500 claimable');
const before = await pub.readContract({ address: usdc, abi: erc20Abi, functionName: 'balanceOf', args: [m2.account] });
await act.claim(m2, usdc);
const after = await pub.readContract({ address: usdc, abi: erc20Abi, functionName: 'balanceOf', args: [m2.account] });
ok(after - before === 1_500n * U && (await owed(net, m2.account, usdc)) === 0n, 'claim pays #2 its 1,500 refund');

// ---- create: the form's plan, a thin anchor refused, then a real mandate on a new pool (spacing 10)
const now = Number((await pub.getBlock()).timestamp);
const thin = plan({ ...defaultForm(net.dep.tkn, usdc), tickSpacing: 10, anchorPct: 10 }, net.dep.leash, await tok(net.dep.tkn!), await tok(usdc), now);
ok('key' in thin && thin.problems.some((p) => /anchor holds/.test(p)), 'plan flags a 10% anchor before signing');
if ('key' in thin) await refuses(act.createMandate(treasury, thin.key, thin.sqrtPriceX96, thin.terms, thin.amount0, thin.amount1, thin.initial), /anchor is too thin/, 'createMandate with a 10% anchor');
const p = plan({ ...defaultForm(net.dep.tkn, usdc), tickSpacing: 10 }, net.dep.leash, await tok(net.dep.tkn!), await tok(usdc), now);
if (!('key' in p)) throw new Error(p.problems.join('; '));
ok(p.problems.length === 0, `plan passes: ${p.problems.join('; ') || 'no problems'}`);
await act.createMandate(treasury, p.key, p.sqrtPriceX96, p.terms, p.amount0, p.amount1, p.initial);
const created = mandatesFrom(await leashLogs(net)).find((x) => x.id === p.id);
ok(!!created, `createMandate: MandateCreated for ${p.id.slice(0, 10)}`);
const s2 = await snapshot(net, p.id, p.key);
ok(s2.status === 'auction' && s2.m.liquidity === p.initial.liquidity && s2.m.terms.anchorLiquidity === p.terms.anchorLiquidity, 'new mandate holds the planned position and anchor');
await refuses(act.createMandate(treasury, p.key, p.sqrtPriceX96, p.terms, p.amount0, p.amount1, p.initial), /already exists/, 'same pool twice');

// ---- active: manager console
await skip(601);
await act.checkpoint(keeper, key);
s = await snapshot(net, seed.id, key);
ok(s.status === 'active', 'auction over: active');
const ts = key.tickSpacing;
const lo = Math.floor((s.twap - 600) / ts) * ts, hi = Math.ceil((s.twap + 600) / ts) * ts;
await refuses(act.rebalance(m2, key, lo, hi, s.m.liquidity), /Only the hired manager/, 'rebalance by a non-manager');
await refuses(act.rebalance(m1, key, s.twap - 60 - ((s.twap - 60) % ts), hi, s.m.liquidity), /minHalfWidth/, 'range too narrow (RangeMissesTwap)');
await refuses(act.rebalance(m1, key, lo, hi, s.m.terms.minLiquidity - 1n), /depth floor/, 'below the floor (TooShallow)');
await refuses(act.rebalance(m1, key, lo, hi, (s.m.liquidity * 110n) / 100n), /Growth is capped/, '+10% growth (GrowTooFast)');
await act.rebalance(m1, key, lo, hi, s.m.liquidity);
s = await snapshot(net, seed.id, key);
ok(s.m.tickLower === lo && s.m.tickUpper === hi, `rebalance to [${lo}, ${hi}]`);
await skip(1);
await act.rebalance(m1, key, lo, hi, (s.m.liquidity * 105n) / 100n);
s = await snapshot(net, seed.id, key);
ok(true, `rebalance +5% growth: liquidity ${s.m.liquidity}`);
await skip(1);
await refuses(act.rebalance(m1, key, lo, hi, (s.m.liquidity * 104n) / 100n), /Growth is capped/, 'second growth inside one TWAP window');
await refuses(act.setFee(m1, key, 20_000), /above the mandate's cap/, 'setFee 2% (FeeTooHigh)');
await refuses(act.setFee(m1, key, 100), /below the mandate's floor/, 'setFee 0.01% (FeeTooLow)');
await act.setFee(m1, key, 3_000);
ok((await snapshot(net, seed.id, key)).lpFee === 3_000, 'setFee 0.30%');

// ---- settle, close, claim
await refuses(act.settle(keeper, key, 0), /Too early/, 'settle epoch 1 early (NotEnded)');
await skip(3_600);
await refuses(act.settle(keeper, key, 1), /in order/, 'settle epoch 2 before 1 (BadEpoch)');
await act.settle(keeper, key, 0);
const recs = await epochRecords(net, seed.id, 3);
ok(recs[0].settled && recs[0].clean, `epoch 1 settled clean (${recs[0].inSecs}s in, ${recs[0].outSecs}s out)`);
ok((await trackRecord(net, m1.account)).clean === 1, 'manager #1 track record: 1 clean');
await refuses(act.close(m1, key), /Only the treasury/, 'close by the manager');
await refuses(act.close(treasury, key), /Too early/, 'close before the end');
await skip(7_200);
await act.close(treasury, key);
s = await snapshot(net, seed.id, key);
ok(s.m.closed && s.m.idle0 === 0n && s.m.idle1 === 0n, 'close: mandate closed, ledger emptied to the treasury');
const mOwed = await owed(net, m1.account, usdc);
ok(mOwed >= 2_000n * U, `manager #1 owed ${mOwed} (bond back plus pay)`);
await act.claim(m1, usdc);
ok((await owed(net, m1.account, usdc)) === 0n, 'manager #1 claims');
await refuses(act.checkpoint(keeper, key), /closed/, 'checkpoint after close (MandateClosed)');

console.log(fails ? `\n${fails} FAILED` : '\nall writes verified');
if (fails) throw new Error(`${fails} checks failed`);

function tok(a: Address) { return token(net, a); }
