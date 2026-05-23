const LIMITS = {
  storageBytes: 10 * 1024 * 1024 * 1024,
  classA: 1_000_000,
  classB: 10_000_000,
};

const RATE_LIMIT_WINDOW = 60;
const RATE_LIMIT_MAX = 20;

const RESERVED_SLUGS = new Set([
  '$', '$$', '$$$', 'insanity', 'startpage', 'tools', '404',
  'p', 'd', 's', 'login', 'admin', 'settings', 'profile',
  'wrk_files', 'api', 'index', 'favicon', 'cname', 'readme',
  'auth', 'usage', 'robots.txt', 'sitemap.xml', 'assets', 'directory',
]);

// ── Helpers ───────────────────────────────────────────────────────────────────

function monthKey() {
  const d = new Date();
  return `usage:${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function nanoid(len = 8) {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
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

async function getShoutbox(req, env, corsHeaders) {
  const payload = await requireAuth(req, env);
  if (!payload) return err('unauthorized', 401, corsHeaders);
  const messages = await env.WRK_KV.get('shoutbox', { type: 'json' }) || [];
  return json(messages, 200, corsHeaders);
}

async function postShoutbox(req, env, corsHeaders) {
  const payload = await requireAuth(req, env);
  if (!payload) return err('unauthorized', 401, corsHeaders);
  const body = await req.json().catch(() => null);
  const text = String(body?.text || '').trim().slice(0, 140);
  if (!text) return err('message required', 400, corsHeaders);
  if (await env.WRK_KV.get(`shoutbox_rl:${payload.slug}`)) return err('slow down', 429, corsHeaders);
  await env.WRK_KV.put(`shoutbox_rl:${payload.slug}`, '1', { expirationTtl: 5 });
  const profile = await env.WRK_KV.get(`profile:${payload.slug}`, { type: 'json' });
  const message = {
    slug: payload.slug,
    uid: profile?.uid ?? null,
    displayName: profile?.displayName || payload.username,
    avatar: profile?.avatar || '',
    text,
    timestamp: Date.now(),
  };
  const messages = await env.WRK_KV.get('shoutbox', { type: 'json' }) || [];
  messages.push(message);
  if (messages.length > 50) messages.splice(0, messages.length - 50);
  await env.WRK_KV.put('shoutbox', JSON.stringify(messages));
  return json(message, 201, corsHeaders);
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
  const key = `rl:${ip}:${Math.floor(Date.now() / 1000 / RATE_LIMIT_WINDOW)}`;
  const count = parseInt(await env.WRK_KV.get(key) || '0');
  if (count >= RATE_LIMIT_MAX) return false;
  await env.WRK_KV.put(key, String(count + 1), { expirationTtl: RATE_LIMIT_WINDOW * 2 });
  return true;
}

// ── Usage tracking ────────────────────────────────────────────────────────────

async function getUsage(env) {
  const raw = await env.WRK_KV.get(monthKey(), { type: 'json' });
  return raw || { storageBytes: 0, classA: 0, classB: 0 };
}

async function incrementUsage(env, delta) {
  const key = monthKey();
  const usage = await getUsage(env);
  const updated = {
    storageBytes: usage.storageBytes + (delta.storageBytes || 0),
    classA: usage.classA + (delta.classA || 0),
    classB: usage.classB + (delta.classB || 0),
  };
  await env.WRK_KV.put(key, JSON.stringify(updated), { expirationTtl: 60 * 60 * 24 * 35 });
  return updated;
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

async function hashPassword(password, salt) {
  const data = new TextEncoder().encode(salt + password);
  const buf = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
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
  return verifyJWT(token, env.JWT_SECRET);
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

async function login(req, env, corsHeaders) {
  const body = await req.json().catch(() => null);
  if (!body?.username || !body?.password) return err('username and password required', 400, corsHeaders);

  const user = await env.WRK_KV.get(`user:${body.username.toLowerCase()}`, { type: 'json' });
  if (!user) return err('invalid credentials', 401, corsHeaders);

  if (!user.passwordHash) return err('account not yet claimed — set your password first', 403, corsHeaders);

  const hash = await hashPassword(body.password, user.salt);
  if (hash !== user.passwordHash) return err('invalid credentials', 401, corsHeaders);

  const token = await signJWT(
    { username: user.username, slug: user.slug, exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30 },
    env.JWT_SECRET
  );

  return json({ token, username: user.username, slug: user.slug }, 200, corsHeaders);
}

async function setupAccount(req, env, corsHeaders) {
  const body = await req.json().catch(() => null);
  if (!body?.slug || !body?.password) return err('slug and password required', 400, corsHeaders);
  if (body.password.length < 8) return err('password must be at least 8 characters', 400, corsHeaders);

  const slug = body.slug.trim();
  const user = await env.WRK_KV.get(`user:${slug}`, { type: 'json' });
  if (!user) return err('no account found for that slug', 404, corsHeaders);
  if (user.passwordHash) return err('account already claimed', 409, corsHeaders);

  const salt = nanoid(16);
  const passwordHash = await hashPassword(body.password, salt);
  const updated = { ...user, passwordHash, salt };
  await env.WRK_KV.put(`user:${slug}`, JSON.stringify(updated));

  const token = await signJWT(
    { username: user.username, slug: user.slug, exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30 },
    env.JWT_SECRET
  );

  return json({ token, username: user.username, slug: user.slug }, 200, corsHeaders);
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
  return json({ username: payload.username, slug: payload.slug, profile }, 200, corsHeaders);
}

// ── Profile endpoints ─────────────────────────────────────────────────────────

async function getProfile(slug, env, corsHeaders) {
  const profile = await env.WRK_KV.get(`profile:${slug}`, { type: 'json' });
  if (!profile) return err('profile not found', 404, corsHeaders);
  const visits = parseInt(await env.WRK_KV.get(`visits:${slug}`) || '0');
  return json({ ...profile, visits }, 200, corsHeaders);
}

async function recordVisit(slug, env, corsHeaders) {
  const key = `visits:${slug}`;
  const count = parseInt(await env.WRK_KV.get(key) || '0') + 1;
  await env.WRK_KV.put(key, String(count));
  return json({ visits: count }, 200, corsHeaders);
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

  const tgGiftUrl = String(body.tgGiftUrl || '').trim() || null;
  if (tgGiftUrl && !/^https:\/\/t\.me\/nft\/[a-zA-Z0-9]+-\d+$/.test(tgGiftUrl))
    return err('invalid telegram gift URL — expected https://t.me/nft/GiftName-Number', 400, corsHeaders);

  const updated = {
    ...existing,
    displayName: body.displayName.trim().slice(0, 50),
    avatar: toRawFileUrl(body.avatar.trim()).slice(0, 500),
    bioStatements: body.bioStatements.map(s => String(s).trim()).filter(Boolean).slice(0, 10),
    tabs: (body.tabs || []).slice(0, 8).map(tab => ({
      label: String(tab.label || '').trim().slice(0, 30),
      buttons: (tab.buttons || []).slice(0, 12).map(btn => {
        const base = { text: String(btn.text || '').trim().slice(0, 40), type: btn.type === 'copy' ? 'copy' : 'link' };
        return base.type === 'copy'
          ? { ...base, value: String(btn.value || '').trim().slice(0, 200) }
          : { ...base, url: String(btn.url || '').trim().slice(0, 500) };
      }).filter(btn => btn.text),
    })).filter(tab => tab.label),
    footer: String(body.footer || '').trim().slice(0, 100),
    background: ['network', 'winter', 'starfield', 'matrix', 'visualizer'].includes(body.background) ? body.background : (existing.background || 'network'),
    ogTitle: String(body.ogTitle || '').trim().slice(0, 60) || null,
    ogDescription: String(body.ogDescription || '').trim().slice(0, 200) || null,
    ogImage: toRawFileUrl(String(body.ogImage || '').trim()).slice(0, 500) || null,
    musicEnabled: !!body.musicEnabled,
    musicUrl: body.musicEnabled ? toRawFileUrl(String(body.musicUrl || '').trim()).slice(0, 500) || null : null,
    musicTitle: body.musicEnabled ? String(body.musicTitle || '').trim().slice(0, 80) || null : null,
    bgUrl: toRawFileUrl(String(body.bgUrl || '').trim()).slice(0, 500) || null,
    bgType: ['image', 'video'].includes(body.bgType) ? body.bgType : null,
    accentColor: /^#[0-9a-fA-F]{6}$/.test(body.accentColor) ? body.accentColor : null,
    tgGiftUrl,
    updatedAt: Date.now(),
  };

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
  async fetch(req, env) {
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

    const ip = req.headers.get('CF-Connecting-IP') || 'unknown';
    const allowed = await checkRateLimit(env, ip);
    if (!allowed) return err('rate limit exceeded', 429, corsHeaders);

    const path = url.pathname;

    // wrk.money requests — URL shortener + bot OG serving + passthrough
    if (url.hostname === 'wrk.money') {
      if (path.startsWith('/s/')) return resolveShortUrl(path.slice(3), env);

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

      return fetch(req);
    }

    // Auth
    if (req.method === 'POST' && path === '/auth/login')    return login(req, env, corsHeaders);
    if (req.method === 'POST' && path === '/auth/register') return register(req, env, corsHeaders);
    if (req.method === 'POST' && path === '/auth/setup')    return setupAccount(req, env, corsHeaders);
    if (req.method === 'GET'  && path === '/auth/me')       return getMe(req, env, corsHeaders);

    // Profiles
    if (req.method === 'GET' && path.startsWith('/profile/'))
      return getProfile(path.slice(9), env, corsHeaders);
    if (req.method === 'PUT' && path.startsWith('/profile/'))
      return updateProfile(path.slice(9), req, env, corsHeaders);

    // Directory + MOTD + Shoutbox
    if (req.method === 'GET'  && path === '/directory')    return getDirectory(req, env, corsHeaders);
    if (req.method === 'GET'  && path === '/motd')         return getMOTD(env, corsHeaders);
    if (req.method === 'PUT'  && path === '/admin/motd')   return setMOTD(req, env, corsHeaders);
    if (req.method === 'GET'  && path === '/shoutbox')     return getShoutbox(req, env, corsHeaders);
    if (req.method === 'POST' && path === '/shoutbox')     return postShoutbox(req, env, corsHeaders);

    // Admin
    if (req.method === 'GET'    && path === '/admin/users')              return listUsers(req, env, corsHeaders);
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
