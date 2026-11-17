// Run with: node worker/test.mjs
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import vm from 'node:vm';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const asModule = code => `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
const security = asModule(read('./src/security.js'));
const giftsModule = asModule(read('./src/gifts.js'));
const source = read('./src/index.js').replace('./security.js', security).replace('./prefs.js', asModule(read('./src/prefs.js').replace('./security.js', security))).replace('./gifts.js', giftsModule);
const worker = (await import(asModule(source))).default;
const gifts = await import(giftsModule);

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
      async list({ prefix }) { return { keys: [...store.keys()].filter(k => k.startsWith(prefix)).map(name => ({ name })) }; },
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

// Claiming and resetting both need a one-time code from the admin.
{
  const admin = { Authorization: 'Bearer test-admin' };
  const env = makeEnv();
  await post(env, '/auth/register', { username: 'fresh' }, admin);
  const newCode = async username => (await (await post(env, '/admin/code', { username }, admin)).json()).code;
  const setup = body => post(env, '/auth/setup', body);
  const logIn = password => post(env, '/auth/login', { username: 'fresh', password });
  const me = token => call(env, 'https://api.wrk.money/auth/me', { headers: { Authorization: `Bearer ${token}` } });

  assert.equal((await setup({ slug: 'fresh', password: 'longenough' })).status, 400, 'the old open claim is gone');
  assert.equal((await setup({ username: 'fresh', password: 'longenough' })).status, 400);
  assert.equal(JSON.parse(env.store.get('user:fresh')).passwordHash, null);

  assert.equal((await post(env, '/admin/code', { username: 'fresh' })).status, 403);
  assert.equal((await post(env, '/admin/code', { username: 'fresh' }, { Authorization: 'Bearer nope' })).status, 403);
  assert.equal((await post(env, '/admin/code', { username: 'nobody' }, admin)).status, 404);

  const first = await newCode('fresh');
  assert.match(first, /^[A-HJKMNP-Z2-9]{10}$/);
  assert.ok(!env.store.get('code:fresh').includes(first), 'codes are stored hashed');

  const wrong = await setup({ username: 'fresh', code: 'AAAAA-AAAAA', password: 'longenough' });
  const unknown = await setup({ username: 'nobody', code: first, password: 'longenough' });
  assert.equal(wrong.status, 401);
  assert.equal(unknown.status, 401);
  assert.deepEqual(await wrong.json(), await unknown.json(), 'a stranger learns nothing about which part failed');

  assert.equal((await setup({ username: 'fresh', code: first, password: 'short' })).status, 400);
  assert.equal((await setup({ username: 'fresh', code: first, password: 12345678 })).status, 400);

  const claimed = await setup({ username: ' Fresh ', code: `${first.slice(0, 5).toLowerCase()}-${first.slice(5)}`, password: 'first password' });
  assert.equal(claimed.status, 200);
  assert.equal((await claimed.json()).firstTime, true);
  assert.equal(env.store.has('code:fresh'), false, 'a used code is gone');
  assert.equal(env.store.has('revoked:fresh'), false, 'claiming has no old sessions to end');
  assert.equal((await setup({ username: 'fresh', code: first, password: 'stolen password' })).status, 401, 'a code works once');

  const oldToken = (await (await logIn('first password')).json()).token;
  assert.equal((await me(oldToken)).status, 200);
  const realNow = Date.now;
  Date.now = () => realNow() + 5000;

  const reset = await setup({ username: 'fresh', code: await newCode('fresh'), password: 'second password' });
  assert.equal(reset.status, 200);
  const { token: newToken, firstTime } = await reset.json();
  assert.equal(firstTime, false);
  assert.match(JSON.parse(env.store.get('user:fresh')).passwordHash, /^pbkdf2\$/);
  assert.equal((await logIn('first password')).status, 401);
  assert.equal((await logIn('second password')).status, 200);
  assert.equal((await me(oldToken)).status, 401, 'a reset ends older sessions');
  assert.equal((await me(newToken)).status, 200);
  Date.now = realNow;
}

// Wrong tries and time both end a code, and a new code replaces the old one.
{
  const admin = { Authorization: 'Bearer test-admin' };
  const env = makeEnv();
  await post(env, '/auth/register', { username: 'fresh' }, admin);
  const newCode = async () => (await (await post(env, '/admin/code', { username: 'fresh' }, admin)).json()).code;
  const setup = code => post(env, '/auth/setup', { username: 'fresh', code, password: 'longenough' });

  const code = await newCode();
  for (let i = 0; i < 5; i++) assert.equal((await setup('AAAAA-AAAAA')).status, 401);
  assert.equal((await setup(code)).status, 401, 'the right code is dead after too many tries');

  const late = await newCode();
  env.store.set('code:fresh', JSON.stringify({ ...JSON.parse(env.store.get('code:fresh')), expires: Date.now() - 1 }));
  assert.equal((await setup(late)).status, 401);

  const replaced = await newCode();
  await newCode();
  assert.equal((await setup(replaced)).status, 401);
  assert.equal(JSON.parse(env.store.get('user:fresh')).passwordHash, null);
}

// A name stored with capitals can claim and log in, and deleting an account ends its code.
{
  const admin = { Authorization: 'Bearer test-admin' };
  const env = makeEnv();
  await post(env, '/auth/register', { username: 'MixedCase', slug: 'mixed' }, admin);
  const { code } = await (await post(env, '/admin/code', { username: 'MixedCase' }, admin)).json();
  assert.equal((await post(env, '/auth/setup', { username: 'MixedCase', code, password: 'longenough' })).status, 200);
  assert.equal((await post(env, '/auth/login', { username: 'MixedCase', password: 'longenough' })).status, 200);

  await post(env, '/admin/code', { username: 'MixedCase' }, admin);
  await call(env, 'https://api.wrk.money/admin/user/mixed', { method: 'DELETE', headers: admin });
  assert.equal(env.store.has('code:mixed'), false);
}

// Members type the name they remember: any capitals, or the end of their profile link.
{
  const admin = { Authorization: 'Bearer test-admin' };
  const env = makeEnv();
  await post(env, '/auth/register', { username: 'Pulse', slug: '$$$' }, admin);
  await post(env, '/auth/register', { username: 'Other', slug: 'pulsar' }, admin);
  const newCode = async () => (await (await post(env, '/admin/code', { username: 'Pulse' }, admin)).json()).code;

  for (const username of ['Pulse', 'pulse', 'PULSE', ' $$$ ']) {
    const res = await post(env, '/auth/setup', { username, code: await newCode(), password: 'longenough' });
    assert.equal(res.status, 200, `setup as ${username}`);
    assert.equal((await res.json()).slug, '$$$');
    assert.equal((await post(env, '/auth/login', { username, password: 'longenough' })).status, 200, `login as ${username}`);
  }
  assert.equal((await post(env, '/auth/login', { username: 'nobody', password: 'longenough' })).status, 401);
  assert.equal((await post(env, '/auth/setup', { username: 'other', code: await newCode(), password: 'longenough' })).status, 401, "a code is only good for its own account");
}

// A location still caching an old code can refuse a new one, but must not bring the old one back.
{
  const admin = { Authorization: 'Bearer test-admin' };
  const env = makeEnv();
  await post(env, '/auth/register', { username: 'fresh' }, admin);
  const newCode = async () => (await (await post(env, '/admin/code', { username: 'fresh' }, admin)).json()).code;
  const setup = code => post(env, '/auth/setup', { username: 'fresh', code, password: 'longenough' });

  await newCode();
  const cached = JSON.parse(env.store.get('code:fresh'));
  const code = await newCode();
  const realGet = env.WRK_KV.get;
  env.WRK_KV.get = async (key, opts) => key === 'code:fresh' ? cached : realGet(key, opts);
  assert.equal((await setup(code)).status, 401);
  env.WRK_KV.get = realGet;
  assert.equal((await setup(code)).status, 200, 'the new code works once the location catches up');
}

// Copying the admin page's whole line still gives the code.
{
  const admin = { Authorization: 'Bearer test-admin' };
  const env = makeEnv();
  await post(env, '/auth/register', { username: 'fresh' }, admin);
  const { code } = await (await post(env, '/admin/code', { username: 'fresh' }, admin)).json();
  const pasted = `${code} · works once, for 1 hour · they enter it at wrk.money/setup\n`;
  assert.equal((await post(env, '/auth/setup', { username: 'fresh', code: pasted, password: 'longenough' })).status, 200);
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

  const save = (tgGiftUrl, pinnedGifts) => call(env, 'https://api.wrk.money/profile/foo', {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ displayName: 'foo', avatar: 'a.png', bioStatements: ['hi'], tgGiftUrl, pinnedGifts }),
  });

  assert.equal((await save('https://t.me/nft/ScaredCat-845')).status, 200);
  assert.equal(lookups.length, 0, 'unchanged gift needs no lookup');

  const pasted = await (await save('t.me/nft/SnoopDogg-4405?ref=1')).json();
  assert.equal(pasted.tgGiftUrl, 'https://t.me/nft/SnoopDogg-4405');
  assert.equal(lookups.at(-1), 'https://nft.fragment.com/gift/snoopdogg-4405.webp');

  fragment = async () => new Response('nope', { status: 404 });
  assert.equal((await save('https://t.me/nft/ScaredCat-99999999')).status, 400);
  assert.equal(JSON.parse(env.store.get('profile:foo')).tgGiftUrl, 'https://t.me/nft/SnoopDogg-4405');

  fragment = async () => { throw new Error('fragment down'); };
  assert.equal((await save('https://t.me/nft/JesterHat-27112')).status, 200);

  assert.equal((await save('https://evil.example/nft/Foo-1')).status, 400);

  const cleared = await (await save('')).json();
  assert.equal(cleared.tgGiftUrl, null);

  // Pinned gifts follow the same rules, and only new links are looked up.
  fragment = async () => new Response('{}');
  lookups.length = 0;
  const pinned = await (await save('', ['t.me/nft/ScaredCat-845?ref=1', 'https://t.me/nft/SnoopDogg-4405', 'https://t.me/nft/ScaredCat-845'])).json();
  assert.deepEqual(pinned.pinnedGifts, ['https://t.me/nft/ScaredCat-845', 'https://t.me/nft/SnoopDogg-4405']);
  assert.equal(lookups.length, 2);

  lookups.length = 0;
  assert.equal((await save('', ['https://t.me/nft/SnoopDogg-4405'])).status, 200);
  assert.deepEqual((await (await save('')).json()).pinnedGifts, ['https://t.me/nft/SnoopDogg-4405'], 'a save without the field keeps the pins');
  assert.equal(lookups.length, 0, 'saved pins need no lookup');

  assert.equal((await save('', Array.from({ length: 7 }, (_, i) => `https://t.me/nft/ScaredCat-${i + 1}`))).status, 400);
  assert.equal(lookups.length, 0, 'too many pins never reach Fragment');
  assert.equal((await save('', ['https://evil.example/nft/Foo-1'])).status, 400);
  assert.equal((await save('', [{}])).status, 400);

  fragment = async () => new Response('nope', { status: 404 });
  assert.equal((await save('', ['https://t.me/nft/SnoopDogg-4405', 'https://t.me/nft/ScaredCat-99999999'])).status, 400);
  assert.deepEqual(JSON.parse(env.store.get('profile:foo')).pinnedGifts, ['https://t.me/nft/SnoopDogg-4405']);

  fragment = async () => { throw new Error('fragment down'); };
  assert.equal((await save('', ['https://t.me/nft/JesterHat-27112'])).status, 200);
  assert.deepEqual((await (await save('', [])).json()).pinnedGifts, []);
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
  assert.equal(untouched.bgSync, undefined, 'video sync stays off until chosen');
  assert.equal((await save({ bgSync: true })).bgSync, true);
  assert.equal((await save({})).bgSync, true, 'older clients keep the sync choice');
  assert.equal((await save({ bgSync: false })).bgSync, false);
  assert.equal(good.musicVolume, 0);

  const named = await save({ aka: [' wrk ', '', 7, 'z'.repeat(40), ...Array(20).fill('x')] });
  assert.equal(named.aka[0], 'wrk');
  assert.equal(named.aka[1].length, 24);
  assert.equal(named.aka.length, 12);
  assert.equal((await save({})).aka.length, 12, 'older clients keep saved akas');
  assert.equal((await save({ aka: [] })).aka.length, 0, 'akas can be cleared');

  const lyrics = '[00:12.50] first line\n[00:15.00] second line';
  assert.equal((await save({ lyrics: `\n${lyrics}\n` })).lyrics, lyrics);
  assert.equal((await save({})).lyrics, lyrics, 'older clients keep saved lyrics');
  assert.equal((await save({ lyrics: 'x'.repeat(30000) })).lyrics.length, 20000);
  assert.equal((await save({ lyrics: '' })).lyrics, '', 'lyrics can be cleared');

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

