// Security headers for wrk.money pages, and the check on links members save.

const PAGE_HEADERS = {
  'Strict-Transport-Security': 'max-age=15552000',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

// Report-Only logs what the policy would block without blocking it.
export const CSP_HEADER = 'Content-Security-Policy-Report-Only';

// Only scripts carrying the page's nonce can run, which rules out injected
// attributes and javascript: links. Members' media can come from any https host.
export function pagePolicy(nonce, api = 'https://api.wrk.money') {
  return [
    "default-src 'self'",
    `script-src 'nonce-${nonce}' 'strict-dynamic' https:`,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdnjs.cloudflare.com",
    'font-src https://fonts.gstatic.com',
    "img-src 'self' https: data: blob:",
    "media-src 'self' https: blob:",
    `connect-src 'self' ${api} https://nft.fragment.com https://dns.google https://ipinfo.io https://urlscan.io`,
    "form-action 'self' https://www.startpage.com",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "object-src 'none'",
  ].join('; ');
}

export function securePage(res) {
  const page = new Response(res.body, res);
  for (const [name, value] of Object.entries(PAGE_HEADERS)) page.headers.set(name, value);

  // A 304 keeps the policy stored with the cached page, whose nonce matches it.
  const isHtml = (res.headers.get('Content-Type') || '').includes('text/html');
  if (!isHtml || res.status === 304) return page;

  const nonce = crypto.randomUUID().replaceAll('-', '');
  page.headers.set(CSP_HEADER, pagePolicy(nonce));
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
