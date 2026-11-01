import { safeLink, securePage } from './security.js';
import { cleanPrefs } from './prefs.js';

const LIMITS = {
  storageBytes: 10 * 1024 * 1024 * 1024,
  classA: 1_000_000,
  classB: 10_000_000,
};

const RATE_LIMIT_WINDOW = 60;
const RATE_LIMIT_MAX = 20;

// Workers caps PBKDF2 at 100k iterations.
// ponytail: below OWASP's 600k for PBKDF2-SHA256, a WASM argon2 build is the upgrade path if that matters
const PBKDF2_ITERATIONS = 100_000;

const RESERVED_SLUGS = new Set([
  '$', '$$', '$$$', 'insanity', 'startpage', 'tools', '404',
  'p', 'd', 's', 'login', 'admin', 'settings', 'profile',
  'wrk_files', 'api', 'index', 'favicon', 'cname', 'readme',
  'auth', 'usage', 'robots.txt', 'sitemap.xml', 'assets', 'directory', 'site-settings',
]);

// ── Helpers ───────────────────────────────────────────────────────────────────

function monthKey() {
  const d = new Date();
  return `usage:${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function nanoid(len = 8, chars = 'abcdefghijklmnopqrstuvwxyz0123456789') {
  let id = '';
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  for (const b of bytes) id += chars[b % chars.length];
  return id;
}

function cors(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function err(msg, status = 400, extraHeaders = {}) {
  return json({ error: msg }, status, extraHeaders);
}

async function getDirectory(req, env, corsHeaders) {
  const payload = await requireAuth(req, env);
  if (!payload) return err('unauthorized', 401, corsHeaders);
  const list = await env.WRK_KV.list({ prefix: 'user:' });
  const users = await Promise.all(
    list.keys.map(async k => {
      const u = await env.WRK_KV.get(k.name, { type: 'json' });
      if (!u || !u.passwordHash) return null;
      const profile = await env.WRK_KV.get(`profile:${u.slug}`, { type: 'json' });
      return {
        slug: u.slug,
        uid: u.uid ?? null,
        displayName: profile?.displayName || u.username,
        avatar: profile?.avatar || '',
        badges: profile?.badges || [],
        tgGiftUrl: profile?.tgGiftUrl || null,
      };
    })
  );
  const sorted = users.filter(Boolean).sort((a, b) => {
    if (a.uid === null && b.uid === null) return 0;
    if (a.uid === null) return 1;
    if (b.uid === null) return -1;
    return a.uid - b.uid;
  });
  return json(sorted, 200, corsHeaders);
}

async function getMOTD(env, corsHeaders) {
  const motd = await env.WRK_KV.get('motd');
  return json({ motd: motd || null }, 200, corsHeaders);
}

async function setMOTD(req, env, corsHeaders) {
  if (!requireAdmin(req, env)) return err('forbidden', 403, corsHeaders);
  const body = await req.json().catch(() => null);
  const text = String(body?.motd ?? '').trim().slice(0, 280);
  if (text) await env.WRK_KV.put('motd', text);
  else await env.WRK_KV.delete('motd');
  return json({ motd: text || null }, 200, corsHeaders);
}

async function getNextUid(env) {
  const current = parseInt(await env.WRK_KV.get('uid:counter') || '0');
  await env.WRK_KV.put('uid:counter', String(current + 1));
  return current;
}

function serveOGPage(profile, pageUrl) {
  const esc = s => String(s).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const title = profile.ogTitle || profile.displayName || 'wrk.money';
  const desc  = profile.ogDescription || (profile.bioStatements || [])[0] || '';
  const image = profile.ogImage || profile.avatar || 'https://wrk.money/wrk_files/999circle.png';
  return new Response(
    `<!DOCTYPE html><html><head>
<meta charset="UTF-8">
<title>${esc(title)} | wrk.money</title>
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:image" content="${esc(image)}">
<meta property="og:url" content="${esc(pageUrl)}">
<meta property="og:type" content="profile">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(desc)}">
<meta name="twitter:image" content="${esc(image)}">
</head><body></body></html>`,
    { headers: { 'Content-Type': 'text/html; charset=utf-8' } }
  );
}

function toRawFileUrl(url) {
  try {
    const u = new URL(url);
    if (u.hostname === 'wrk.money' && u.pathname === '/d/') {
      const id = u.searchParams.get('id');
      if (id) return `https://api.wrk.money/d/${id}`;
    }
  } catch {}
  return url;
}

// ── Rate limiting ─────────────────────────────────────────────────────────────

async function checkRateLimit(env, ip) {
  try {
    const key = `rl:${ip}:${Math.floor(Date.now() / 1000 / RATE_LIMIT_WINDOW)}`;
    const count = parseInt(await env.WRK_KV.get(key) || '0');
    if (count >= RATE_LIMIT_MAX) return false;
    await env.WRK_KV.put(key, String(count + 1), { expirationTtl: RATE_LIMIT_WINDOW * 2 });
    return true;
  } catch {
    return true;
  }
}