// Timed lyrics read every common way of writing the time, and skip what isn't a timed line.
{
  const page = {};
  vm.runInNewContext(read('../wrk_files/profile.js'), page);
  const lines = page.parseLyrics('[ar:Juice WRLD]\r\n[Chorus]\n[01:02.50] later\n[00:05] first\n[00:10.123][01:30:00] twice\n\nuntimed\n[00:20.00]\n  [0:07.5]  spaced  ');
  assert.equal(JSON.stringify(lines.map(l => [l.time, l.text])), JSON.stringify([
    [5, 'first'], [7.5, 'spaced'], [10.123, 'twice'], [20, ''], [62.5, 'later'], [90, 'twice'],
  ]));
  assert.equal(page.parseLyrics(undefined).length, 0);
}

// Translations swap whole lines, fill {} in order, and keep the spaces next to a link.
{
  const page = {};
  vm.runInNewContext(read('../wrk_files/translate.js'), page);
  const t = page.makeTranslator({ 'log in': 'войти', 'log in to continue to {}.': 'войди, чтобы перейти в {}.', '{} of {} lines timed': '{} из {}', 'clear cards': 'прозрачные', 'a (b) c?': 'ok' });
  assert.equal(t('  log in\n'), '  войти\n');
  assert.equal(t('log\n   in'), 'войти', 'line breaks in the markup count as one space');
  assert.equal(t('log in to continue to $$$.'), 'войди, чтобы перейти в $$$.', 'a $ from a page name stays as it is');
  assert.equal(t('3 of 5 lines timed'), '3 из 5');
  assert.equal(t('clear', 'clear cards'), 'прозрачные');
  assert.equal(t('a (b) c?'), 'ok');
  for (const text of ['constructor', 'logged in', 'log in now', '', '   ']) assert.equal(t(text), text);
}

// Every language has the same keys as Russian, the same {} in each, and a place in the picker.
{
  const site = read('../wrk_files/site.js');
  const codes = readdirSync(new URL('../wrk_files/lang/', import.meta.url)).map(file => file.replace(/\.js$/, ''));
  const words = Object.fromEntries(codes.map(code => {
    let found;
    vm.runInNewContext(read(`../wrk_files/lang/${code}.js`), { siteTranslate: w => { found = w; } });
    return [code, found];
  }));
  const holes = text => text.split('{}').length - 1;
  assert.equal(codes.length, 9);
  for (const code of codes) {
    assert.ok(site.includes(` ${code}: '`), `${code} is in the picker`);
    assert.deepEqual(Object.keys(words[code]).sort(), Object.keys(words.ru).sort(), `${code} has the same keys as ru`);
    for (const [key, to] of Object.entries(words[code])) assert.equal(holes(to), holes(key), `${code}: ${key}`);
  }
}

