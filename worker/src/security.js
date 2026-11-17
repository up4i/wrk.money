// Security headers for wrk.money pages, and the check on links members save.

const PAGE_HEADERS = {
  'Strict-Transport-Security': 'max-age=15552000',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

// Use Content-Security-Policy-Report-Only to log what it would block without blocking it.
export const CSP_HEADER = 'Content-Security-Policy';

// The swap page talks to TON wallets through their bridges, and gets quotes from the aggregators.
// The bridges come from https://config.ton.org/wallets-v2.json as of 2026-11-17.
// ponytail: a wallet added to that list later with a new bridge can't connect until its host is here.
const SWAP_HOSTS = [
  'https://config.ton.org', 'https://api.ston.fi', 'wss://omni-ws.ston.fi',
  'https://backend.swap.coffee', 'https://tokens.swap.coffee', 'https://mainnet.api.dedust.io', 'https://s.ton-connect.io',
  'https://api-node.bybit.com', 'https://api.defiway.com', 'https://bridge.mirai.app', 'https://bridge.stower.money',
  'https://bridge.tonapi.io', 'https://bridge.uxuy.me', 'https://bridge.wallet.coffee.agency', 'https://connect.token.im',
  'https://connect.ton.org', 'https://connect.tonhubapi.com', 'https://dapp.gateio.services', 'https://go-bridge.tomo.inc',
  'https://sse-bridge.hot-labs.org', 'https://tc.architecton.su', 'https://ton-bridge.safepal.com',
  'https://ton-connect-bridge.bgwapi.io', 'https://ton-connect-bridge.echooo.link', 'https://ton-connect.mytokenpocket.vip',
  'https://tonbridge.telegram.org', 'https://tonconnectbridge.mytonwallet.org', 'https://wallet.binance.com',
  'https://walletbot.me', 'https://web3-bridge.kolo.in', 'https://web3.okx.com', 'https://www.okx.com',
];

// Only scripts carrying the page's nonce can run, which rules out injected
// attributes and javascript: links. Members' media can come from any https host.
export function pagePolicy(nonce, api = 'https://api.wrk.money', path = '/') {
  const swap = path.startsWith('/tools/swap') ? ` ${SWAP_HOSTS.join(' ')}` : '';
  return [
    "default-src 'self'",
    `script-src 'nonce-${nonce}' 'strict-dynamic' https:`,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdnjs.cloudflare.com",
    'font-src https://fonts.gstatic.com',
    "img-src 'self' https: data: blob:",
    "media-src 'self' https: blob:",
    `connect-src 'self' ${api} https://nft.fragment.com https://dns.google https://ipinfo.io https://urlscan.io${swap}`,
    "form-action 'self' https://www.startpage.com",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "object-src 'none'",
  ].join('; ');
}

export function securePage(res, path) {
  const page = new Response(res.body, res);
  for (const [name, value] of Object.entries(PAGE_HEADERS)) page.headers.set(name, value);

  // A 304 keeps the policy stored with the cached page, whose nonce matches it.
  const isHtml = (res.headers.get('Content-Type') || '').includes('text/html');
  if (!isHtml || res.status === 304) return page;

  const nonce = crypto.randomUUID().replaceAll('-', '');
  page.headers.set(CSP_HEADER, pagePolicy(nonce, undefined, path));
  return new HTMLRewriter()
    .on('script', { element: el => el.setAttribute('nonce', nonce) })
    .transform(page);
}

// Returns a safe version of a saved link, or null if it can't be allowed.
// Bare domains like t.me/name get https://, so they don't turn into wrk.money paths.
export function safeLink(value, schemes = ['http:', 'https:', 'mailto:']) {
  const link = String(value ?? '').trim();
  if (!link) return '';
  const full = /^[a-z][a-z0-9+.-]*:/i.test(link) ? link : `https://${link}`;
  try {
    return schemes.includes(new URL(full).protocol) ? full : null;
  } catch {
    return null;
  }
}