// ── Usage tracking ────────────────────────────────────────────────────────────

async function getUsage(env) {
  const raw = await env.WRK_KV.get(monthKey(), { type: 'json' });
  return raw || { storageBytes: 0, classA: 0, classB: 0 };
}

async function incrementUsage(env, delta) {
  try {
    const key = monthKey();
    const usage = await getUsage(env);
    const updated = {
      storageBytes: usage.storageBytes + (delta.storageBytes || 0),
      classA: usage.classA + (delta.classA || 0),
      classB: usage.classB + (delta.classB || 0),
    };
    await env.WRK_KV.put(key, JSON.stringify(updated), { expirationTtl: 60 * 60 * 24 * 35 });
    return updated;
  } catch {
    return delta;
  }
}

async function checkLimits(env, need = {}) {
  const usage = await getUsage(env);
  if (need.storageBytes && usage.storageBytes + need.storageBytes > LIMITS.storageBytes)
    return 'storage limit reached (10 GB/month)';
  if (need.classA && usage.classA + need.classA > LIMITS.classA)
    return 'write operation limit reached (1M/month)';
  if (need.classB && usage.classB + need.classB > LIMITS.classB)
    return 'read operation limit reached (10M/month)';
  return null;
}

// ── Crypto / Auth ─────────────────────────────────────────────────────────────

function b64url(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function b64urlDecode(str) {
  return Uint8Array.from(atob(str.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
}

function toHex(buf) {
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function hashPassword(password, salt, iterations = PBKDF2_ITERATIONS) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: encoder.encode(salt), iterations }, key, 256
  );
  return `pbkdf2$${iterations}$${toHex(bits)}`;
}

// Accounts created before PBKDF2 keep this format until their next login.
async function legacyHashPassword(password, salt) {
  return toHex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(salt + password)));
}

const SESSION_SECONDS = 60 * 60 * 24 * 7;
const SESSION_MAX_SECONDS = 60 * 60 * 24 * 30;

const CODE_SECONDS = 60 * 60;
const CODE_TRIES = 5;
// No 0, O, 1, I or L, so a code survives being read out or retyped.
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function hashCode(slug, code) {
  return crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${slug}:${code}`)).then(toHex);
}

function sessionClaims(user) {
  const now = Math.floor(Date.now() / 1000);
  return { username: user.username, slug: user.slug, born: now, exp: now + SESSION_SECONDS };
}

async function signJWT(payload, secret) {
  const header = b64url(new TextEncoder().encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const body = b64url(new TextEncoder().encode(JSON.stringify(payload)));
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = b64url(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${header}.${body}`)));
  return `${header}.${body}.${sig}`;
}

async function verifyJWT(token, secret) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [header, body, sig] = parts;
    const key = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']
    );
    const valid = await crypto.subtle.verify(
      'HMAC', key, b64urlDecode(sig),
      new TextEncoder().encode(`${header}.${body}`)
    );
    if (!valid) return null;
    const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(body)));
    if (payload.exp && Date.now() / 1000 > payload.exp) return null;
    return payload;
  } catch { return null; }
}

async function requireAuth(req, env) {
  const auth = req.headers.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return null;
  const payload = await verifyJWT(token, env.JWT_SECRET);
  if (!payload) return null;
  // A password reset ends every session from before it.
  const cutoff = await env.WRK_KV.get(`revoked:${payload.slug}`);
  return cutoff && (payload.born || 0) < Number(cutoff) ? null : payload;
}

function requireAdmin(req, env) {
  const auth = req.headers.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  return token && token === env.ADMIN_SECRET;
}

function validateSlug(slug) {
  if (!slug || slug.length < 3) return 'slug must be at least 3 characters';
  if (slug.length > 30) return 'slug must be 30 characters or less';
  if (!/^[a-z0-9-]+$/.test(slug)) return 'slug may only contain lowercase letters, numbers, and hyphens';
  if (RESERVED_SLUGS.has(slug)) return 'slug is reserved';
  return null;
}

// ── Auth endpoints ────────────────────────────────────────────────────────────

// Accounts are stored under the name they were created with, which may have capitals.
async function findUser(env, name) {
  const typed = String(name).trim();
  for (const key of new Set([`user:${typed.toLowerCase()}`, `user:${typed}`])) {
    const user = await env.WRK_KV.get(key, { type: 'json' });
    if (user) return { key, user };
  }
  return {};
}