// A synced background waits for the song and follows its pauses, seeks and loops.
{
  const listeners = {};
  const audio = { paused: true, currentTime: 0, addEventListener(name, fn) { (listeners[name] ??= []).push(fn); } };
  const video = {
    duration: 263, currentTime: 0, paused: true, autoplay: true, playbackRate: 1, seeking: false, seeks: 0,
    play() { this.paused = false; return Promise.resolve(); },
    pause() { this.paused = true; },
  };
  const tab = { document: { getElementById: id => id === 'bg-media' ? video : null } };
  vm.runInNewContext(read('../wrk_files/profile.js'), tab);
  const fire = name => listeners[name].forEach(fn => fn());
  const at = time => { audio.currentTime = time; fire('timeupdate'); };
  const seeking = time => { const before = video.currentTime; at(time); return video.currentTime !== before; };

  const on = { bgSync: true, bgType: 'video', musicEnabled: true, musicUrl: 'song.mp3' };
  for (const off of [{ ...on, bgSync: false }, { ...on, bgType: 'image' }, { ...on, musicEnabled: false }, { ...on, musicUrl: null }]) tab.syncBgToMusic(off, audio);
  tab.syncBgToMusic(on, null);
  assert.equal(video.autoplay, true, 'nothing changes unless every part is set');
  assert.deepEqual(listeners, {});

  tab.syncBgToMusic(on, audio);
  assert.equal(video.autoplay, false, 'the video waits for the enter click');

  audio.paused = false;
  fire('play');
  assert.equal(video.paused, false);

  video.currentTime = 10;
  assert.equal(seeking(10.1), false, 'a small gap never seeks');
  assert.ok(video.playbackRate > 1 && video.playbackRate <= 1.2, 'behind means faster');
  assert.equal(seeking(9.9), false);
  assert.ok(video.playbackRate < 1 && video.playbackRate >= 0.8, 'ahead means slower');
  at(10);
  assert.equal(video.playbackRate, 1, 'in step means normal speed');
  assert.equal(seeking(10.9), false);
  assert.equal(video.playbackRate, 1.2, 'catching up stays subtle');
  assert.equal(seeking(9.1), false);
  assert.equal(video.playbackRate, 0.8);

  assert.equal(seeking(120), true, 'a skip in the song moves the video');
  assert.equal(video.currentTime, 120);
  video.currentTime = 262.5;
  assert.equal(seeking(0.2), true, 'the song looping brings the video back');
  assert.ok(Math.abs(video.currentTime - 0.2) < 1e-9);

  video.seeking = true;
  assert.equal(seeking(100), false, 'one seek at a time, or a slow link never catches up');
  video.seeking = false;

  video.duration = 30;
  video.currentTime = 5;
  assert.equal(seeking(65), false, 'a clip shorter than the song keeps looping in step');

  audio.paused = true;
  fire('pause');
  assert.equal(video.paused, true);
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

// Site settings are private, validated, and come back at login and on every page.
{
  const env = makeEnv({
    'user:foo': JSON.stringify({ username: 'foo', slug: 'foo', salt: 's', passwordHash: await sha256Hex('s' + 'pw') }),
    'profile:foo': JSON.stringify({ slug: 'foo', displayName: 'foo' }),
  });
  const login = await (await post(env, '/auth/login', { username: 'foo', password: 'pw' })).json();
  assert.equal(login.prefs, null, 'new members have no settings yet');
  const auth = { Authorization: `Bearer ${login.token}` };
  const save = async body => (await call(env, 'https://api.wrk.money/auth/prefs', { method: 'PUT', headers: auth, body: JSON.stringify(body) })).json();

  const first = await save({ theme: 'ocean', accent: '#ff0000', background: 'calm', motion: 'reduced', clock: '24h', clockSeconds: false, suggestions: false, landing: 'tools',
    commands: [{ key: 'GH', url: 'github.com' }, { key: '?bad key', url: 'https://x.com' }, { key: 'x', url: 'javascript:alert(1)' }] });
  assert.equal(first.theme, 'ocean');
  assert.equal(first.clockSeconds, false);
  assert.equal(first.commands.length, 1, 'bad commands are dropped');
  assert.equal(first.commands[0].key, '?gh');
  assert.equal(first.commands[0].url, 'https://github.com');

  assert.equal((await save({ accent: ['#00ff00'] })).accent, '#ff0000', 'only a plain colour counts');
  const tampered = await save({ theme: 'x}body{display:none', accent: 'red;}', background: 'nope', motion: 1, landing: 'https://evil.example', extra: 'field' });
  assert.equal(tampered.theme, 'ocean', 'unknown values keep what is saved');
  assert.equal(tampered.accent, '#ff0000');
  assert.equal(tampered.landing, 'tools');
  assert.equal(tampered.extra, undefined);
  assert.equal((await save({ accent: null })).accent, null, 'a custom colour can be cleared');
  for (const background of ['winter', 'starfield', 'matrix', 'visualizer']) assert.equal((await save({ background })).background, background);

  const me = await (await call(env, 'https://api.wrk.money/auth/me', { headers: auth })).json();
  assert.equal(me.prefs.theme, 'ocean');
  assert.equal((await (await post(env, '/auth/login', { username: 'foo', password: 'pw' })).json()).prefs.landing, 'tools');

  const profile = await (await call(env, 'https://api.wrk.money/profile/foo')).json();
  assert.equal(profile.prefs, undefined, 'settings are not on the public profile');
  assert.equal((await call(env, 'https://api.wrk.money/auth/prefs', { method: 'PUT', body: '{}' })).status, 401);
}

// Suggestions come through the worker, so the visitor never talks to Google.
{
  const env = makeEnv();
  const asked = [];
  globalThis.fetch = async url => { asked.push(String(url)); return new Response(JSON.stringify(['q', ['one', 'two', 3, 'four', 'five', 'six', 'seven']])); };
  const results = await (await call(env, 'https://api.wrk.money/suggest?q=ju ice')).json();
  assert.equal(results.join(), 'one,two,four,five,six');
  assert.match(asked[0], /suggestqueries\.google\.com.*q=ju%20ice/);
  assert.equal((await (await call(env, 'https://api.wrk.money/suggest?q=j')).json()).length, 0, 'one letter asks nothing');
  assert.equal(asked.length, 1);
  globalThis.fetch = async () => { throw new Error('down'); };
  assert.equal((await (await call(env, 'https://api.wrk.money/suggest?q=juice')).json()).length, 0, 'an outage just shows nothing');
  globalThis.fetch = realFetch;
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

// A bucket that slices ranges and pages listings like R2, and only returns metadata when asked.
// A write given onlyIf.etagMatches only lands on the copy that etag came from.
function makeBucket(pageSize = 2) {
  const objects = new Map();
  return {
    objects, reads: 0, writes: 0,
    async put(key, bytes, { customMetadata, onlyIf } = {}) {
      if (onlyIf && objects.get(key)?.etag !== onlyIf.etagMatches) return null;
      const object = { bytes: typeof bytes === 'string' ? new TextEncoder().encode(bytes) : new Uint8Array(bytes), customMetadata, etag: `e${++this.writes}` };
      objects.set(key, object);
      return object;
    },
    async get(key, { range } = {}) {
      this.reads++;
      const object = objects.get(key);
      if (!object) return null;
      const { offset = 0, length = object.bytes.length } = range ?? {};
      return { body: object.bytes.slice(offset, offset + length), etag: object.etag };
    },
    async list({ cursor = '', include = [] } = {}) {
      const keys = [...objects.keys()].sort().filter(key => key > cursor);
      const page = keys.slice(0, pageSize);
      const truncated = keys.length > pageSize;
      return {
        objects: page.map(key => ({ key, ...(include.includes('customMetadata') && { customMetadata: objects.get(key).customMetadata }) })),
        truncated, ...(truncated && { cursor: page.at(-1) }),
      };
    },
    async delete(keys) { for (const key of [keys].flat()) objects.delete(key); },
    // Multipart uploads join their parts in the order given, and only with the etags R2 handed out.
    uploads: new Map(),
    async createMultipartUpload(key, { customMetadata }) {
      const uploadId = `up-${key}`;
      this.uploads.set(uploadId, { customMetadata, parts: new Map() });
      return { uploadId };
    },
    resumeMultipartUpload(key, uploadId) {
      const upload = this.uploads.get(uploadId);
      const uploads = this.uploads;
      return {
        async uploadPart(partNumber, body) {
          const bytes = new Uint8Array(await new Response(body).arrayBuffer());
          upload.parts.set(partNumber, bytes);
          return { partNumber, etag: `etag-${partNumber}-${bytes.length}`, extra: 'not for the page' };
        },
        async complete(parts) {
          const chunks = parts.map(({ partNumber, etag }) => {
            const bytes = upload.parts.get(partNumber);
            if (etag !== `etag-${partNumber}-${bytes?.length}`) throw new Error('unknown part');
            return bytes;
          });
          const bytes = new Uint8Array(await new Blob(chunks).arrayBuffer());
          objects.set(key, { bytes, customMetadata: upload.customMetadata });
          uploads.delete(uploadId);
          return { size: bytes.length };
        },
      };
    },
  };
}

async function fileEnv() {
  const env = makeEnv({ 'user:foo': JSON.stringify({ username: 'foo', slug: 'foo', salt: 's', passwordHash: await sha256Hex('s' + 'pw') }) });
  env.WRK_FILES = makeBucket();
  const { token } = await (await post(env, '/auth/login', { username: 'foo', password: 'pw' })).json();
  env.auth = { Authorization: `Bearer ${token}` };
  return env;
}

function upload(env, headers, { ttl = 'never', name = 'a.mp3', type = 'audio/mpeg', content = '0123456789' } = {}) {
  const body = new FormData();
  body.append('file', new File([content], name, { type }));
  body.append('ttl', ttl);
  return call(env, 'https://api.wrk.money/d', { method: 'POST', headers, body });
}

const getStored = (env, id, headers = {}) => call(env, `https://api.wrk.money/d/${id}`, { headers });

// Uploading needs a live session, whatever the page does.
{
  const env = await fileEnv();
  for (const headers of [{}, { Authorization: 'Bearer nope' }]) {
    const refused = await upload(env, headers);
    assert.equal(refused.status, 401);
    assert.equal(refused.headers.get('Access-Control-Allow-Origin'), 'https://wrk.money', 'the page can read the refusal');
  }
  assert.equal(env.WRK_FILES.objects.size, 0, 'a refused upload stores nothing');
  assert.equal((await upload(env, env.auth)).status, 201);

  const realNow = Date.now;
  Date.now = () => realNow() + 5000;
  env.store.set('revoked:foo', String(Math.floor(Date.now() / 1000)));
  assert.equal((await upload(env, env.auth)).status, 401, 'a reset also ends the right to upload');
  Date.now = realNow;
}

// Files answer whole, in part or as unchanged, and every answer keeps the sandbox and the cache rules.
{
  const env = await fileEnv();
  const { id } = await (await upload(env, env.auth)).json();
  const checkHeaders = res => {
    assert.equal(res.headers.get('Content-Security-Policy'), "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    assert.equal(res.headers.get('X-Content-Type-Options'), 'nosniff');
    assert.equal(res.headers.get('Content-Disposition'), 'inline; filename="a.mp3"');
    assert.equal(res.headers.get('Content-Type'), 'audio/mpeg');
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), 'https://wrk.money', 'players with crossorigin need this on a 206');
    assert.equal(res.headers.get('Accept-Ranges'), 'bytes');
    assert.equal(res.headers.get('Cache-Control'), 'public, max-age=86400');
    assert.equal(res.headers.get('ETag'), `"${id}"`);
  };

  const whole = await getStored(env, id);
  assert.equal(whole.status, 200);
  assert.equal(await whole.text(), '0123456789');
  checkHeaders(whole);

  const parts = [['bytes=2-4', '234', 'bytes 2-4/10'], ['bytes=7-', '789', 'bytes 7-9/10'], ['bytes=-2', '89', 'bytes 8-9/10'], ['bytes=0-', '0123456789', 'bytes 0-9/10'], ['bytes=4-999', '456789', 'bytes 4-9/10'], ['bytes=-999', '0123456789', 'bytes 0-9/10']];
  for (const [Range, text, contentRange] of parts) {
    const part = await getStored(env, id, { Range });
    assert.equal(part.status, 206, Range);
    assert.equal(await part.text(), text, Range);
    assert.equal(part.headers.get('Content-Range'), contentRange);
    checkHeaders(part);
  }

  for (const Range of ['bytes=10-', 'bytes=5-2', 'bytes=-0']) {
    const past = await getStored(env, id, { Range });
    assert.equal(past.status, 416, Range);
    assert.equal(past.headers.get('Content-Range'), 'bytes */10');
    assert.equal(past.headers.get('Access-Control-Allow-Origin'), 'https://wrk.money');
  }
  for (const Range of ['bytes=0-1,4-5', 'lines=1-2', 'bytes=-', 'nonsense']) {
    const ignored = await getStored(env, id, { Range });
    assert.equal(ignored.status, 200, Range);
    assert.equal(await ignored.text(), '0123456789', Range);
  }

  const reads = env.WRK_FILES.reads;
  for (const tag of [`"${id}"`, `W/"${id}"`, `"other", "${id}"`]) {
    const same = await getStored(env, id, { 'If-None-Match': tag });
    assert.equal(same.status, 304, tag);
    assert.equal(await same.text(), '');
    checkHeaders(same);
  }
  assert.equal(env.WRK_FILES.reads, reads, 'revalidating never touches R2');
  assert.equal((await getStored(env, id, { 'If-None-Match': '"other"' })).status, 200);

  // Anything but media still downloads, in part or whole.
  const page = await (await upload(env, env.auth, { name: 'x.html', type: 'text/html', content: '<script>alert(1)</script>' })).json();
  for (const headers of [{}, { Range: 'bytes=0-3' }]) {
    const res = await getStored(env, page.id, headers);
    assert.equal(res.headers.get('Content-Disposition'), 'attachment; filename="x.html"');
    assert.match(res.headers.get('Content-Security-Policy'), /sandbox/);
  }
}

// A browser's copy of a file can't outlive it, and an expired file stays gone even if the browser has it.
{
  const env = await fileEnv();
  const { id } = await (await upload(env, env.auth, { ttl: '1d' })).json();
  const entry = JSON.parse(env.store.get(`d:${id}`));
  const expiresIn = seconds => env.store.set(`d:${id}`, JSON.stringify({ ...entry, expiresAt: Date.now() + seconds * 1000 }));
  const asks = [{}, { Range: 'bytes=0-1' }, { 'If-None-Match': `"${id}"` }];
  const maxAge = res => Number(res.headers.get('Cache-Control').match(/^public, max-age=(\d+)$/)[1]);

  expiresIn(90);
  for (const headers of asks) {
    const left = maxAge(await getStored(env, id, headers));
    assert.ok(left <= 90 && left >= 88, `max-age ${left} must end by the expiry`);
  }
  expiresIn(0.5);
  assert.equal(maxAge(await getStored(env, id)), 0);

  expiresIn(60 * 60 * 24 * 30);
  assert.equal(maxAge(await getStored(env, id)), 60 * 60 * 24, 'long-lived files still revalidate daily');

  expiresIn(-1);
  for (const headers of asks) assert.equal((await getStored(env, id, headers)).status, 410);
}

// The usage count waits until the reply is out, because that KV write was most of the wait.
{
  const env = await fileEnv();
  const { id } = await (await upload(env, env.auth)).json();
  const order = [];
  const realPut = env.WRK_KV.put;
  env.WRK_KV.put = async (...args) => {
    await new Promise(resolve => setTimeout(resolve, 20));
    order.push('usage');
    return realPut(...args);
  };
  const pending = [];
  const res = await worker.fetch(new Request(`https://api.wrk.money/d/${id}`), env, { waitUntil: p => pending.push(p) });
  order.push('response');
  await Promise.all(pending);
  assert.equal(res.status, 200);
  assert.deepEqual(order, ['response', 'usage']);
}

// Files past the request limit go up in parts, for the owner only. Only their uploader can add to them, and each part has to be its own size.
{
  const env = await fileEnv();
  const MB = 1024 * 1024, GB = 1024 * MB;
  const start = (body, headers = env.auth) => post(env, '/d/big', body, headers);
  const putPart = (id, n, bytes, headers = env.auth) => call(env, `https://api.wrk.money/d/big/${id}/${n}`, {
    method: 'PUT', headers: { ...headers, 'Content-Length': String(bytes.length) }, body: bytes,
  });
  const usage = () => JSON.parse(env.store.get(`usage:${new Date().toISOString().slice(0, 7)}`) ?? '{"storageBytes":0}').storageBytes;

  assert.equal((await start({ name: 'a.bin', size: 10 }, {})).status, 401);
  // Only the owner, who holds the admin badge, can send them.
  for (const profile of [undefined, { badges: [] }, { badges: ['developer'] }]) {
    if (profile) env.store.set('profile:foo', JSON.stringify(profile));
    const refused = await start({ name: 'a.bin', size: 200 * MB, ttl: '1d' });
    assert.equal(refused.status, 400);
    assert.equal((await refused.json()).error, 'file too large (max 100MB)');
  }
  assert.equal(env.WRK_FILES.uploads.size, 0, 'a refused start opens nothing in R2');
  env.store.set('profile:foo', JSON.stringify({ badges: ['admin'] }));

  assert.equal((await start({ name: 'a.bin', size: 50 * GB + 1 })).status, 400);
  for (const size of [0, -1, 1.5, '10']) assert.equal((await start({ name: 'a.bin', size })).status, 400, String(size));

  // R2's free 10 GB is a month's average, so a big file fits when it isn't kept long.
  assert.equal((await start({ name: 'film.mkv', size: 25 * GB, ttl: '30d' })).status, 429);
  assert.equal((await start({ name: 'film.mkv', size: 25 * GB, ttl: '7d' })).status, 201);
  assert.equal(usage(), Math.ceil(25 * GB * 8 / 30));

  const size = 50 * MB + 10;
  const started = await start({ name: 'film.mkv', type: 'video/x-matroska', size, ttl: '1d' });
  assert.equal(started.status, 201);
  const { id, partSize } = await started.json();
  assert.equal(partSize, 50 * MB);

  const first = new Uint8Array(partSize).fill(7);
  const last = new Uint8Array(10).fill(9);
  assert.equal((await putPart(id, 2, new Uint8Array(11))).status, 400, 'the last part is only what is left');
  assert.equal((await putPart(id, 1, last)).status, 400, 'every other part is a full part');
  assert.equal((await putPart(id, 3, last)).status, 400, 'no parts past the size given');
  assert.equal((await putPart(id, 0, last)).status, 400);
  assert.equal((await putPart(id, 2, last, {})).status, 404);

  const writes = env.calls.put;
  const parts = [await (await putPart(id, 1, first)).json(), await (await putPart(id, 2, last)).json()];
  assert.equal(env.calls.put, writes, 'parts cost no KV writes, not even the rate limit');
  assert.deepEqual(Object.keys(parts[0]), ['partNumber', 'etag']);

  // Someone else can't add to it or finish it.
  env.store.set('user:bar', JSON.stringify({ username: 'bar', slug: 'bar', salt: 's', passwordHash: await sha256Hex('s' + 'pw') }));
  const other = { Authorization: `Bearer ${(await (await post(env, '/auth/login', { username: 'bar', password: 'pw' })).json()).token}` };
  assert.equal((await putPart(id, 2, last, other)).status, 404);
  assert.equal((await post(env, `/d/big/${id}`, { parts }, other)).status, 404);

  const short = await (await start({ name: 'b.bin', size: 20, ttl: '1d' })).json();
  await putPart(short.id, 1, new Uint8Array(20));
  assert.equal((await post(env, `/d/big/${short.id}`, { parts: [] }, env.auth)).status, 400, 'a missing part fails the whole file');
  assert.ok(!env.WRK_FILES.objects.has(short.id), 'and leaves nothing behind');

  const done = await post(env, `/d/big/${id}`, { parts }, env.auth);
  assert.equal(done.status, 201);
  assert.equal((await done.json()).url, `https://wrk.money/d/?id=${id}`);
  assert.equal((await post(env, `/d/big/${id}`, { parts }, env.auth)).status, 404, 'a finished upload takes nothing more');
  assert.ok(!env.store.has(`up:${id}`));

  const meta = await (await call(env, `https://api.wrk.money/d/${id}/meta`)).json();
  assert.deepEqual([meta.name, meta.type, meta.size], ['film.mkv', 'video/x-matroska', size]);
  assert.ok(meta.expiresAt - Date.now() > 23 * 60 * 60 * 1000);
  assert.equal(env.WRK_FILES.objects.get(id).customMetadata.expiresAt, String(meta.expiresAt), 'the cleanup sees the same expiry');

  const file = await getStored(env, id);
  assert.equal(file.headers.get('Content-Disposition'), 'inline; filename="film.mkv"');
  const bytes = new Uint8Array(await file.arrayBuffer());
  assert.equal(bytes.length, size);
  assert.deepEqual([bytes[0], bytes[partSize - 1], bytes[partSize], bytes.at(-1)], [7, 7, 9, 9]);
  const saved = await getStored(env, `${id}?dl`, { Range: 'bytes=0-1' });
  assert.equal(saved.headers.get('Content-Disposition'), 'attachment; filename="film.mkv"', 'the download button saves a video');
}

// The daily cleanup removes expired files from R2 and leaves everything else alone.
{
  const env = await fileEnv();
  const forever = await (await upload(env, env.auth)).json();
  const expiring = [];
  for (let i = 0; i < 5; i++) expiring.push((await (await upload(env, env.auth, { ttl: i % 2 ? '1d' : '30d' })).json()).id);
  await env.WRK_FILES.put('manual', new ArrayBuffer(1), { customMetadata: { name: 'put here by hand', size: '1' } });
  await env.WRK_FILES.put('bare', new ArrayBuffer(1), {});

  await worker.scheduled({}, env);
  assert.equal(env.WRK_FILES.objects.size, 8, 'nothing has expired yet');

  const realNow = Date.now;
  Date.now = () => realNow() + 2 * 60 * 60 * 24 * 1000;
  await worker.scheduled({}, env);
  Date.now = realNow;
  const dayOld = expiring.filter((_, i) => i % 2);
  assert.ok(dayOld.every(id => !env.WRK_FILES.objects.has(id)), 'expired files go, across pages of the listing');
  assert.equal(env.WRK_FILES.objects.size, 6);
  for (const key of [forever.id, 'manual', 'bare']) assert.ok(env.WRK_FILES.objects.has(key), key);
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

// Only the swap page reaches the wallet bridges and aggregators, and wallets can read the manifest from their own origin.
{
  const env = makeEnv();
  globalThis.fetch = async () => new Response('<p></p>', { headers: { 'Content-Type': 'text/html' } });
  const swap = (await call(env, 'https://wrk.money/tools/swap/')).headers.get('Content-Security-Policy');
  const home = (await call(env, 'https://wrk.money/')).headers.get('Content-Security-Policy');
  for (const host of ['wss://omni-ws.ston.fi', 'https://backend.swap.coffee', 'https://mainnet.api.dedust.io', 'https://bridge.tonapi.io', 'https://walletbot.me']) {
    assert.ok(swap.includes(host), host);
    assert.ok(!home.includes(host), `${host} stays off other pages`);
  }
  assert.doesNotMatch(swap, /connect-src[^;]* https:( |;|$)/, 'connect-src stays an allowlist');

  globalThis.fetch = async () => new Response('{}', { headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
  const manifest = await call(env, 'https://wrk.money/tonconnect-manifest.json', { headers: { Origin: 'https://wallet.tg' } });
  assert.equal(manifest.status, 200, 'web wallets fetch the manifest from their own origin');
  assert.equal(manifest.headers.get('Access-Control-Allow-Origin'), '*');
  assert.equal((await call(env, 'https://api.wrk.money/motd', { headers: { Origin: 'https://wallet.tg' } })).status, 403, 'the API still refuses other origins');
  globalThis.fetch = realFetch;
}

// The swap page's address and fee math, and the manifest wallets read.
{
  const { url, iconUrl } = JSON.parse(read('../tonconnect-manifest.json'));
  assert.equal(url, 'https://wrk.money');
  assert.equal(iconUrl, 'https://wrk.money/wrk_files/999circle.png');

  const code = read('../tools/swap/index.html').match(/<script id="swap-math">([\s\S]*?)<\/script>/)[1];
  const page = vm.runInNewContext(`${code}; ({ FEE_WALLET, siteFee, feeOnTop, feeFor, toUnits, fromUnits, toRaw, toFriendly, addressIn, pickRoute })`, { atob, btoa });
  const utya = '0:5a0a05303a873a80708d967fe82736f4995b3bf581bbc18a1abe1fa8d48b5a9d';
  assert.equal(page.toRaw('EQBaCgUwOoc6gHCNln_oJzb0mVs79YG7wYoavh-o1ItaneLA'), utya);
  assert.equal(page.toFriendly(utya), 'EQBaCgUwOoc6gHCNln_oJzb0mVs79YG7wYoavh-o1ItaneLA');
  assert.equal(page.toRaw(utya.toUpperCase().replace('0X', '0x')), utya);
  assert.equal(page.toRaw(page.FEE_WALLET), '0:a4911e68bebfd6317acf2e0d7209e4b284657fc12ae74c22f913b0026b40c6b4', 'the fee wallet is a real address');
  // A typo, then the testnet form of the same jetton with a valid checksum.
  for (const bad of ['EQBaCgUwOoc6gHCNln_oJzb0mVs79YG7wYoavh-o1ItaneLB', 'kQBaCgUwOoc6gHCNln_oJzb0mVs79YG7wYoavh-o1ItanVlK', 'UTYA', '1:' + '0'.repeat(64), '', null])
    assert.equal(page.toRaw(bad), null, `${bad} is refused`);

  // Pasted links: the jetton's address is pulled out of them.
  const friendly = 'EQBaCgUwOoc6gHCNln_oJzb0mVs79YG7wYoavh-o1ItaneLA';
  for (const link of [
    `https://tonviewer.com/${friendly}`,
    `https://tonscan.org/jetton/${friendly}#holders`,
    `https://app.ston.fi/swap?ft=TON&tt=${friendly}&fa=1`,
    `https://dedust.io/swap/TON/${friendly}`,
    `buy this: ${utya} now`,
    `https://example.com/${'A'.repeat(48)}/${friendly}`,
    ` ${friendly}\n`,
  ]) assert.equal(page.addressIn(link), utya, link);
  for (const none of ['https://tonviewer.com/', `https://tonviewer.com/${friendly.slice(0, -1)}B`, `x${friendly}`, 'UTYA', '', null])
    assert.equal(page.addressIn(none), null, `${none} has no address`);

  assert.equal(page.toUnits('1.5'), 1_500_000_000n);
  assert.equal(page.toUnits('0,000000001'), 1n);
  assert.equal(page.toUnits('2.5', 6), 2_500_000n, 'a 6-decimal jetton like USDT');
  assert.equal(page.toUnits('7', 0), 7n);
  for (const bad of ['', '1.0000000001', '-1', '1e9', 'abc']) assert.equal(page.toUnits(bad), null, bad);
  assert.equal(page.toUnits('1.1234567', 6), null, 'more decimals than the jetton has');
  assert.equal(page.fromUnits(1_500_000_000n), '1.5');
  assert.equal(page.fromUnits(1n), '0.000000001');
  assert.equal(page.fromUnits(2_500_000n, 6), '2.5');
  assert.equal(page.fromUnits(7n, 0), '7');
  for (const units of [1n, 999n, 1_000_000_000n, 2_915_648_333n]) assert.equal(page.toUnits(page.fromUnits(units)), units);

  assert.equal(page.siteFee(10_000_000_000n), 25_000_000n, '0.25% of 10 TON');
  assert.equal(page.feeOnTop(9_975_000_000n), 25_000_000n, 'swapping 9.975 TON costs 10 TON with the fee');
  for (const swap of [1n, 12_345n, 2_915_648_333n, 9_975_000_001n]) {
    const fee = page.feeOnTop(swap);
    assert.ok(fee >= page.siteFee(swap + fee) && fee - page.siteFee(swap + fee) <= 1n, `fee on top of ${swap} is 0.25% of the total`);
  }

  // The fee is always GRAM, worked out from whichever side says what the swap is worth.
  assert.equal(page.feeFor({ fromGram: true, exactOut: false, payUnits: 10_000_000_000n }), 25_000_000n, 'paying 10 GRAM');
  assert.equal(page.feeFor({ fromGram: true, exactOut: true, swapUnits: 9_975_000_000n }), 25_000_000n, 'getting a set amount for GRAM');
  assert.equal(page.feeFor({ toGram: true, in: 100, out: 2.88, gramPerIn: 0.029 }), 7_200_000n, '100 UTYA into 2.88 GRAM counts the GRAM received');
  assert.equal(page.feeFor({ toGram: true, in: 100, out: 2.88, gramPerIn: NaN }), 7_200_000n, 'receiving GRAM needs no price');
  assert.equal(page.feeFor({ in: 100, out: 2.97, gramPerIn: 0.029 }), 7_250_000n, '100 UTYA into USDT counts UTYA at its GRAM price');
  for (const gramPerIn of [NaN, 0, Infinity, null]) assert.equal(page.feeFor({ in: 100, out: 2.97, gramPerIn }), 0n, `no fee without a price (${gramPerIn})`);

  // `in` is what's paid and `out` what's got, so the same pick works whichever amount was set.
  const route = (name, out, hops, gas = 0, spent = 1) => ({ name, out, hops, gas, in: spent });
  assert.equal(page.pickRoute([route('a', 100, 1), route('b', 101, 1)]).name, 'b');
  assert.equal(page.pickRoute([route('a', 100, 1), route('b', 100.05, 2)]).name, 'a', 'fewer hops wins a near tie');
  assert.equal(page.pickRoute([route('a', 100, 1), route('b', 101, 2)]).name, 'b', 'more hops wins when it gives clearly more');
  assert.equal(page.pickRoute([route('a', 100, 1), route('b', 99.95, 1)]).name, 'a', 'a near tie with the same hops goes to the bigger output');
  assert.equal(page.pickRoute([route('a', 101, 1, 0.5), route('b', 100, 1, 0.01)]).name, 'b', 'gas counts');
  assert.equal(page.pickRoute([route('a', 100, 1, 0, 2.93), route('b', 100, 1, 0, 2.91)]).name, 'b', 'for a set token amount, the cheaper route wins');
  assert.equal(page.pickRoute([route('a', 100, 1, 0.0225, 2.9156), route('b', 100, 1, 0.004, 2.9284)]).name, 'b', 'gas counts there too');
  assert.equal(page.pickRoute([route('a', 100, 1)]).name, 'a');
  // Paying 100 UTYA, where a GRAM is worth 34 UTYA: 0.1 more GRAM of gas costs 3.4 UTYA, which outweighs 1 more out.
  assert.equal(page.pickRoute([route('a', 3.0, 1, 0.15, 100), route('b', 3.03, 1, 0.25, 100)], 34).name, 'a', 'gas is counted in the coin paid');
  assert.equal(page.pickRoute([route('a', 3.0, 1, 0.15, 100), route('b', 3.03, 1, 0.25, 100)], 0).name, 'b', 'without a price, gas is left out');
}

// The shared browser script accepts what the worker accepts.
{
  const page = {};
  vm.runInNewContext(read('../wrk_files/gift.js'), page);
  const gift = page.parseGift('https://t.me/nft/ScaredCat-16534');
  assert.equal(gift.url, 'https://t.me/nft/ScaredCat-16534');
  assert.equal(gift.label, 'Scared Cat #16534');
  assert.equal(gift.number, '#16,534');
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

// Gift pages and market posts, the way t.me writes them.
const giftPage = (owner, name = 'Scared Cat #845') => `<meta property="og:title" content="${name}"><table class="tgme_gift_table"><tr><th>Owner</th><td>${owner}</td></tr>`
  + '<tr><th>Model</th><td>Weedcat <mark>3.5%</mark></td></tr><tr><th>Backdrop</th><td>Shamrock Green <mark>1.5%</mark></td></tr><tr><th>Symbol</th><td>Scarecrow <mark>2%</mark></td></tr></table>';
const named = name => `<span dir="auto">${name}</span>`;
const wallet = address => `<span class="tgme_gift_owner_address">${address}</span>`;
const channelPost = (channel, id, text, time) => `<div class="tgme_widget_message js-widget_message" data-post="${channel}/${id}" data-view="x">`
  + `<div class="tgme_widget_message_text js-message_text" dir="auto">${text}</div><a class="tgme_widget_message_date" href="https://t.me/${channel}/${id}"><time datetime="${time}" class="time">18:20</time></a></div>`;
const soldPost = (link, price) => `<i class="emoji"><b>🎁</b></i> Gift Sold<br/><br/><a href="${link}"><b>Gift</b></a><br/><i class="emoji"><b>🤑</b></i>Price: <b>${price}</b> $Gram`;
const listedPost = (link, price) => `New Gift Listed<br/><br/><a href="${link}" target="_blank">Gift</a><br/>Price: ${price} &#036;TON<br/>Check it out here: <a href="https://t.me/tonnel_network_bot/gift?startapp=1">buy</a>`;

// Gift links, gift pages and market posts are read the way t.me, Fragment and the markets write them.
{
  const { giftKey, parseGiftPage, parseChannel, fragmentPrice } = gifts;
  for (const link of ['https://t.me/nft/ScaredCat-845', 't.me/nft/ScaredCat-845?ref=1', 'scaredcat-845', ' ScaredCat-0845 ', 'http://telegram.me/nft/ScaredCat-845',
    'https://nft.fragment.com/gift/scaredcat-845.lottie.json', 'fragment.com/gift/scaredcat-845'])
    assert.equal(giftKey(link), 'scaredcat-845', link);
  for (const bad of [null, '', 'scaredcat', 'scaredcat-0', 'scared cat-845', 'https://evil.example/nft/ScaredCat-845', 'https://t.me/nft/Scared"Cat-845'])
    assert.equal(giftKey(bad), null, bad);

  assert.deepEqual(parseGiftPage(giftPage(named('safonov <i class="emoji" style="x"><b>✌️</b></i> &amp; co')), 'scaredcat-845'), {
    name: 'Scared Cat #845', model: 'Weedcat', backdrop: 'Shamrock Green', symbol: 'Scarecrow', owner: { key: 'name:safonov ✌️ & co', label: 'safonov ✌️ & co' },
  });
  assert.deepEqual(parseGiftPage(giftPage('<a href="https://t.me/SomeUser"><span dir="auto">Some User</span></a>'), 'scaredcat-845').owner, { key: 'tg:someuser', label: '@SomeUser' });
  assert.deepEqual(parseGiftPage(giftPage(wallet('fugui.t.me')), 'scaredcat-845').owner, { key: 'ton:fugui.t.me', label: 'fugui.t.me', chain: true });
  for (const other of ['scaredcat-84', 'scaredcat-45']) assert.equal(parseGiftPage(giftPage(named('a')), other), null, `${other} is another gift`);

  const posts = parseChannel([
    channelPost('mrktnotification', 10714222, soldPost('http://telegram.me/nft/LunarSnake-121321', '4,104.68').replace('$Gram', 'GRAM'), '2026-11-17T18:20:09+00:00'),
    channelPost('TonnelGift', 1072822, listedPost('https://t.me/nft/PreciousPeach-987', 275), '2026-11-17T18:21:00+00:00'),
    channelPost('TonnelGift', 1072823, ' Suitcase Unupgraded gift listed<br/>Price: 120 TON ', '2026-11-17T18:22:00+00:00'),
  ].join('\n'));
  assert.deepEqual(posts.map(p => [p.id, p.gift, p.kind, p.price]), [
    [10714222, 'lunarsnake-121321', 'sold', 4104.68], [1072822, 'preciouspeach-987', 'listed', 275], [1072823, null, null, 120],
  ]);
  assert.equal(posts[0].time, Date.parse('2026-11-17T18:20:09Z'));

  assert.equal(fragmentPrice('<th>Sell Price</th><div class="table-cell-value tm-value icon-before icon-ton">1,250.5</div>'), 1250.5);
  assert.equal(fragmentPrice('<th>Sale Price</th><div class="table-cell-value tm-value icon-before icon-ton">900</div>'), null, 'a past sale is no listing');
}

// The tracker reads every source once a run, sends each alert once to whoever asked for that kind, and never touches KV.
{
  const env = makeEnv();
  env.WRK_FILES = makeBucket();
  env.TG_BOT_TOKEN = '123:test';
  const owners = { 'scaredcat-845': named('Alice'), 'toybear-7': named('Bob') };
  const channels = { TonnelGift: [], portals_notifications: [], mrktnotification: [] };
  const say = (channel, id, text, time) => channels[channel].push({ id, text, time });
  let fragment = '<th>Sale Price</th>';
  const sent = [], hooks = [], asked = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input?.url ?? input);
    asked.push(url);
    let m;
    if (url.startsWith('https://api.telegram.org/bot123:test/')) {
      (url.endsWith('/setWebhook') ? hooks : sent).push(JSON.parse(init.body));
      return Response.json({ ok: true });
    }
    if ((m = url.match(/^https:\/\/t\.me\/nft\/(.+)$/))) return new Response(giftPage(owners[m[1]], m[1] === 'toybear-7' ? 'Toy Bear #7' : 'Scared Cat #845'));
    // A channel page holds its 20 newest posts, or the 20 before a post.
    if ((m = url.match(/^https:\/\/t\.me\/s\/(\w+)(?:\?before=(\d+))?$/)))
      return new Response(channels[m[1]].filter(p => !m[2] || p.id < Number(m[2])).slice(-20).map(p => channelPost(m[1], p.id, p.text, p.time)).join(''));
    if (url === 'https://fragment.com/gift/scaredcat-845') return new Response(fragment);
    if (url === 'https://tonapi.io/v2/accounts/EQSale') return Response.json({ address: '0:5a1e', interfaces: ['nft_sale_getgems_v4'] });
    if (url === 'https://tonapi.io/v2/blockchain/accounts/0%3A5a1e/methods/get_fix_price_data_v4') return Response.json({ decoded: { full_price: '5000000000' } });
    if (url.startsWith('https://tonapi.io/v2/accounts/')) return Response.json({ address: '0:1', interfaces: ['wallet_v4r2'] });
    return new Response('not found', { status: 404 });
  };

  const since = Date.parse('2026-11-17T18:00:00Z');
  const watch = alerts => ({ name: 'Scared Cat #845', since, transfer: false, sold: false, listed: false, chain: false, ...alerts });
  const all = { transfer: true, sold: true, listed: true, chain: true };
  await env.WRK_FILES.put('track/watches.json', JSON.stringify({ links: {}, members: {
    foo: { chat: 111, gifts: { 'scaredcat-845': watch(all) } },
    bar: { chat: 222, gifts: { 'scaredcat-845': watch({ sold: true }) } },
    // No chat linked, so nothing of theirs is checked.
    baz: { gifts: { 'toybear-7': watch(all) } },
  } }));
  for (let id = 1; id <= 25; id++) say('portals_notifications', id, soldPost('https://t.me/nft/scaredcat-845', id), '2026-11-17T17:00:00Z');
  say('TonnelGift', 1, listedPost('https://t.me/nft/ScaredCat-845', 1), '2026-11-17T17:00:00Z');
  say('mrktnotification', 1, soldPost('https://t.me/nft/other-1', 1), '2026-11-17T17:00:00Z');

  // Runs at 18:30 plus some minutes. Fragment is read on whole 5 minutes.
  const run = async minutes => {
    sent.length = 0;
    await worker.scheduled({ cron: '* * * * *', scheduledTime: Date.parse('2026-11-17T18:30:00Z') + minutes * 60_000 }, env);
    return sent.map(m => [m.chat_id, m.text]);
  };
  const state = () => JSON.parse(new TextDecoder().decode(env.WRK_FILES.objects.get('track/state.json').bytes));

  assert.deepEqual(await run(1), [], 'the first run only notes where everything stands, old sales included');
  assert.equal(hooks.length, 1);
  assert.equal(hooks[0].url, 'https://api.wrk.money/tg/webhook');
  assert.match(hooks[0].secret_token, /^[0-9a-f]{32}$/);
  assert.equal(state().gifts['scaredcat-845'].owner.label, 'Alice');
  assert.ok(!asked.some(url => url.includes('toybear')), "a member with no chat linked costs nothing");

  const writes = env.WRK_FILES.writes;
  assert.deepEqual(await run(2), [], 'nothing new');
  assert.equal(env.WRK_FILES.writes, writes, 'and nothing written');
  assert.equal(hooks.length, 1, 'the webhook is set once');

  owners['scaredcat-845'] = named('Bob');
  assert.deepEqual(await run(3), [[111, '🔁 <b>Scared Cat #845</b> was transferred to Bob']]);
  assert.deepEqual(sent[0].reply_markup.inline_keyboard[0][0], { text: 'view gift', url: 'https://t.me/nft/scaredcat-845' });

  // A sale, then the buyer's name on the page: one sold alert, not a transfer as well. A post from before the watch began is left out.
  say('portals_notifications', 26, soldPost('https://t.me/nft/scaredcat-845', '29.24'), '2026-11-17T18:33:30Z');
  say('portals_notifications', 27, soldPost('https://t.me/nft/scaredcat-845', '1'), '2026-11-17T17:59:00Z');
  owners['scaredcat-845'] = named('Carol');
  const sold = '💰 <b>Scared Cat #845</b> sold on Portals for 29.24 GRAM — new owner: Carol';
  assert.deepEqual(await run(4), [[111, sold], [222, sold]]);

  // Within 10 minutes of a sale a move isn't sent, since it's most likely the sale's.
  owners['scaredcat-845'] = named('Dave');
  assert.deepEqual(await run(9), []);

  // 30 posts since the last run is more than a page, and the listing is on the older one.
  for (let id = 2; id <= 31; id++) say('TonnelGift', id, id === 5 ? listedPost('https://t.me/nft/ScaredCat-845', 275) : listedPost(`https://t.me/nft/Other-${id}`, 1), '2026-11-17T18:44:00Z');
  owners['scaredcat-845'] = named('Gift Relayer');
  assert.deepEqual(await run(15), [[111, '🏷 <b>Scared Cat #845</b> was listed on Tonnel for 275 GRAM'], [111, '🔁 <b>Scared Cat #845</b> was transferred to Tonnel']]);
  assert.ok(!asked.includes('https://fragment.com/gift/scaredcat-845'), 'Fragment is only read for gifts on the blockchain');

  // Sold while the market still holds it: the market's account isn't the new owner.
  // A gift first seen in the same run as its sale has no earlier owner to compare, so whoever the page shows may be the seller.
  const watches = JSON.parse(new TextDecoder().decode(env.WRK_FILES.objects.get('track/watches.json').bytes));
  watches.members.foo.gifts['toybear-7'] = watch({ ...all, name: 'Toy Bear #7' });
  await env.WRK_FILES.put('track/watches.json', JSON.stringify(watches));
  say('mrktnotification', 2, soldPost('http://telegram.me/nft/ScaredCat-845', '4.68').replace('$Gram', 'GRAM'), '2026-11-17T18:45:30Z');
  say('mrktnotification', 3, soldPost('http://telegram.me/nft/ToyBear-7', '2').replace('$Gram', 'GRAM'), '2026-11-17T18:45:40Z');
  const held = '💰 <b>Scared Cat #845</b> sold on MRKT for 4.68 GRAM';
  assert.deepEqual(await run(16), [[111, held], [222, held], [111, '💰 <b>Toy Bear #7</b> sold on MRKT for 2 GRAM']]);
  // Nor is a market account that takes it after the sale, nor the same person still shown.
  say('mrktnotification', 4, soldPost('http://telegram.me/nft/ToyBear-7', '3').replace('$Gram', 'GRAM'), '2026-11-17T18:46:40Z');
  owners['toybear-7'] = named('MRKT Bank');
  assert.deepEqual(await run(17), [[111, '💰 <b>Toy Bear #7</b> sold on MRKT for 3 GRAM']]);
  owners['toybear-7'] = named('Erin');
  await run(18);
  say('mrktnotification', 5, soldPost('http://telegram.me/nft/ToyBear-7', '4').replace('$Gram', 'GRAM'), '2026-11-17T18:48:40Z');
  assert.deepEqual(await run(19), [[111, '💰 <b>Toy Bear #7</b> sold on MRKT for 4 GRAM']]);

  owners['scaredcat-845'] = wallet('UQAovb39sD1NDenojl2zo2oI-PmX-Dj1A1ZWMBqMz9k-EuOW');
  fragment = '<th>Sell Price</th><div class="tm-value icon-before icon-ton">1,250</div>';
  assert.deepEqual(await run(20), [
    [111, '⛓ <b>Scared Cat #845</b> was moved to the TON blockchain — wallet: <code>UQAovb39sD1NDenojl2zo2oI-PmX-Dj1A1ZWMBqMz9k-EuOW</code>'],
    [111, '🏷 <b>Scared Cat #845</b> was listed on Fragment for 1,250 GRAM'],
  ]);
  asked.length = 0;
  assert.deepEqual(await run(21), [], 'Fragment waits for the next whole 5 minutes');
  assert.ok(!asked.includes('https://fragment.com/gift/scaredcat-845'));
  assert.deepEqual(await run(25), [], 'a listing still up is not sent again');

  // Listed on GetGems means owned by a GetGems sale contract. That's the listing, with no transfer alert.
  owners['scaredcat-845'] = wallet('EQSale');
  assert.deepEqual(await run(26), [[111, '🏷 <b>Scared Cat #845</b> was listed on GetGems for 5 GRAM']]);

  // A gift nobody watches any more is forgotten.
  await env.WRK_FILES.put('track/watches.json', JSON.stringify({ links: {}, members: {} }));
  await run(27);
  assert.deepEqual(state().gifts, {});
  assert.deepEqual(env.calls, { get: 0, put: 0 }, 'all of it lives in R2');

  // Without a bot there's nobody to tell, so a run does nothing.
  delete env.TG_BOT_TOKEN;
  asked.length = 0;
  await run(28);
  assert.deepEqual(asked, []);
  globalThis.fetch = realFetch;
}

// Members link the bot with a one-time code typed in a chat, and only Telegram can reach the webhook.
{
  const env = await fileEnv();
  env.TG_BOT_TOKEN = '123:test';
  globalThis.fetch = async input => {
    const url = String(input?.url ?? input);
    const key = url.match(/^https:\/\/t\.me\/nft\/(.+)$/)?.[1];
    if (key === 'missing-1') return new Response('', { status: 302, headers: { Location: 'https://t.me/' } });
    if (key === 'outage-5') return new Response('down', { status: 502 });
    if (key) return new Response(giftPage(named('Alice'), key === 'scaredcat-845' ? 'Scared Cat #845' : `Gift #${key.split('-')[1]}`));
    return new Response('not found', { status: 404 });
  };
  // Each from its own address, so the rate limit stays out of it.
  let ip = 0;
  const api = (path, method = 'GET', body, headers = env.auth) => call(env, `https://api.wrk.money${path}`, {
    method, headers: { ...headers, 'Content-Type': 'application/json', 'CF-Connecting-IP': `10.0.0.${ip++}` }, ...(body && { body: JSON.stringify(body) }),
  });

  for (const [path, method] of [['/track', 'GET'], ['/track', 'PUT'], ['/track/link', 'POST'], ['/gifts/mono?gift=scaredcat-845', 'GET']])
    assert.equal((await api(path, method, method === 'GET' ? null : {}, {})).status, 401, `${method} ${path} needs a session`);
  assert.equal((await api('/track/link', 'POST')).status, 503, 'no bot yet');
  env.TG_BOT_USERNAME = 'wrkgiftsbot';
  const { code, bot, minutes } = await (await api('/track/link', 'POST')).json();
  assert.match(code, /^[A-HJKMNP-Z2-9]{8}$/);
  assert.deepEqual([bot, minutes], ['wrkgiftsbot', 10]);
  assert.ok(!new TextDecoder().decode(env.WRK_FILES.objects.get('track/watches.json').bytes).includes(code), 'the code is kept hashed');

  const secret = (await gifts.sha256('webhook:123:test')).slice(0, 32);
  const tg = (text, headers = { 'X-Telegram-Bot-Api-Secret-Token': secret }) => call(env, 'https://api.wrk.money/tg/webhook', {
    method: 'POST', headers, body: JSON.stringify({ message: { chat: { id: 555, type: 'private' }, text } }),
  });
  const reply = async text => {
    const answer = await (await tg(text)).json();
    assert.deepEqual([answer.method, answer.chat_id, answer.parse_mode], ['sendMessage', 555, 'HTML']);
    return answer.text;
  };
  const kvWrites = env.calls.put;
  assert.equal((await tg(code, {})).status, 403, 'without the secret Telegram was given');
  assert.equal((await tg(code, { 'X-Telegram-Bot-Api-Secret-Token': 'nope' })).status, 403);
  assert.match(await reply('/list'), /press "link telegram"/, 'an unlinked chat is told how to link');
  assert.match(await reply('/start ' + code.toLowerCase()), /^linked to <b>foo<\/b>/);
  assert.match(await reply(code), /wrong or has run out/, 'a code works once');
  // A chat belongs to one member: linking it for someone else moves it.
  const moved = { members: { foo: { chat: 555, gifts: {} } }, links: { h: { slug: 'bar', expires: Date.now() + 1000 }, old: { slug: 'baz', expires: Date.now() - 1 } } };
  assert.equal(gifts.linkChat(moved, 'old', 555, Date.now()), false, 'a code that ran out');
  assert.equal(gifts.linkChat(moved, 'h', 555, Date.now()), 'bar');
  assert.deepEqual([moved.members.foo.chat, moved.members.bar.chat, moved.links.h], [undefined, 555, undefined]);
  assert.equal(env.calls.put, kvWrites, "Telegram's requests skip the rate limit and its KV write");

  // Adding gifts: every alert starts on, a change keeps the rest, and only a definite "no such gift" is refused.
  let list = await (await api('/track', 'PUT', { gift: 'https://t.me/nft/ScaredCat-845' })).json();
  assert.deepEqual(list, { bot: 'wrkgiftsbot', linked: true, gifts: [{ key: 'scaredcat-845', name: 'Scared Cat #845', owner: null, transfer: true, sold: true, listed: true, chain: true }] });
  list = await (await api('/track', 'PUT', { gift: 'scaredcat-845', sold: false, chain: 'yes' })).json();
  assert.deepEqual(list.gifts.map(g => [g.sold, g.chain, g.transfer]), [[false, true, true]]);
  const missing = await api('/track', 'PUT', { gift: 'missing-1' });
  assert.equal(missing.status, 400);
  assert.equal((await missing.json()).error, 'that telegram gift does not exist: https://t.me/nft/missing-1');
  assert.equal((await api('/track', 'PUT', { gift: 'outage-5' })).status, 200, "a t.me outage can't block adding");
  assert.equal((await api('/track', 'PUT', { gift: 'not a gift' })).status, 400);
  for (let n = 1; n <= 18; n++) assert.equal((await api('/track', 'PUT', { gift: `gift-${n}` })).status, 200);
  const full = await api('/track', 'PUT', { gift: 'gift-19' });
  assert.equal((await full.json()).error, 'you can track up to 20 gifts');
  assert.equal((await api('/track', 'PUT', { gift: 'gift-3', listed: false })).status, 200, 'a full list can still change');

  // Two changes at once: the write that read the older copy tries again, so neither is lost.
  const bucket = env.WRK_FILES, realPut = bucket.put;
  bucket.put = async function (key, value, opts) {
    bucket.put = realPut;
    const other = JSON.parse(new TextDecoder().decode(bucket.objects.get(key).bytes));
    other.members.someone = { gifts: { 'other-1': {} } };
    await realPut.call(bucket, key, JSON.stringify(other));
    return realPut.call(bucket, key, value, opts);
  };
  await api('/track', 'PUT', { gift: 'gift-4', sold: false });
  const both = JSON.parse(new TextDecoder().decode(bucket.objects.get('track/watches.json').bytes));
  assert.equal(both.members.foo.gifts['gift-4'].sold, false);
  assert.ok(both.members.someone, 'the other change is kept');

  list = await (await api('/track/outage-5', 'DELETE')).json();
  assert.equal(list.gifts.length, 19);
  assert.ok(!list.gifts.some(g => g.key === 'outage-5'));

  // clue.tg's stored scores, one byte per gift number, and what the bot and the calculator say about them.
  const scores = new Uint8Array(846).fill(255);
  scores[845] = 76;
  await bucket.put('mono/scaredcat', scores);
  assert.match(await reply('/list'), /<a href="https:\/\/t.me\/nft\/scaredcat-845">Scared Cat #845<\/a>/);
  assert.equal(await reply('/mono t.me/nft/ScaredCat-845'), '<b>scaredcat-845</b>: 76% — partial match');
  for (const unknown of ['/mono scaredcat-1', '/mono scaredcat-9999', '/mono nosuchcollection-1']) assert.match(await reply(unknown), /no stored score/, unknown);
  assert.deepEqual(await (await api('/gifts/mono?gift=ScaredCat-845')).json(), { key: 'scaredcat-845', score: 76, name: 'Scared Cat #845', model: 'Weedcat', backdrop: 'Shamrock Green', symbol: 'Scarecrow' });
  assert.equal((await (await api('/gifts/mono?gift=scaredcat-2')).json()).score, null, 'no stored score: the page works it out');
  assert.equal((await api('/gifts/mono?gift=missing-1')).status, 404);
  assert.equal((await api('/gifts/mono?gift=nonsense')).status, 400);

  assert.match(await reply('/stop'), /^alerts stopped/);
  assert.equal((await (await api('/track')).json()).linked, false);
  assert.match(await reply('/list'), /press "link telegram"/);
  assert.equal((await (await api('/track/link', 'DELETE')).json()).linked, false);
  globalThis.fetch = realFetch;
}

// The calculator's own check, for gifts clue.tg never scored, gives what clue.tg's Python gave.
{
  const code = read('../tools/mono/index.html').match(/<script id="mono-math">([\s\S]*?)<\/script>/)[1];
  const page = vm.runInNewContext(`${code}; ({ monoScore, monoLabel })`);
  const fill = k => ({ ty: 'fl', c: { k } });
  const gradient = (p, k) => ({ ty: 'gf', g: { p, k: { k } } });
  // A glow and an unused asset are left out, a nested composition is followed once, and an animated gradient's first frame counts.
  const animation = {
    layers: [{ nm: 'Gift', refId: 'g' }, { nm: 'Background', shapes: [{ it: [gradient(2, [0, 0.80, 0.62, 0.20, 1, 0.5, 0.4, 0.1])] }] }],
    assets: [
      { id: 'g', layers: [{ ty: 0, refId: 'inner' }, { nm: 'Outer Glow', shapes: [fill([1, 0, 0, 1])] }, { shapes: [fill([0.85, 0.65, 0.15, 1]), fill([0.05, 0.05, 0.05, 1]), fill([0.85, 0.65, 0.15, 1])] }] },
      { id: 'inner', layers: [{ ty: 0, refId: 'g' }, { shapes: [{ ty: 'gf', g: { p: 2, k: { k: [{ s: [0, 0.2, 0.3, 0.9, 1, 0.9, 0.7, 0.2] }] } } }, fill([{ s: [1] }])] }] },
      { id: 'unused', layers: [{ shapes: [fill([0, 1, 0, 1])] }] },
    ],
  };
  assert.equal(page.monoScore(animation), 68.1);
  // A grey backdrop matches on lightness.
  assert.equal(page.monoScore({ layers: [{ nm: 'Gift', refId: 'g' }, { nm: 'Background', shapes: [{ it: [gradient(1, [0, 0.5, 0.5, 0.52])] }] }],
    assets: [{ id: 'g', layers: [{ shapes: [fill([0.95, 0.95, 0.95, 1]), fill([0.3, 0.32, 0.31, 1])] }] }] }), 80);
  assert.equal(page.monoScore({ layers: [{ nm: 'Gift', refId: 'g' }] }), null, 'no backdrop, no score');
  assert.deepEqual([80, 79.9, 55, 54.9].map(page.monoLabel), ['strong match', 'partial match', 'partial match', 'low match']);
  assert.equal(page.monoLabel(80), gifts.monoLabel(80));
  assert.equal(page.monoLabel(54), gifts.monoLabel(54));
}

console.log('all checks passed');
