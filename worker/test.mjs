// Run with: node worker/test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const asModule = code => `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
const source = read('./src/index.js').replace('./security.js', asModule(read('./src/security.js')));
const worker = (await import(asModule(source))).default;

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
  for (let i = 0; i < 25; i++) statuses.push((await call(env, 'https://api.wrk.money/auth/login', { method: 'POST', body: '{}' })).status);
  assert.equal(statuses.filter(s => s === 429).length, 5);

  // Reads aren't counted: one page view fetches many avatars and files.
  const reads = [];
  for (let i = 0; i < 40; i++) reads.push((await call(env, 'https://api.wrk.money/motd')).status);
  assert.equal(reads.filter(s => s === 429).length, 0);

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

// Appearance options keep good values and refuse anything else.
{
  const env = makeEnv({
    'user:foo': JSON.stringify({ username: 'foo', slug: 'foo', salt: 's', passwordHash: await sha256Hex('s' + 'pw') }),
    'profile:foo': JSON.stringify({ slug: 'foo', avatarShape: 'circle', status: 'kept' }),
  });
  const { token } = await (await post(env, '/auth/login', { username: 'foo', password: 'pw' })).json();
  const save = async fields => (await call(env, 'https://api.wrk.money/profile/foo', {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ displayName: 'foo', avatar: 'a.png', bioStatements: ['hi'], ...fields }),
  })).json();

  const untouched = await save({});
  assert.equal(untouched.avatarShape, 'circle', 'older clients keep saved options');
  assert.equal(untouched.status, 'kept');

  const good = await save({ avatarShape: 'rounded', corners: 'round', cardStyle: 'clear', buttonStyle: 'solid', font: 'pixel', nameEffect: 'money', nameColor: '#85bb65', status: 'x'.repeat(90), enterText: 'y'.repeat(90), hideVisits: true, hideUid: 1, bgOpacity: 140, musicVolume: -5 });
  assert.equal(good.avatarShape, 'rounded');
  assert.equal(good.font, 'pixel');
  assert.equal(good.nameColor, '#85bb65');
  assert.equal(good.status.length, 60);
  assert.equal(good.enterText.length, 30);
  assert.equal(good.hideUid, true);
  assert.equal(good.bgOpacity, 100);
  assert.equal(good.musicVolume, 0);

  const named = await save({ aka: [' wrk ', '', 7, 'z'.repeat(40), ...Array(20).fill('x')] });
  assert.equal(named.aka[0], 'wrk');
  assert.equal(named.aka[1].length, 24);
  assert.equal(named.aka.length, 12);
  assert.equal((await save({})).aka.length, 12, 'older clients keep saved akas');
  assert.equal((await save({ aka: [] })).aka.length, 0, 'akas can be cleared');

  const bad = await save({ avatarShape: 'url(evil)', font: 'x}body{display:none', nameEffect: 'nope', nameColor: 'red;}body{display:none', bgOpacity: 'lots', status: null });
  assert.equal(bad.avatarShape, 'rounded', 'unknown choices keep the saved one');
  assert.equal(bad.font, 'pixel');
  assert.equal(bad.nameEffect, 'money');
  assert.equal(bad.nameColor, null);
  assert.equal(bad.bgOpacity, 100);
  assert.equal(bad.status, '');
}

// Profile styles only ever contain known values, even from a tampered profile.
{
  const page = {};
  vm.runInNewContext(read('../wrk_files/profile.js'), page);
  assert.equal(page.formatAka(['a']), 'aka a');
  assert.equal(page.formatAka(['a', 'b']), 'aka a & b');
  assert.equal(page.formatAka(['a', 'b', 'c']), 'aka a, b, & c');
  assert.equal(page.formatAka([]), '');
  assert.equal(page.formatAka(undefined), '');
  const timers = [];
  const tab = { document: {}, setTimeout: step => timers.push(step) };
  vm.runInNewContext(read('../wrk_files/profile.js'), tab);
  tab.startTabTitle(['ab', 'c']);
  const titles = [tab.document.title];
  while (titles.length < 12) { timers.shift()(); titles.push(tab.document.title); }
  assert.equal(titles.join(' '), '@ @a @ab @ab @a @ @ @c @c @ @ @a');

  const clean = page.profileCss({});
  assert.ok(clean.includes('--profile-accent:#ffffff'));
  const hostile = page.profileCss({ avatarShape: 'x}body{display:none', font: 'x}body{display:none', accentColor: '#000}body{display:none', nameColor: 'red}', corners: '1px;}', bgOpacity: '1}' });
  assert.equal(hostile, clean);
  assert.ok(page.profileCss({ bgOpacity: 250 }).includes('#bg-media{opacity:1}'));
  assert.ok(page.profileCss({ accentColor: '#ff0000', buttonStyle: 'solid' }).includes('color:#ffffff'), 'dark buttons get light text');
  assert.ok(page.profileCss({ accentColor: '#85bb65', buttonStyle: 'solid' }).includes('color:#08090c'), 'light buttons get dark text');
}