async function login(req, env, corsHeaders, ctx) {
  const body = await req.json().catch(() => null);
  if (!body?.username || !body?.password) return err('username and password required', 400, corsHeaders);

  const { key, user } = await findUser(env, body.username);
  if (!user) return err('invalid credentials', 401, corsHeaders);

  if (!user.passwordHash) return err('account not yet claimed — set your password first', 403, corsHeaders);

  const isLegacy = !user.passwordHash.startsWith('pbkdf2$');
  const hash = isLegacy
    ? await legacyHashPassword(body.password, user.salt)
    : await hashPassword(body.password, user.salt, parseInt(user.passwordHash.split('$')[1]));
  if (hash !== user.passwordHash) return err('invalid credentials', 401, corsHeaders);

  const token = await signJWT(
    sessionClaims(user),
    env.JWT_SECRET
  );

  // Upgrade on a later tick, after the response is out, so hitting the Workers CPU limit can't block the login.
  if (isLegacy) ctx.waitUntil((async () => {
    await new Promise(resolve => setTimeout(resolve));
    const passwordHash = await hashPassword(body.password, user.salt);
    await env.WRK_KV.put(key, JSON.stringify({ ...user, passwordHash }));
  })());

  const prefs = await env.WRK_KV.get(`prefs:${user.slug}`, { type: 'json' });
  return json({ token, username: user.username, slug: user.slug, prefs }, 200, corsHeaders);
}

async function issueCode(req, env, corsHeaders) {
  if (!requireAdmin(req, env)) return err('forbidden', 403, corsHeaders);
  const body = await req.json().catch(() => null);
  const { user } = await findUser(env, body?.username ?? '');
  if (!user) return err('account not found', 404, corsHeaders);

  const code = nanoid(10, CODE_CHARS);
  const saved = { hash: await hashCode(user.slug, code), tries: 0, expires: Date.now() + CODE_SECONDS * 1000 };
  await env.WRK_KV.put(`code:${user.slug}`, JSON.stringify(saved), { expirationTtl: CODE_SECONDS });
  return json({ code: `${code.slice(0, 5)}-${code.slice(5)}` }, 200, corsHeaders);
}

// Claims a new account or resets a forgotten password. Both need a one-time code from the admin page.
async function setupAccount(req, env, corsHeaders) {
  const body = await req.json().catch(() => null);
  if (!body?.username || !body?.code || typeof body.password !== 'string')
    return err('username, code and password required', 400, corsHeaders);
  if (body.password.length < 8) return err('password must be at least 8 characters', 400, corsHeaders);

  // The same answer for every failure, so this can't be used to find out who has an account or a code.
  const refused = err('invalid username or code', 401, corsHeaders);
  const { key, user } = await findUser(env, body.username);
  if (!user) return refused;
  const codeKey = `code:${user.slug}`;
  const saved = await env.WRK_KV.get(codeKey, { type: 'json' });
  if (!saved || Date.now() > saved.expires) return refused;

  const typed = String(body.code).toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (await hashCode(user.slug, typed) !== saved.hash) {
    // ponytail: KV is eventually consistent, so this count is approximate. The code's 49 bits and the rate limit do the real work.
    if (saved.tries + 1 >= CODE_TRIES) await env.WRK_KV.delete(codeKey);
    else await env.WRK_KV.put(codeKey, JSON.stringify({ ...saved, tries: saved.tries + 1 }), { expirationTtl: CODE_SECONDS });
    return refused;
  }

  const salt = nanoid(16);
  const passwordHash = await hashPassword(body.password, salt);
  await env.WRK_KV.put(key, JSON.stringify({ ...user, passwordHash, salt }));
  await env.WRK_KV.delete(codeKey);
  if (user.passwordHash)
    await env.WRK_KV.put(`revoked:${user.slug}`, String(Math.floor(Date.now() / 1000)), { expirationTtl: SESSION_MAX_SECONDS });

  const token = await signJWT(sessionClaims(user), env.JWT_SECRET);
  return json({ token, username: user.username, slug: user.slug, firstTime: !user.passwordHash }, 200, corsHeaders);
}

async function register(req, env, corsHeaders) {
  if (!requireAdmin(req, env)) return err('forbidden', 403, corsHeaders);

  const body = await req.json().catch(() => null);
  if (!body?.username) return err('username required', 400, corsHeaders);

  const username = body.username.trim();
  const slug = (body.slug || username).trim();

  const existingUser = await env.WRK_KV.get(`user:${username}`);
  if (existingUser) return err('username already taken', 409, corsHeaders);

  const existingSlug = await env.WRK_KV.get(`profile:${slug}`);
  if (existingSlug) return err('slug already taken', 409, corsHeaders);

  const salt = body.password ? nanoid(16) : null;
  const passwordHash = body.password ? await hashPassword(body.password, salt) : null;

  const uid = await getNextUid(env);
  const user = { username, slug, passwordHash, salt, uid, createdAt: Date.now() };
  const profile = {
    slug,
    displayName: username,
    avatar: '',
    bioStatements: [],
    tabs: [],
    footer: '',
    uid,
    createdAt: Date.now(),
  };

  await env.WRK_KV.put(`user:${username}`, JSON.stringify(user));
  await env.WRK_KV.put(`profile:${slug}`, JSON.stringify(profile));
  await env.WRK_KV.put(`uid:${uid}`, slug);

  return json({ username, slug, uid }, 201, corsHeaders);
}

