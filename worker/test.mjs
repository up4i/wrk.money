// Run with: node worker/test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const source = Buffer.from(read('./src/index.js')).toString('base64');
const worker = (await import(`data:text/javascript;base64,${source}`)).default;

function makeEnv(seed = {}) {
  const store = new Map(Object.entries(seed));
  const calls = { get: 0, put: 0 };
  return {
    store, calls,
    JWT_SECRET: 'test-jwt', ADMIN_SECRET: 'test-admin', ALLOWED_ORIGIN: 'https://wrk.money',
    WRK_KV: {
      async get(key, opts) {
        calls.get++;
        const value = store.get(key) ?? null;
        return opts?.type === 'json' && value ? JSON.parse(value) : value;
      },
      async put(key, value) { calls.put++; store.set(key, value); },
      async delete(key) { store.delete(key); },
    },
  };
}

// Runs a request and waits for any ctx.waitUntil work, like the runtime does.
async function call(env, url, init = {}) {
  const pending = [];
  const res = await worker.fetch(new Request(url, init), env, { waitUntil: p => pending.push(p) });
  await Promise.all(pending);
  return res;
}

const post = (env, path, body, headers = {}) => call(env, `https://api.wrk.money${path}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
});

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

const realFetch = globalThis.fetch;

// Static files never touch KV or the rate limit; short links and the API do.
{
  const env = makeEnv();
  globalThis.fetch = async () => new Response('asset');
  for (let i = 0; i < 25; i++) {
    const res = await call(env, 'https://wrk.money/wrk_files/badge-developer.svg');
    assert.equal(res.status, 200);
  }
  assert.deepEqual(env.calls, { get: 0, put: 0 });

  const statuses = [];
  for (let i = 0; i < 25; i++) statuses.push((await call(env, 'https://api.wrk.money/motd')).status);
  assert.equal(statuses.filter(s => s === 429).length, 5);

  const limited = makeEnv({ 's:abc': 'https://example.com' });
  const short = [];
  for (let i = 0; i < 25; i++) short.push((await call(limited, 'https://wrk.money/s/abc', { redirect: 'manual' })).status);
  assert.equal(short.filter(s => s === 302).length, 20);
  assert.equal(short.filter(s => s === 429).length, 5);
}

// A KV write failure can't take the site down.
{
  const env = makeEnv({ 'visits:foo': '4' });
  env.WRK_KV.put = async () => { throw new Error('KV put() limit exceeded for the day'); };
  const res = await post(env, '/visit/foo', {});
  assert.equal(res.status, 200);
  assert.equal((await res.json()).visits, 5);
}

// Old SHA-256 accounts log in, upgrade to PBKDF2, and keep working.
{
  const passwordHash = await sha256Hex('salty' + 'correct horse');
  const user = { username: 'old', slug: 'old', salt: 'salty', passwordHash };
  const env = makeEnv({ 'user:old': JSON.stringify(user) });

  assert.equal((await post(env, '/auth/login', { username: 'old', password: 'wrong' })).status, 401);
  assert.equal(JSON.parse(env.store.get('user:old')).passwordHash, passwordHash, 'failed login must not upgrade');

  assert.equal((await post(env, '/auth/login', { username: 'old', password: 'correct horse' })).status, 200);
  const upgraded = JSON.parse(env.store.get('user:old'));
  assert.match(upgraded.passwordHash, /^pbkdf2\$100000\$[0-9a-f]{64}$/);
  assert.equal(upgraded.slug, 'old');

  assert.equal((await post(env, '/auth/login', { username: 'old', password: 'correct horse' })).status, 200);
  assert.equal((await post(env, '/auth/login', { username: 'old', password: 'wrong' })).status, 401);
}

// The upgrade's slow hashing only starts once the response is ready.
{
  const passwordHash = await sha256Hex('s' + 'pw');
  const env = makeEnv({ 'user:old': JSON.stringify({ username: 'old', slug: 'old', salt: 's', passwordHash }) });
  const order = [];
  const deriveBits = crypto.subtle.deriveBits;
  crypto.subtle.deriveBits = function (...args) { order.push('hash'); return deriveBits.apply(this, args); };

  const pending = [];
  const req = new Request('https://api.wrk.money/auth/login', {
    method: 'POST', body: JSON.stringify({ username: 'old', password: 'pw' }),
  });
  await worker.fetch(req, env, { waitUntil: p => pending.push(p) });
  order.push('response');
  await Promise.all(pending);
  delete crypto.subtle.deriveBits;

  assert.deepEqual(order, ['response', 'hash']);
}

// A failed upgrade doesn't block the login that triggered it.
{
  const passwordHash = await sha256Hex('s' + 'pw');
  const env = makeEnv({ 'user:old': JSON.stringify({ username: 'old', slug: 'old', salt: 's', passwordHash }) });
  env.WRK_KV.put = async () => { throw new Error('KV put() limit exceeded for the day'); };
  const pending = [];
  const req = new Request('https://api.wrk.money/auth/login', {
    method: 'POST', body: JSON.stringify({ username: 'old', password: 'pw' }),
  });
  const res = await worker.fetch(req, env, { waitUntil: p => pending.push(p) });
  assert.equal(res.status, 200);
  assert.equal(pending.length, 1);
  await assert.rejects(pending[0]);
  assert.equal(JSON.parse(env.store.get('user:old')).passwordHash, passwordHash);
}

// New accounts are stored as PBKDF2 straight away.
{
  const env = makeEnv();
  const res = await post(env, '/auth/register', { username: 'fresh', password: 'longenough' }, { Authorization: 'Bearer test-admin' });
  assert.equal(res.status, 201);
  assert.match(JSON.parse(env.store.get('user:fresh')).passwordHash, /^pbkdf2\$/);
  assert.equal((await post(env, '/auth/login', { username: 'fresh', password: 'longenough' })).status, 200);
}

// Gift links are normalised, fake ones rejected, and outages don't block saves.
{
  const profile = { slug: 'foo', tgGiftUrl: 'https://t.me/nft/ScaredCat-845' };
  const env = makeEnv({
    'user:foo': JSON.stringify({ username: 'foo', slug: 'foo', salt: 's', passwordHash: await sha256Hex('s' + 'pw') }),
    'profile:foo': JSON.stringify(profile),
  });
  const { token } = await (await post(env, '/auth/login', { username: 'foo', password: 'pw' })).json();

  const lookups = [];
  let fragment = async () => new Response('{}');
  globalThis.fetch = async url => { lookups.push(String(url)); return fragment(); };

  const save = tgGiftUrl => call(env, 'https://api.wrk.money/profile/foo', {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ displayName: 'foo', avatar: 'a.png', bioStatements: ['hi'], tgGiftUrl }),
  });

  assert.equal((await save('https://t.me/nft/ScaredCat-845')).status, 200);
  assert.equal(lookups.length, 0, 'unchanged gift needs no lookup');

  const pasted = await (await save('t.me/nft/SnoopDogg-4405?ref=1')).json();
  assert.equal(pasted.tgGiftUrl, 'https://t.me/nft/SnoopDogg-4405');
  assert.equal(lookups.at(-1), 'https://nft.fragment.com/gift/snoopdogg-4405.json');

  fragment = async () => new Response('nope', { status: 404 });
  assert.equal((await save('https://t.me/nft/ScaredCat-99999999')).status, 400);
  assert.equal(JSON.parse(env.store.get('profile:foo')).tgGiftUrl, 'https://t.me/nft/SnoopDogg-4405');

  fragment = async () => { throw new Error('fragment down'); };
  assert.equal((await save('https://t.me/nft/JesterHat-27112')).status, 200);

  assert.equal((await save('https://evil.example/nft/Foo-1')).status, 400);

  const cleared = await (await save('')).json();
  assert.equal(cleared.tgGiftUrl, null);
}

globalThis.fetch = realFetch;

// The shared browser script accepts what the worker accepts.
{
  const page = {};
  vm.runInNewContext(read('../wrk_files/gift.js'), page);
  const gift = page.parseGift('https://t.me/nft/ScaredCat-16534');
  assert.equal(gift.url, 'https://t.me/nft/ScaredCat-16534');
  assert.equal(gift.label, 'Scared Cat #16534');
  assert.equal(gift.image, 'https://nft.fragment.com/gift/scaredcat-16534.webp');
  assert.equal(gift.lottie, 'https://nft.fragment.com/gift/scaredcat-16534.lottie.json');
  assert.equal(page.parseGift('t.me/nft/SnoopDogg-4405?ref=1').url, 'https://t.me/nft/SnoopDogg-4405');
  for (const bad of [null, '', 'https://evil.example/nft/Foo-1', 'https://t.me/nft/Foo', 'https://t.me/nft/Fo"o-1'])
    assert.equal(page.parseGift(bad), null);

  const card = { w: 512, layers: [{ nm: 'Gift', ks: { s: { k: [63, 63, 100] } } }, { nm: 'Pattern' }, { nm: 'Color Icon' }, { nm: 'Background' }] };
  const model = page.giftModelOnly(card);
  assert.equal(model.w, 512);
  assert.equal(model.layers.map(l => l.nm).join(), 'Gift');
  assert.equal(model.layers[0].ks.s.k.join(), '100,100,100');
  assert.throws(() => page.giftModelOnly({ layers: [{ nm: 'Background' }] }));
}

// Login only sends people to same-site paths: a javascript: link would run with their token.
{
  const rule = eval(read('../login/index.html').match(/const _redirectTo = (\/\^.*?\/)\.test\(_from\)/)[1]);
  for (const safe of ['/tools', '/tools/pastebin', '/settings', '/$'])
    assert.ok(rule.test(safe), safe);
  for (const bad of ['', 'javascript:alert(1)', 'JaVaScRiPt:alert(1)', ' javascript:alert(1)', '//evil.example', '/\\evil.example', 'https://evil.example', 'data:text/html,x'])
    assert.ok(!rule.test(bad), bad);
}

console.log('all checks passed');