// Saved links must be safe, and bare domains are completed.
{
  const env = makeEnv({
    'user:foo': JSON.stringify({ username: 'foo', slug: 'foo', salt: 's', passwordHash: await sha256Hex('s' + 'pw') }),
    'profile:foo': JSON.stringify({ slug: 'foo' }),
  });
  const { token } = await (await post(env, '/auth/login', { username: 'foo', password: 'pw' })).json();
  const save = fields => call(env, 'https://api.wrk.money/profile/foo', {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ displayName: 'foo', avatar: 'https://a.example/a.png', bioStatements: ['hi'], ...fields }),
  });
  const button = url => ({ tabs: [{ label: 'links', buttons: [{ text: 'go', type: 'link', url }] }] });

  const good = await (await save(button('t.me/name'))).json();
  assert.equal(good.tabs[0].buttons[0].url, 'https://t.me/name');
  assert.equal((await (await save(button('mailto:hi@example.com'))).json()).tabs[0].buttons[0].url, 'mailto:hi@example.com');
  assert.equal((await save({ avatar: '/wrk_files/pulsepfp.png' })).status, 200);

  for (const bad of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'java\tscript:alert(1)', ' javascript:alert(1)', 'data:text/html,x', 'vbscript:x']) {
    assert.equal((await save(button(bad))).status, 400, bad);
  }
  for (const field of ['avatar', 'ogImage', 'bgUrl']) assert.equal((await save({ [field]: 'javascript:alert(1)' })).status, 400, field);
  assert.equal((await save({ musicEnabled: true, musicUrl: 'data:audio/wav,x' })).status, 400);
  assert.equal((await save({ avatar: 'mailto:a@b.c' })).status, 400, 'media must be http');
}

// Sessions last a week, renew while used, and stop at the 30-day limit.
{
  const env = makeEnv({
    'user:foo': JSON.stringify({ username: 'foo', slug: 'foo', salt: 's', passwordHash: await sha256Hex('s' + 'pw') }),
    'profile:foo': JSON.stringify({ slug: 'foo' }),
  });
  const claims = t => JSON.parse(Buffer.from(t.split('.')[1], 'base64url'));
  const { token } = await (await post(env, '/auth/login', { username: 'foo', password: 'pw' })).json();
  const day = 60 * 60 * 24;
  const fresh = claims(token);
  assert.ok(Math.abs(fresh.exp - fresh.born - 7 * day) < 5);

  const me = async t => (await call(env, 'https://api.wrk.money/auth/me', { headers: { Authorization: `Bearer ${t}` } })).json();
  assert.equal((await me(token)).token, undefined, 'a new token is not renewed');

  const realNow = Date.now;
  Date.now = () => realNow() + 2 * day * 1000;
  const renewed = claims((await me(token)).token);
  assert.equal(renewed.born, fresh.born, 'renewal keeps the original login time');
  assert.ok(renewed.exp > fresh.exp);

  // A chain of renewals can't pass the limit from the first login.
  let current = token;
  for (let d = 6; d <= 36; d += 6) {
    Date.now = () => realNow() + d * day * 1000;
    const answer = await me(current);
    if (answer.error) { assert.ok(d >= 30); break; }
    current = answer.token || current;
    assert.ok(claims(current).exp <= fresh.born + 30 * day);
  }
  Date.now = () => realNow() + 31 * day * 1000;
  assert.equal((await call(env, 'https://api.wrk.money/auth/me', { headers: { Authorization: `Bearer ${current}` } })).status, 401);
  Date.now = realNow;
}

// Pages get security headers and a nonce on every script, but a 304 keeps the cached page's policy.
{
  const added = [];
  globalThis.HTMLRewriter = class {
    on(selector, handler) { added.push([selector, handler]); return this; }
    transform(res) { return res; }
  };
  const env = makeEnv();
  let originEncoding = 'unset';
  globalThis.fetch = async request => {
    originEncoding = request.headers.get('Accept-Encoding');
    return new Response('<script></script>', { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  };
  const html = await call(env, 'https://wrk.money/some-page', { headers: { 'Accept-Encoding': 'gzip, br' } });
  assert.equal(originEncoding, null, 'the origin must not send brotli, which the rewriter cannot read');
  const policy = html.headers.get('Content-Security-Policy');
  assert.match(policy, /script-src 'nonce-[0-9a-f]{32}' 'strict-dynamic'/);
  assert.match(policy, /frame-ancestors 'none'/);
  assert.equal(html.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.equal(added[0][0], 'script');
  const tag = { attrs: {}, setAttribute(name, value) { this.attrs[name] = value; } };
  added[0][1].element(tag);
  assert.ok(policy.includes(`nonce-${tag.attrs.nonce}`), 'scripts carry the same nonce as the policy');

  const second = await call(env, 'https://wrk.money/some-page');
  assert.notEqual(second.headers.get('Content-Security-Policy'), policy, 'each load gets a new nonce');

  globalThis.fetch = async () => new Response(null, { status: 304, headers: { ETag: 'x' } });
  const cached = await call(env, 'https://wrk.money/some-page');
  assert.equal(cached.status, 304);
  assert.equal(cached.headers.get('Content-Security-Policy'), null);

  globalThis.fetch = async () => new Response('body{}', { headers: { 'Content-Type': 'text/css' } });
  const asset = await call(env, 'https://wrk.money/wrk_files/site.css');
  assert.equal(asset.headers.get('X-Frame-Options'), 'DENY');
  assert.equal(asset.headers.get('Content-Security-Policy'), null);
  globalThis.fetch = realFetch;
}

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