async function getMe(req, env, corsHeaders) {
  const payload = await requireAuth(req, env);
  if (!payload) return err('unauthorized', 401, corsHeaders);
  const profile = await env.WRK_KV.get(`profile:${payload.slug}`, { type: 'json' });
  const prefs = await env.WRK_KV.get(`prefs:${payload.slug}`, { type: 'json' });
  const me = { username: payload.username, slug: payload.slug, profile, prefs };

  // Renew once a token is a day old, so active members stay logged in.
  const now = Math.floor(Date.now() / 1000);
  const limit = payload.born + SESSION_MAX_SECONDS;
  if (payload.born && now < limit && payload.exp - now < SESSION_SECONDS - 60 * 60 * 24)
    me.token = await signJWT({ ...payload, exp: Math.min(now + SESSION_SECONDS, limit) }, env.JWT_SECRET);

  return json(me, 200, corsHeaders);
}

async function savePrefs(req, env, corsHeaders) {
  const payload = await requireAuth(req, env);
  if (!payload) return err('unauthorized', 401, corsHeaders);
  const body = await req.json().catch(() => null);
  if (!body) return err('invalid json', 400, corsHeaders);
  const key = `prefs:${payload.slug}`;
  const prefs = cleanPrefs(body, await env.WRK_KV.get(key, { type: 'json' }) || {});
  await env.WRK_KV.put(key, JSON.stringify(prefs));
  return json(prefs, 200, corsHeaders);
}

// Search suggestions pass through here so Google never sees a visitor's IP or keystrokes.
async function suggest(query, corsHeaders) {
  const q = (query || '').slice(0, 100);
  if (q.length < 2) return json([], 200, corsHeaders);
  const res = await fetch(`https://suggestqueries.google.com/complete/search?client=firefox&oe=utf8&q=${encodeURIComponent(q)}`).catch(() => null);
  const data = res?.ok ? await res.json().catch(() => null) : null;
  const results = Array.isArray(data?.[1]) ? data[1].filter(item => typeof item === 'string').slice(0, 5) : [];
  return json(results, 200, { ...corsHeaders, 'Cache-Control': 'public, max-age=3600' });
}

// ── Profile endpoints ─────────────────────────────────────────────────────────

async function getProfile(slug, env, corsHeaders) {
  const profile = await env.WRK_KV.get(`profile:${slug}`, { type: 'json' });
  if (!profile) return err('profile not found', 404, corsHeaders);
  const visits = parseInt(await env.WRK_KV.get(`visits:${slug}`) || '0');
  return json({ ...profile, visits }, 200, corsHeaders);
}

async function recordVisit(slug, env, corsHeaders) {
  let count = 0;
  try {
    const key = `visits:${slug}`;
    count = parseInt(await env.WRK_KV.get(key) || '0') + 1;
    await env.WRK_KV.put(key, String(count));
  } catch {}
  return json({ visits: count }, 200, corsHeaders);
}

