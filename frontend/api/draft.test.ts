// node api/draft.test.ts — the handler's error paths with a stand-in fetch (no key, no network), and the UI fill:
// the recorded sample draft through applyDraft and plan(), as the page does it.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { draft, Draft } from './draft.ts';
import { applyDraft, defaultForm, plan } from '../src/app/plan.ts';

const sample = JSON.parse(readFileSync(new URL('./draft.sample.json', import.meta.url), 'utf8'));
const reply = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as typeof fetch;
const chat = (content: string, finish_reason = 'stop') => reply(200, { choices: [{ finish_reason, message: { content } }] });
const ask = { requirements: 'Sell 10% of 1M TKN over a quarter', context: {} };
const run = async (fetch: typeof globalThis.fetch, key = 'test-key', input: unknown = ask) => draft(input, { key, fetch });

assert.equal((await draft(ask, {})).status, 503, 'no key: 503');
assert.match(JSON.stringify((await draft(ask, {})).body), /OPENROUTER_API_KEY/);
assert.equal((await run(chat('{}'), 'k', { requirements: ' ' })).status, 400, 'empty requirements: 400');
assert.equal((await run(reply(401, {}))).status, 503, '401: 503 key invalid');
assert.equal((await run(reply(402, {}))).status, 503, '402: out of credits');
assert.equal((await run(reply(429, {}))).status, 429, '429: busy');
assert.equal((await run(reply(500, {}))).status, 502, '500: 502');
assert.equal((await run((async () => { throw new TypeError('offline'); }) as typeof fetch)).status, 502, 'network error: 502');
assert.equal((await run(chat(JSON.stringify(sample), 'length'))).status, 502, 'finish_reason length: 502');
assert.equal((await run(chat('not json'))).status, 502, 'unparseable content: 502');
assert.equal((await run(chat(JSON.stringify({ ...sample, epochs: { value: 'twelve', why: '' } })))).status, 502, 'off-schema: 502');
const good = await run(chat(JSON.stringify(sample)));
assert.equal(good.status, 200, 'valid draft: 200');
assert.deepEqual((good.body as { draft: Draft }).draft, Draft.parse(sample));

// the request it sends: model, strict schema, the key only in the header
let sent: { url: string; init: RequestInit } | undefined;
await draft(ask, { key: 'k', fetch: (async (url: string, init: RequestInit) => { sent = { url, init }; return new Response('{}'); }) as unknown as typeof fetch });
const body = JSON.parse(String(sent!.init.body));
assert.equal(body.model, 'anthropic/claude-haiku-5.5');
assert.equal(body.response_format.json_schema.strict, true);
assert.equal(body.response_format.json_schema.schema.additionalProperties, false);
assert.deepEqual(body.response_format.json_schema.schema.required.sort(), Object.keys(Draft.shape).sort());
assert.equal((sent!.init.headers as Record<string, string>).Authorization, 'Bearer k');
assert.ok(!String(sent!.init.body).includes('Bearer'), 'key not in the body');

// UI fill: sample → form → plan, with stand-in token metadata
const tkn = '0x1111111111111111111111111111111111111111', usd = '0x2222222222222222222222222222222222222222';
const { form, why } = applyDraft(defaultForm(tkn, usd), Draft.parse(sample));
assert.equal(form.token, tkn, 'addresses the draft left null are kept');
assert.equal(form.maxFeePct, '0.5'); assert.equal(form.epochHours, 168); assert.equal(form.minBond, '25000');
assert.ok(why.minBond && !why.token, 'reasons only for fields the draft set');
const p = plan(form, '0x3333333333333333333333333333333333333333', { address: tkn, symbol: 'TKN', decimals: 18 }, { address: usd, symbol: 'USDC', decimals: 6 }, 1_700_000_000);
assert.ok('key' in p && p.problems.length === 0, `sample draft passes plan: ${p.problems.join('; ')}`);
const thin = plan({ ...form, anchorPct: 5 }, '0x3333333333333333333333333333333333333333', { address: tkn, symbol: 'TKN', decimals: 18 }, { address: usd, symbol: 'USDC', decimals: 6 }, 1_700_000_000);
assert.ok(thin.at.anchorPct, 'a thin anchor is flagged at its field');
console.log('draft: all checks pass');
