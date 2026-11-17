// Telegram gift tools carried over from clue.tg: its monochrome scores, and the gift tracker with its bot.

// Members' watches and the tracker's memory live in R2, which reads back what was just written anywhere
// and allows far more writes than KV's 1,000 a day.
export const WATCHES = 'track/watches.json';
const STATE = 'track/state.json';
export const TRACK_CRON = '* * * * *';
export const MAX_TRACKED = 20;
export const LINK_SECONDS = 10 * 60;
export const ALERTS = ['transfer', 'sold', 'listed', 'chain'];
// A run may make 50 requests on the free plan: up to 12 channel pages, then a gift page and, every 5 minutes, a Fragment page per gift,
// which leaves room for the alerts.
// ponytail: past this many watched gifts a run checks a rotating slice, so each is checked less often. The paid plan's 1,000 subrequests would allow far more.
const GIFTS_PER_RUN = 12;

// The public channels where these markets post their sales and new listings.
const CHANNELS = { TonnelGift: 'Tonnel', portals_notifications: 'Portals', mrktnotification: 'MRKT' };
// While a gift sits on one of these markets, its page names the market's own account as the owner.
const MARKET_OWNERS = { 'name:gift relayer': 'Tonnel', 'name:portal': 'Portals', 'name:mrkt bank': 'MRKT' };

const UA = { 'User-Agent': 'Mozilla/5.0' };
const timeout = () => AbortSignal.timeout(8000);
const text = url => fetch(url, { headers: UA, signal: timeout() }).then(res => res.ok ? res.text() : null).catch(() => null);
const getJSON = url => fetch(url, { signal: timeout() }).then(res => res.ok ? res.json() : null).catch(() => null);

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const decode = s => s.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (all, e) =>
  e[0] !== '#' ? ENTITIES[e.toLowerCase()] ?? all : String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1))));
const plain = html => decode(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export const sha256 = async value =>
  Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), b => b.toString(16).padStart(2, '0')).join('');