// The one clean form of a t.me/nft link, or null when it isn't one.
function cleanGiftLink(value) {
  const slug = String(value).trim().match(/^(?:https?:\/\/)?t\.me\/nft\/([a-zA-Z0-9]+-\d+)(?:[/?#]|$)/i)?.[1];
  return slug ? `https://t.me/nft/${slug}` : null;
}

async function updateProfile(slug, req, env, corsHeaders) {
  const payload = await requireAuth(req, env);
  if (!payload) return err('unauthorized', 401, corsHeaders);
  if (payload.slug !== slug) return err('forbidden', 403, corsHeaders);

  const existing = await env.WRK_KV.get(`profile:${slug}`, { type: 'json' });
  if (!existing) return err('profile not found', 404, corsHeaders);

  const body = await req.json().catch(() => null);
  if (!body) return err('invalid json', 400, corsHeaders);

  if (!body.displayName?.trim()) return err('display name is required', 400, corsHeaders);
  if (!body.avatar?.trim()) return err('avatar is required', 400, corsHeaders);
  if (!Array.isArray(body.bioStatements) || body.bioStatements.length < 1)
    return err('at least one bio statement is required', 400, corsHeaders);

  const badGift = 'invalid telegram gift URL — expected https://t.me/nft/GiftName-Number';
  const giftInput = String(body.tgGiftUrl || '').trim();
  const tgGiftUrl = cleanGiftLink(giftInput);
  if (giftInput && !tgGiftUrl) return err(badGift, 400, corsHeaders);

  const pinnedGifts = Array.isArray(body.pinnedGifts) ? [...new Set(body.pinnedGifts.map(cleanGiftLink))] : existing.pinnedGifts || [];
  if (pinnedGifts.includes(null)) return err(badGift, 400, corsHeaders);
  if (pinnedGifts.length > 6) return err('you can pin up to 6 gifts', 400, corsHeaders);

  // Only a definite 404 rejects, so a Fragment outage can't block profile saves.
  // Looks for the card image, because Fragment has no .json for some real gifts.
  const newGifts = [...new Set([tgGiftUrl, ...pinnedGifts])].filter(link => link && link !== existing.tgGiftUrl && !existing.pinnedGifts?.includes(link));
  const lookups = await Promise.all(newGifts.map(link => fetch(`https://nft.fragment.com/gift/${link.split('/').pop().toLowerCase()}.webp`, { method: 'HEAD' }).catch(() => null)));
  const missing = newGifts.find((_, i) => lookups[i]?.status === 404);
  if (missing) return err(`that telegram gift does not exist: ${missing}`, 400, corsHeaders);

  let badLink = false;
  const link = (value, schemes) => {
    const safe = safeLink(value, schemes);
    if (safe === null) badLink = true;
    return safe ?? '';
  };
  const media = value => toRawFileUrl(String(value ?? '').trim().startsWith('/') ? String(value).trim() : link(value, ['http:', 'https:'])).slice(0, 500);

  // Appearance options: anything missing or unknown keeps what's saved.
  const pick = (key, allowed) => allowed.includes(body[key]) ? body[key] : existing[key];
  const percent = key => body[key] == null || !Number.isFinite(Number(body[key])) ? existing[key] : Math.min(100, Math.max(0, Math.round(Number(body[key]))));
  const text = (key, max) => body[key] === undefined ? existing[key] : String(body[key] ?? '').trim().slice(0, max);
  const flag = key => body[key] === undefined ? existing[key] : !!body[key];

  const updated = {
    ...existing,
    displayName: body.displayName.trim().slice(0, 50),
    avatar: media(body.avatar),
    bioStatements: body.bioStatements.map(s => String(s).trim()).filter(Boolean).slice(0, 10),
    tabs: (body.tabs || []).slice(0, 8).map(tab => ({
      label: String(tab.label || '').trim().slice(0, 30),
      buttons: (tab.buttons || []).slice(0, 12).map(btn => {
        const base = { text: String(btn.text || '').trim().slice(0, 40), type: btn.type === 'copy' ? 'copy' : 'link' };
        return base.type === 'copy'
          ? { ...base, value: String(btn.value || '').trim().slice(0, 200) }
          : { ...base, url: link(btn.url).slice(0, 500) };
      }).filter(btn => btn.text),
    })).filter(tab => tab.label),
    footer: String(body.footer || '').trim().slice(0, 100),
    background: ['network', 'winter', 'starfield', 'matrix', 'visualizer'].includes(body.background) ? body.background : (existing.background || 'network'),
    ogTitle: String(body.ogTitle || '').trim().slice(0, 60) || null,
    ogDescription: String(body.ogDescription || '').trim().slice(0, 200) || null,
    ogImage: media(body.ogImage) || null,
    musicEnabled: !!body.musicEnabled,
    musicUrl: body.musicEnabled ? media(body.musicUrl) || null : null,
    musicTitle: body.musicEnabled ? String(body.musicTitle || '').trim().slice(0, 80) || null : null,
    bgUrl: media(body.bgUrl) || null,
    bgType: ['image', 'video'].includes(body.bgType) ? body.bgType : null,
    accentColor: /^#[0-9a-fA-F]{6}$/.test(body.accentColor) ? body.accentColor : null,
    tgGiftUrl,
    pinnedGifts,
    avatarShape: pick('avatarShape', ['square', 'rounded', 'circle']),
    corners: pick('corners', ['sharp', 'soft', 'round']),
    cardStyle: pick('cardStyle', ['glass', 'solid', 'clear']),
    buttonStyle: pick('buttonStyle', ['glass', 'outline', 'solid']),
    font: pick('font', ['mono', 'sans', 'serif', 'pixel']),
    nameEffect: pick('nameEffect', ['none', 'glow', 'money']),
    nameColor: body.nameColor === undefined ? existing.nameColor : /^#[0-9a-fA-F]{6}$/.test(body.nameColor) ? body.nameColor : null,
    aka: Array.isArray(body.aka) ? body.aka.filter(name => typeof name === 'string').map(name => name.trim().slice(0, 24)).filter(Boolean).slice(0, 12) : existing.aka,
    status: text('status', 60),
    enterText: text('enterText', 30),
    hideVisits: flag('hideVisits'),
    hideUid: flag('hideUid'),
    bgOpacity: percent('bgOpacity'),
    musicVolume: percent('musicVolume'),
    updatedAt: Date.now(),
  };

  if (badLink) return err('links must be web addresses, like https://example.com', 400, corsHeaders);

  await env.WRK_KV.put(`profile:${slug}`, JSON.stringify(updated));
  return json(updated, 200, corsHeaders);
}

async function deleteUser(slug, req, env, corsHeaders) {
  if (!requireAdmin(req, env)) return err('forbidden', 403, corsHeaders);

  const profile = await env.WRK_KV.get(`profile:${slug}`, { type: 'json' });

  // Clean up uid reverse lookup if profile has one
  if (profile?.uid !== undefined && profile?.uid !== null && profile.uid >= 0)
    await env.WRK_KV.delete(`uid:${profile.uid}`);

  // Find and delete user record by scanning (handles corrupt slugs with no profile)
  const list = await env.WRK_KV.list({ prefix: 'user:' });
  let foundUser = false;
  for (const k of list.keys) {
    const u = await env.WRK_KV.get(k.name, { type: 'json' });
    if (u?.slug === slug) { await env.WRK_KV.delete(k.name); foundUser = true; break; }
  }

  if (profile) await env.WRK_KV.delete(`profile:${slug}`);
  await env.WRK_KV.delete(`visits:${slug}`);
  await env.WRK_KV.delete(`prefs:${slug}`);
  await env.WRK_KV.delete(`code:${slug}`);

  if (!profile && !foundUser) return err('account not found', 404, corsHeaders);
  return json({ deleted: slug }, 200, corsHeaders);
}

async function setUid(req, env, corsHeaders) {
  if (!requireAdmin(req, env)) return err('forbidden', 403, corsHeaders);
  const body = await req.json().catch(() => null);
  if (!body?.slug || body?.uid === undefined || body?.uid === null) return err('slug and uid required', 400, corsHeaders);
  const { slug, uid } = body;
  if (!Number.isInteger(uid)) return err('uid must be an integer', 400, corsHeaders);

  const profile = await env.WRK_KV.get(`profile:${slug}`, { type: 'json' });
  if (!profile) return err('profile not found', 404, corsHeaders);
  await env.WRK_KV.put(`profile:${slug}`, JSON.stringify({ ...profile, uid }));

  if (uid >= 0) await env.WRK_KV.put(`uid:${uid}`, slug);

  const list = await env.WRK_KV.list({ prefix: 'user:' });
  for (const k of list.keys) {
    const u = await env.WRK_KV.get(k.name, { type: 'json' });
    if (u?.slug === slug) { await env.WRK_KV.put(k.name, JSON.stringify({ ...u, uid })); break; }
  }

  if (uid >= 0) {
    const current = parseInt(await env.WRK_KV.get('uid:counter') || '0');
    if (uid >= current) await env.WRK_KV.put('uid:counter', String(uid + 1));
  }

  return json({ slug, uid }, 200, corsHeaders);
}

async function putBadges(slug, req, env, corsHeaders) {
  if (!requireAdmin(req, env)) return err('forbidden', 403, corsHeaders);
  const profile = await env.WRK_KV.get(`profile:${slug}`, { type: 'json' });
  if (!profile) return err('profile not found', 404, corsHeaders);
  const body = await req.json().catch(() => null);
  if (!body || !Array.isArray(body.badges)) return err('badges array required', 400, corsHeaders);
  const ALLOWED = new Set(['admin', 'early', 'tester', 'developer']);
  const badges = [...new Set(body.badges.filter(b => ALLOWED.has(b)))];
  await env.WRK_KV.put(`profile:${slug}`, JSON.stringify({ ...profile, badges }));
  return json({ slug, badges }, 200, corsHeaders);
}

async function listUsers(req, env, corsHeaders) {
  if (!requireAdmin(req, env)) return err('forbidden', 403, corsHeaders);
  const list = await env.WRK_KV.list({ prefix: 'user:' });
  const users = await Promise.all(
    list.keys.map(async k => {
      const u = await env.WRK_KV.get(k.name, { type: 'json' });
      if (!u) return null;
      const profile = await env.WRK_KV.get(`profile:${u.slug}`, { type: 'json' });
      return { username: u.username, slug: u.slug, uid: u.uid ?? null, claimed: !!u.passwordHash, createdAt: u.createdAt, badges: profile?.badges || [] };
    })
  );
  return json(users.filter(Boolean), 200, corsHeaders);
}

// ── Pastebin ──────────────────────────────────────────────────────────────────

async function createPaste(req, env, corsHeaders) {
  const body = await req.json().catch(() => null);
  if (!body?.content) return err('content required', 400, corsHeaders);
  if (typeof body.content !== 'string' || body.content.length > 500_000)
    return err('content too large (max 500KB)', 400, corsHeaders);

  const limitErr = await checkLimits(env, { classA: 1 });
  if (limitErr) return err(limitErr, 429, corsHeaders);

  const id = nanoid();
  const ttl = body.ttl || 60 * 60 * 24 * 30;
  const record = {
    content: body.content,
    lang: body.lang || 'plaintext',
    createdAt: Date.now(),
    expiresAt: Date.now() + ttl * 1000,
  };

  await env.WRK_KV.put(`p:${id}`, JSON.stringify(record), { expirationTtl: ttl });
  await incrementUsage(env, { classA: 1 });
  return json({ id, url: `https://wrk.money/p/?id=${id}` }, 201, corsHeaders);
}

async function getPaste(id, env, corsHeaders) {
  const limitErr = await checkLimits(env, { classB: 1 });
  if (limitErr) return err(limitErr, 429, corsHeaders);

  const raw = await env.WRK_KV.get(`p:${id}`, { type: 'json' });
  await incrementUsage(env, { classB: 1 });

  if (!raw) return err('paste not found', 404, corsHeaders);
  return json(raw, 200, corsHeaders);
}

// ── File Share ────────────────────────────────────────────────────────────────

async function uploadFile(req, env, corsHeaders) {
  const formData = await req.formData().catch(() => null);
  if (!formData) return err('multipart/form-data required', 400, corsHeaders);

  const file = formData.get('file');
  if (!file || typeof file === 'string') return err('file required', 400, corsHeaders);

  const maxFileSize = 100 * 1024 * 1024;
  if (file.size > maxFileSize) return err('file too large (max 100MB)', 400, corsHeaders);

  const limitErr = await checkLimits(env, { storageBytes: file.size, classA: 1 });
  if (limitErr) return err(limitErr, 429, corsHeaders);

  const id = nanoid();
  const ttlParam = formData.get('ttl');
  const ttlOptions = { '1d': 86400, '7d': 604800, '30d': 2592000, never: 0 };
  const ttl = ttlOptions[ttlParam] ?? 604800;

  const bytes = await file.arrayBuffer();
  await env.WRK_FILES.put(id, bytes, {
    httpMetadata: { contentType: file.type || 'application/octet-stream' },
    customMetadata: { name: file.name, size: String(file.size) },
  });

  const meta = {
    name: file.name,
    type: file.type || 'application/octet-stream',
    size: file.size,
    createdAt: Date.now(),
    expiresAt: ttl ? Date.now() + ttl * 1000 : null,
  };
  const kvOpts = ttl ? { expirationTtl: ttl } : {};
  await env.WRK_KV.put(`d:${id}`, JSON.stringify(meta), kvOpts);
  await incrementUsage(env, { storageBytes: file.size, classA: 1 });
  return json({ id, url: `https://wrk.money/d/?id=${id}`, rawUrl: `https://api.wrk.money/d/${id}` }, 201, corsHeaders);
}

async function getFileMeta(id, env, corsHeaders) {
  const meta = await env.WRK_KV.get(`d:${id}`, { type: 'json' });
  await incrementUsage(env, { classB: 1 });
  if (!meta) return err('file not found or expired', 404, corsHeaders);
  if (meta.expiresAt && Date.now() > meta.expiresAt) return err('file expired', 410, corsHeaders);
  return json(meta, 200, corsHeaders);
}

async function getFile(id, env, corsHeaders) {
  const limitErr = await checkLimits(env, { classB: 1 });
  if (limitErr) return err(limitErr, 429, corsHeaders);

  const meta = await env.WRK_KV.get(`d:${id}`, { type: 'json' });
  if (!meta) return err('file not found or expired', 404, corsHeaders);

  if (meta.expiresAt && Date.now() > meta.expiresAt) {
    await env.WRK_FILES.delete(id);
    await env.WRK_KV.delete(`d:${id}`);
    await incrementUsage(env, { classA: 1 });
    return err('file expired', 410, corsHeaders);
  }

  const obj = await env.WRK_FILES.get(id);
  await incrementUsage(env, { classB: 1 });
  if (!obj) return err('file not found', 404, corsHeaders);

  const isInline = meta.type.startsWith('image/') || meta.type.startsWith('audio/') || meta.type.startsWith('video/');
  return new Response(obj.body, {
    headers: {
      'Content-Type': meta.type,
      'Content-Disposition': isInline ? `inline; filename="${meta.name}"` : `attachment; filename="${meta.name}"`,
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      'X-Content-Type-Options': 'nosniff',
      ...corsHeaders,
    },
  });
}

// ── URL Shortener ─────────────────────────────────────────────────────────────

async function createShortUrl(req, env, corsHeaders) {
  const body = await req.json().catch(() => null);
  if (!body?.url) return err('url required', 400, corsHeaders);

  try { new URL(body.url); } catch { return err('invalid url', 400, corsHeaders); }

  const limitErr = await checkLimits(env, { classA: 1 });
  if (limitErr) return err(limitErr, 429, corsHeaders);

  const slug = body.slug || nanoid(6);
  const existing = await env.WRK_KV.get(`s:${slug}`);
  if (existing) return err('slug already taken', 409, corsHeaders);

  await env.WRK_KV.put(`s:${slug}`, body.url);
  await incrementUsage(env, { classA: 1 });
  return json({ slug, url: `https://wrk.money/s/${slug}` }, 201, corsHeaders);
}

async function resolveShortUrl(slug, env) {
  const target = await env.WRK_KV.get(`s:${slug}`);
  await incrementUsage(env, { classB: 1 });
  if (!target) return new Response('not found', { status: 404 });
  return Response.redirect(target, 302);
}

// ── Router ────────────────────────────────────────────────────────────────────

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const origin = req.headers.get('Origin') || '';
    const allowedOrigin = env.ALLOWED_ORIGIN || 'https://wrk.money';
    const corsHeaders = cors(allowedOrigin);

    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    if (origin && origin !== allowedOrigin) {
      return err('forbidden', 403);
    }

    const path = url.pathname;
    const ip = req.headers.get('CF-Connecting-IP') || 'unknown';

    // wrk.money requests — URL shortener + bot OG serving + passthrough
    // skip rate limiting and KV entirely for static asset passthroughs
    if (url.hostname === 'wrk.money') {
      if (path.startsWith('/s/')) {
        if (!await checkRateLimit(env, ip)) return err('rate limit exceeded', 429, corsHeaders);
        return resolveShortUrl(path.slice(3), env);
      }

      const ua = req.headers.get('User-Agent') || '';
      const isBot = /discordbot|twitterbot|facebookexternalhit|facebot|slackbot-linkexpanding|linkedinbot|whatsapp|telegrambot|applebot|iframely/i.test(ua);
      if (isBot) {
        const slug = decodeURIComponent(path.replace(/^\//, '').replace(/\/$/, ''));
        if (slug && !slug.includes('/') && !slug.includes('.')) {
          let profile = await env.WRK_KV.get(`profile:${slug}`, { type: 'json' });
          // Fallback OG data for static pages whose accounts may not be in KV yet
          if (!profile) {
            const STATIC_OG = {
              '$':       { displayName: 'ogkush',  bioStatements: ['cybersecurity student & developer. 999 forever.'], avatar: 'https://wrk.money/wrk_files/giphy.gif' },
              '$$$':     { displayName: 'pulse',   bioStatements: ['just a chill dude. 999 forever.'], avatar: 'https://wrk.money/wrk_files/pulsepfp.png' },
              'insanity':{ displayName: 'jerry',   bioStatements: ['just a chill dude.'], avatar: 'https://wrk.money/wrk_files/jerrypfp.jpg' },
            };
            profile = STATIC_OG[slug] || null;
          }
          if (profile) return serveOGPage(profile, req.url);
        }
      }

      // The script tagging can't read brotli, so the browser's preference stays out of this fetch.
      // Cloudflare still compresses the page on its way to the visitor.
      const upstream = new Request(req);
      upstream.headers.delete('Accept-Encoding');
      return securePage(await fetch(upstream));
    }

    // API requests only past this point. Only writes are limited: one page view reads many
    // avatars and files, and counting a read would cost a KV write per request.
    if (req.method !== 'GET' && !await checkRateLimit(env, ip)) return err('rate limit exceeded', 429, corsHeaders);

    // Auth
    if (req.method === 'POST' && path === '/auth/login')    return login(req, env, corsHeaders, ctx);
    if (req.method === 'POST' && path === '/auth/register') return register(req, env, corsHeaders);
    if (req.method === 'POST' && path === '/auth/setup')    return setupAccount(req, env, corsHeaders);
    if (req.method === 'GET'  && path === '/auth/me')       return getMe(req, env, corsHeaders);
    if (req.method === 'PUT'  && path === '/auth/prefs')    return savePrefs(req, env, corsHeaders);
    if (req.method === 'GET'  && path === '/suggest')       return suggest(url.searchParams.get('q'), corsHeaders);

    // Profiles
    if (req.method === 'GET' && path.startsWith('/profile/'))
      return getProfile(path.slice(9), env, corsHeaders);
    if (req.method === 'PUT' && path.startsWith('/profile/'))
      return updateProfile(path.slice(9), req, env, corsHeaders);

    // Directory + MOTD
    if (req.method === 'GET'  && path === '/directory')    return getDirectory(req, env, corsHeaders);
    if (req.method === 'GET'  && path === '/motd')         return getMOTD(env, corsHeaders);
    if (req.method === 'PUT'  && path === '/admin/motd')   return setMOTD(req, env, corsHeaders);

    // Admin
    if (req.method === 'GET'    && path === '/admin/users')              return listUsers(req, env, corsHeaders);
    if (req.method === 'POST'   && path === '/admin/code')               return issueCode(req, env, corsHeaders);
    if (req.method === 'DELETE' && path.startsWith('/admin/user/'))     return deleteUser(path.slice(12), req, env, corsHeaders);
    if (req.method === 'PUT'    && path === '/admin/uid')               return setUid(req, env, corsHeaders);
    if (req.method === 'PUT'  && path.startsWith('/admin/badges/')) return putBadges(path.slice(14), req, env, corsHeaders);
    if (req.method === 'POST' && path.startsWith('/visit/'))        return recordVisit(path.slice(7), env, corsHeaders);

    // Pastebin
    if (req.method === 'POST' && path === '/p') return createPaste(req, env, corsHeaders);
    if (req.method === 'GET'  && path.startsWith('/p/')) return getPaste(path.slice(3), env, corsHeaders);

    // File share
    if (req.method === 'POST' && path === '/d') return uploadFile(req, env, corsHeaders);
    if (req.method === 'GET'  && path.startsWith('/d/') && path.endsWith('/meta')) return getFileMeta(path.slice(3, -5), env, corsHeaders);
    if (req.method === 'GET'  && path.startsWith('/d/')) return getFile(path.slice(3), env, corsHeaders);

    // URL shortener API
    if (req.method === 'POST' && path === '/s') return createShortUrl(req, env, corsHeaders);
    if (req.method === 'GET'  && path.startsWith('/s/')) return resolveShortUrl(path.slice(3), env);

    if (path === '/usage') {
      const usage = await getUsage(env);
      return json({ usage, limits: LIMITS }, 200, corsHeaders);
    }

    return err('not found', 404, corsHeaders);
  },
};