// The lowercase slug-number a gift goes by, from a t.me or Fragment link, or typed bare like clue.tg allowed.
export function giftKey(input) {
  const m = String(input ?? '').trim().match(/^(?:(?:https?:\/\/)?(?:t\.me\/nft|telegram\.me\/nft|(?:nft\.)?fragment\.com\/gift)\/)?([a-z0-9]+)-(\d{1,9})(?:[/?#.]|$)/i);
  return m && Number(m[2]) > 0 ? `${m[1].toLowerCase()}-${Number(m[2])}` : null;
}

// A gift's public t.me page: its name, traits and current owner. Null when the page isn't that gift's.
export function parseGiftPage(html, key) {
  const name = decode(html.match(/<meta property="og:title" content="([^"]*)"/)?.[1] ?? '');
  if (!name.endsWith(`#${key.split('-')[1]}`)) return null;
  const cell = th => html.match(new RegExp(`<tr>\\s*<th>\\s*${th}\\s*</th>\\s*<td[^>]*>([\\s\\S]*?)</td>`, 'i'))?.[1];
  const trait = th => plain((cell(th) ?? '').replace(/<mark>[\s\S]*?<\/mark>/gi, ''));

  // An exported gift shows its TON wallet. One still on Telegram shows a username, or just a display name.
  const owner = cell('Owner') ?? '';
  const wallet = owner.match(/tgme_gift_owner_address[^>]*>([^<]+)</)?.[1];
  const user = owner.match(/href="https:\/\/t\.me\/([A-Za-z0-9_]{3,})"/)?.[1];
  const label = wallet ? decode(wallet).trim() : user ? `@${user}` : plain(owner);
  return {
    name, model: trait('Model'), backdrop: trait('Backdrop'), symbol: trait('Symbol'),
    owner: !label ? null : wallet ? { key: `ton:${label}`, label, chain: true } : { key: user ? `tg:${user.toLowerCase()}` : `name:${label.toLowerCase()}`, label },
  };
}

// t.me sends a gift that doesn't exist somewhere else. Any other failure is an outage, not an answer, and gives null.
export async function fetchGift(key) {
  const res = await fetch(`https://t.me/nft/${key}`, { headers: UA, redirect: 'manual', signal: timeout() }).catch(() => null);
  if (res?.status >= 300 && res.status < 400) return { missing: true };
  return res?.ok ? parseGiftPage(await res.text(), key) : null;
}

// clue.tg's scores: byte N of mono/<collection> is gift #N's, and 255 means clue.tg had none.
export async function storedScore(env, key) {
  const [slug, number] = key.split('-');
  const obj = await env.WRK_FILES.get(`mono/${slug}`, { range: { offset: Number(number), length: 1 } }).catch(() => null);
  const [score] = obj ? new Uint8Array(await new Response(obj.body).arrayBuffer()) : [];
  return score <= 100 ? score : null;
}

export const monoLabel = score => score >= 80 ? 'strong match' : score >= 55 ? 'partial match' : 'low match';

// ── Watches ──────────────────────────────────────────────────────────────────

async function readJSON(env, key) {
  const obj = await env.WRK_FILES.get(key);
  return obj ? { data: JSON.parse(await new Response(obj.body).text()), etag: obj.etag } : {};
}

export const readWatches = async env => (await readJSON(env, WATCHES)).data ?? { members: {}, links: {} };

// Changes the watch list without losing a change made at the same moment, since a write only lands on the copy it read.
// change returns false to leave the list as it was.
export async function updateWatches(env, change) {
  for (let i = 0; i < 5; i++) {
    const { data = { members: {}, links: {} }, etag } = await readJSON(env, WATCHES);
    const result = change(data);
    if (result === false) return false;
    // ponytail: the very first write has nothing to match, so a race there could drop one change, once
    if (await env.WRK_FILES.put(WATCHES, JSON.stringify(data), etag ? { onlyIf: { etagMatches: etag } } : {})) return result;
  }
  throw new Error('the watch list kept changing');
}

// Adds a gift or changes its alerts. New gifts start with every alert on. False when the member's list is full.
export function saveWatch(data, slug, key, alerts, name, now) {
  const member = data.members[slug] ??= { gifts: {} };
  const old = member.gifts[key];
  if (!old && Object.keys(member.gifts).length >= MAX_TRACKED) return false;
  member.gifts[key] = { name: old?.name ?? name, since: old?.since ?? now };
  for (const alert of ALERTS) member.gifts[key][alert] = typeof alerts?.[alert] === 'boolean' ? alerts[alert] : old?.[alert] ?? true;
  return true;
}

// Ties a chat to the member who made the code on the tracker page. A code works once, and each side has one link.
// Codes are kept hashed, the way the account codes are.
export function linkChat(data, codeHash, chat, now) {
  const link = data.links[codeHash];
  if (!link || link.expires < now) return false;
  delete data.links[codeHash];
  for (const member of Object.values(data.members)) if (member.chat === chat) delete member.chat;
  (data.members[link.slug] ??= { gifts: {} }).chat = chat;
  return link.slug;
}

// What the tracker page shows: each gift with its alerts and last known owner.
export async function trackedList(env, slug) {
  const [watches, { data: state }] = await Promise.all([readWatches(env), readJSON(env, STATE)]);
  const member = watches.members[slug] ?? { gifts: {} };
  const gifts = Object.entries(member.gifts).map(([key, watch]) => ({
    key, name: watch.name, owner: state?.gifts?.[key]?.owner?.label ?? null,
    ...Object.fromEntries(ALERTS.map(alert => [alert, watch[alert]])),
  }));
  return { bot: env.TG_BOT_USERNAME || null, linked: !!member.chat, gifts };
}

// ── Tracker ──────────────────────────────────────────────────────────────────

// Posts from a channel's public page, oldest first.
export function parseChannel(html) {
  return html.split('data-post="').slice(1).map(block => {
    const body = block.match(/tgme_widget_message_text[^>]*>([\s\S]*?)<\/div>/)?.[1] ?? '';
    const words = plain(body);
    return {
      id: Number(block.match(/^[^"]*\/(\d+)"/)?.[1]),
      gift: giftKey(body.match(/t(?:elegram)?\.me\/nft\/[a-z0-9]+-\d+/i)?.[0]),
      kind: /\bgift sold\b/i.test(words) ? 'sold' : /\bnew gift listed\b/i.test(words) ? 'listed' : null,
      price: Number(words.match(/price:\s*([\d.,]+)\s*\$?(?:ton|gram)\b/i)?.[1].replace(/,/g, '')) || null,
      time: Date.parse(block.match(/<time datetime="([^"]+)"/)?.[1]) || 0,
    };
  }).filter(post => post.id);
}

// What a channel posted since the last post read, up to four pages back. MRKT has posted 30 sales in 40 seconds.
// Each page is about 0.3 ms of the free plan's 10 ms of CPU.
// ponytail: a market posting over 80 times between runs loses its oldest posts; page further back if alerts go missing and CPU allows
async function newPosts(channel, last) {
  const posts = [];
  for (let before = ''; posts.length < 80; before = `?before=${posts[0].id}`) {
    const html = await text(`https://t.me/s/${channel}${before}`);
    const page = html ? parseChannel(html) : [];
    if (!page.length) break;
    posts.unshift(...page);
    if (!last || page[0].id <= last + 1) break;
  }
  return posts;
}

// A gift listed on Fragment shows "Sell Price". Once it's sold, the table says "Sale Price" instead.
export function fragmentPrice(html) {
  const price = html.includes('Sell Price') && html.match(/tm-value icon-before icon-ton">([\d,]+(?:\.\d+)?)</)?.[1];
  return price ? Number(price.replace(/,/g, '')) : null;
}

// An exported gift listed on GetGems belongs to a GetGems sale contract, whose price tonapi can read.
async function getgemsPrice(owner) {
  const account = await getJSON(`https://tonapi.io/v2/accounts/${encodeURIComponent(owner)}`);
  const sale = account?.interfaces?.find(name => name.startsWith('nft_sale_getgems'));
  if (!sale) return null;
  const version = sale.split('_').pop();
  const method = version.startsWith('v') ? `get_fix_price_data_${version}` : 'get_sale_data';
  const data = await getJSON(`https://tonapi.io/v2/blockchain/accounts/${encodeURIComponent(account.address)}/methods/${method}`);
  return Number(data?.decoded?.full_price) / 1e9 || null;
}

const grams = price => price ? ` for ${price.toLocaleString('en-US')} GRAM` : '';

// A sale names the new owner only once the page shows someone other than who had it before, and not a market's own account.
export function alertText(event, gift = {}) {
  const name = `<b>${esc(gift.name || event.gift)}</b>`;
  const buyer = event.kind === 'sold' && event.from && gift.owner && gift.owner.key !== event.from && !MARKET_OWNERS[gift.owner.key];
  const owner = buyer ? ` — new owner: ${esc(gift.owner.label)}` : '';
  return {
    transfer: () => `🔁 ${name} was transferred to ${esc(MARKET_OWNERS[event.to.key] || event.to.label)}`,
    sold: () => `💰 ${name} sold on ${event.market}${grams(event.price)}${owner}`,
    listed: () => `🏷 ${name} was listed on ${event.market}${grams(event.price)}`,
    chain: () => `⛓ ${name} was moved to the TON blockchain — wallet: <code>${esc(event.to.label)}</code>`,
  }[event.kind]();
}

const message = (chat, words, key) => ({
  chat_id: chat, text: words, parse_mode: 'HTML', disable_web_page_preview: true,
  ...(key && { reply_markup: { inline_keyboard: [[{ text: 'view gift', url: `https://t.me/nft/${key}` }]] } }),
});

// A refusal shows in `wrangler tail`, since nobody sees a message that never arrived.
const telegram = (env, method, body) => fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/${method}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: timeout(),
}).then(res => res.json()).catch(() => null).then(res => {
  if (!res?.ok) console.log(`telegram ${method} failed: ${res?.description ?? 'no answer'}`);
  return res;
});

const botSecret = async env => (await sha256(`webhook:${env.TG_BOT_TOKEN}`)).slice(0, 32);

// Points the bot at this worker the first time it runs with a token, and again whenever the token changes.
async function connectBot(env, state) {
  const secret = await botSecret(env);
  const tag = (await sha256(secret)).slice(0, 16);
  if (state.bot === tag) return;
  const res = await telegram(env, 'setWebhook', { url: 'https://api.wrk.money/tg/webhook', secret_token: secret, allowed_updates: ['message'] });
  if (res?.ok) state.bot = tag;
}

// Runs every minute. Reads the market channels and each watched gift's page, and messages whoever watches a gift that changed.
export async function trackGifts(env, now = Date.now()) {
  if (!env.TG_BOT_TOKEN) return;
  const { data: state = { gifts: {}, posts: {} } } = await readJSON(env, STATE);
  const before = JSON.stringify(state);
  await connectBot(env, state);

  const watchers = {};
  for (const member of Object.values((await readWatches(env)).members))
    if (member.chat) for (const [key, watch] of Object.entries(member.gifts)) (watchers[key] ??= []).push({ chat: member.chat, ...watch });
  const keys = Object.keys(watchers).sort();
  const events = [];

  if (keys.length) {
    for (const [channel, market] of Object.entries(CHANNELS)) {
      const last = state.posts[channel];
      const posts = await newPosts(channel, last);
      if (posts.length) state.posts[channel] = Math.max(last ?? 0, posts.at(-1).id);
      // The first run only notes where the channel is.
      for (const post of last ? posts.filter(p => p.id > last && p.kind && watchers[p.gift]) : []) {
        events.push({ ...post, market, from: state.gifts[post.gift]?.owner?.key });
        if (post.kind === 'sold') (state.gifts[post.gift] ??= {}).soldAt = now;
      }
    }

    const run = Math.floor(now / 60_000);
    const start = (run * GIFTS_PER_RUN) % keys.length;
    for (const key of keys.length > GIFTS_PER_RUN ? [...keys, ...keys].slice(start, start + GIFTS_PER_RUN) : keys) {
      const page = await fetchGift(key);
      if (!page?.owner) continue;
      const old = state.gifts[key] ?? {};
      state.gifts[key] = { ...old, name: page.name, owner: page.owner };
      // The first look at a gift only notes who has it.
      if (old.owner && old.owner.key !== page.owner.key) {
        const price = page.owner.chain && await getgemsPrice(page.owner.label);
        if (price) events.push({ kind: 'listed', gift: key, market: 'GetGems', price, time: now });
        else if (page.owner.chain && !old.owner.chain) events.push({ kind: 'chain', gift: key, to: page.owner, time: now });
        // A sale already says who has it now, so the move that follows isn't sent as well.
        else if (!(old.soldAt > now - 10 * 60_000)) events.push({ kind: 'transfer', gift: key, to: page.owner, time: now });
      }
      // ponytail: Fragment is read every 5 minutes, near clue.tg's 3, to save subrequests
      if (page.owner.chain && run % 5 === 0) {
        const html = await text(`https://fragment.com/gift/${key}`);
        const price = html === null ? old.fragment : fragmentPrice(html);
        if (price && price !== old.fragment) events.push({ kind: 'listed', gift: key, market: 'Fragment', price, time: now });
        state.gifts[key].fragment = price ?? null;
      }
    }
  }

  for (const event of events)
    for (const watch of watchers[event.gift])
      if (watch[event.kind] && event.time >= watch.since)
        await telegram(env, 'sendMessage', message(watch.chat, alertText(event, state.gifts[event.gift]), event.gift));

  // A gift nobody watches any more is forgotten, so watching it again starts fresh.
  for (const key of Object.keys(state.gifts)) if (!watchers[key]) delete state.gifts[key];
  if (JSON.stringify(state) !== before) await env.WRK_FILES.put(STATE, JSON.stringify(state));
}

// ── Bot ──────────────────────────────────────────────────────────────────────

const PAGE = 'https://wrk.money/tools/tracker';
const BOT_START = `this bot sends wrk.money members alerts about the telegram gifts they track.\n\nto link this chat, open ${PAGE}, press "link telegram" and send me the code it shows.`;
const BOT_HELP = `/list — the gifts you track\n/mono &lt;gift link&gt; — the gift's monochrome score\n/stop — stop alerts in this chat\n\nadd gifts or change alerts at ${PAGE}`;

export async function botUpdate(req, env) {
  if (!env.TG_BOT_TOKEN || req.headers.get('X-Telegram-Bot-Api-Secret-Token') !== await botSecret(env)) return new Response('forbidden', { status: 403 });
  const msg = (await req.json().catch(() => null))?.message;
  if (msg?.chat?.type !== 'private' || typeof msg.text !== 'string') return new Response('ok');
  // Telegram takes the reply as the answer to its request, which saves sending it separately.
  return Response.json({ method: 'sendMessage', ...message(msg.chat.id, await botReply(env, msg.chat.id, msg.text.trim())) });
}

async function botReply(env, chat, words) {
  const [first, arg = ''] = words.split(/\s+(.*)/s);
  const command = first.toLowerCase().replace(/@\w+$/, '');
  // The code may come alone, or after /start or /link.
  const code = (/^[a-z0-9]{8}$/i.test(first) ? first : ['/start', '/link'].includes(command) ? arg : '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (code) {
    const codeHash = await sha256(code);
    const slug = await updateWatches(env, data => linkChat(data, codeHash, chat, Date.now()));
    return slug ? `linked to <b>${esc(slug)}</b>. alerts for the gifts you track on wrk.money come here.` : `that code is wrong or has run out. make a new one at ${PAGE}`;
  }

  const watches = await readWatches(env);
  const slug = Object.keys(watches.members).find(name => watches.members[name].chat === chat);
  if (!slug) return BOT_START;

  if (command === '/list') {
    const { gifts } = await trackedList(env, slug);
    const lines = gifts.map(g => `• <a href="https://t.me/nft/${g.key}">${esc(g.name || g.key)}</a>${g.owner ? ` — ${esc(g.owner)}` : ''}`);
    return lines.length ? lines.join('\n') : `you're not tracking any gifts yet. add some at ${PAGE}`;
  }
  if (command === '/mono') {
    const key = giftKey(arg);
    if (!key) return 'send a gift link with it, like /mono t.me/nft/ScaredCat-845';
    const score = await storedScore(env, key);
    return score === null
      ? `there's no stored score for ${esc(key)}. https://wrk.money/tools/mono works it out from the gift's animation.`
      : `<b>${esc(key)}</b>: ${score}% — ${monoLabel(score)}`;
  }
  if (command === '/stop') {
    await updateWatches(env, data => { delete data.members[slug].chat; });
    return `alerts stopped. link this chat again from ${PAGE} any time.`;
  }
  return BOT_HELP;
}
