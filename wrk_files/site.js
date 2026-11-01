// Shared site chrome: nav, login helpers and the network background.
// Profile pages load this with data-nav="mini" and only get the small home pill.

const SITE_API = 'https://api.wrk.money';
const siteMode = document.currentScript?.dataset.nav;

// A member's site settings live on their account. This copy applies them before the page paints.
function sitePrefs() {
    if (!localStorage.getItem('wrk_token')) return {};
    try { return JSON.parse(localStorage.getItem('wrk_prefs')) || {}; } catch { return {}; }
}

function applyPrefs(prefs) {
    const root = document.documentElement;
    root.dataset.theme = prefs.theme || 'wrk';
    root.dataset.motion = prefs.motion || 'full';

    const accent = /^#[0-9a-f]{6}$/i.test(prefs.accent) ? prefs.accent : null;
    const rgb = accent && [1, 3, 5].map(i => parseInt(accent.slice(i, i + 2), 16));
    const light = rgb && 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2] > 140;
    const values = { '--accent': accent, '--accent-rgb': rgb?.join(', '), '--on-accent': rgb && (light ? '#08090c' : '#ffffff'), '--gradient-end': accent };
    for (const [name, value] of Object.entries(values))
        value ? root.style.setProperty(name, value) : root.style.removeProperty(name);
}

function clearSession() {
    for (const key of ['wrk_token', 'wrk_slug', 'wrk_prefs']) localStorage.removeItem(key);
}

function logout() {
    clearSession();
    location.href = '/';
}

// Sends the visitor to log in, and back to this page afterwards.
function goLogin() {
    clearSession();
    location.replace(`/login?from=${encodeURIComponent(location.pathname)}`);
}

function renderNav() {
    const LINKS = [['/', 'home', '~'], ['/directory', 'directory', '@'], ['/tools', 'tools', '>_'], ['/startpage', 'startpage', '/']];
    const here = location.pathname.replace(/\/$/, '') || '/';
    const inSection = href => href === '/' ? here === '/' : here === href || here.startsWith(`${href}/`);
    const links = LINKS.map(([href, label, icon]) =>
        `<a class="nav-link${inSection(href) ? ' active' : ''}" href="${href}"${inSection(href) ? ' aria-current="page"' : ''}><span class="nav-link-icon" aria-hidden="true">${icon.replace('>', '&gt;')}</span>${label}</a>`).join('');

    const nav = document.createElement('nav');
    nav.className = 'site-nav';
    nav.setAttribute('aria-label', 'site');
    nav.innerHTML = `<a class="nav-logo" href="/"><img src="/wrk_files/999circle.png" alt=""><span>wrk<b>.</b>money</span></a><div class="nav-links">${links}</div>`;
    document.body.prepend(nav);

    const slug = localStorage.getItem('wrk_slug');
    if (!localStorage.getItem('wrk_token') || !slug) {
        const login = document.createElement('a');
        login.className = 'btn btn-primary nav-login';
        login.href = '/login';
        login.textContent = 'log in';
        nav.appendChild(login);
        return;
    }

    const user = document.createElement('div');
    user.className = 'nav-user';
    user.innerHTML = `
        <button class="nav-user-btn" type="button" aria-expanded="false" aria-haspopup="true">
            <img src="/wrk_files/999circle.png" alt=""><span class="nav-user-name"></span><span class="nav-caret" aria-hidden="true">▼</span>
        </button>
        <div class="nav-menu">
            <a class="nav-view">view my profile</a>
            <a href="/settings">edit profile</a>
            <a href="/site-settings">site settings</a>
            <button type="button">log out</button>
        </div>`;
    nav.appendChild(user);
    user.querySelector('.nav-view').href = `/${slug}`;
    user.querySelector('.nav-user-name').textContent = slug;

    const btn = user.querySelector('.nav-user-btn'), menu = user.querySelector('.nav-menu');
    const setOpen = open => { menu.classList.toggle('open', open); btn.setAttribute('aria-expanded', open); };
    btn.addEventListener('click', () => setOpen(!menu.classList.contains('open')));
    document.addEventListener('click', e => { if (!user.contains(e.target)) setOpen(false); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape') setOpen(false); });
    menu.querySelector('button').addEventListener('click', logout);

    siteUser().then(me => {
        if (!me) return;
        user.querySelector('.nav-user-name').textContent = me.profile?.displayName || slug;
        if (me.profile?.avatar) user.querySelector('img').src = me.profile.avatar;
    });
}

// The logged-in member, or null. Shared so the nav and the page make one request.
let siteUserRequest;
function siteUser() {
    const token = localStorage.getItem('wrk_token');
    if (!token) return Promise.resolve(null);
    return siteUserRequest ??= fetch(`${SITE_API}/auth/me`, { headers: { Authorization: `Bearer ${token}` } })
        .then(res => {
            if (res.status !== 401) return res.ok ? res.json() : null;
            // Expired session: reload as logged out, which also sends member pages to login.
            clearSession();
            location.reload();
            return null;
        })
        .then(me => {
            if (me?.token) localStorage.setItem('wrk_token', me.token);
            // Settings changed on another device: use them from here on.
            const saved = JSON.stringify(me?.prefs || {});
            if (me && saved !== localStorage.getItem('wrk_prefs')) {
                localStorage.setItem('wrk_prefs', saved);
                if (siteMode !== 'mini') applyPrefs(me.prefs || {});
            }
            return me;
        })
        .catch(() => null);
}

function timeGreeting() {
    const h = new Date().getHours();
    if (h >= 5 && h < 12) return 'good morning';
    if (h >= 12 && h < 17) return 'good afternoon';
    if (h >= 17 && h < 21) return 'good evening';
    return 'good night';
}

// Backgrounds shared by profiles and the site.
const PARTICLE_LOOKS = {
    winter: {
        fpsLimit: 120,
        particles: {
            number: { value: 150, density: { enable: true, area: 800 } },
            color: { value: "#ffffff" }, shape: { type: "circle" },
            opacity: { value: { min: 0.1, max: 0.8 }, animation: { enable: true, speed: 1, sync: false } },
            size: { value: { min: 0.5, max: 3 }, animation: { enable: true, speed: 5, sync: false, startValue: "min" } },
            move: { enable: true, speed: { min: 3, max: 10 }, direction: "top-left", outModes: { default: "out" }, attract: { enable: true, rotate: { x: 600, y: 1200 } } }
        },
        retina_detect: true
    },
    starfield: {
        fpsLimit: 60,
        particles: {
            number: { value: 200 },
            color: { value: "#ffffff" }, shape: { type: "circle" },
            opacity: { value: { min: 0.05, max: 0.7 }, animation: { enable: true, speed: 0.4, sync: false } },
            size: { value: { min: 0.5, max: 2.5 } },
            links: { enable: false },
            move: { enable: true, speed: 0.4, direction: "none", random: true, outModes: { default: "out" } }
        },
        interactivity: { events: {} },
        retina_detect: true
    },
};

function startRain(background, tint) {
    const canvas = document.createElement('canvas');
    canvas.id = 'matrix-bg';
    // Matrix draws far dimmer than code rain, so it needs less fading to show.
    if (background === 'matrix') canvas.style.opacity = 0.85;
    document.body.prepend(canvas);

    const run =() => (background === 'matrix' ? startMatrix : startVisualizer)(tint);
    if (window.startMatrix) return run();
    const script = document.createElement('script');
    script.src = '/wrk_files/code-rain.js?v=3';
    script.onload = run;
    document.head.appendChild(script);
}

function startNetwork() {
    const prefs = sitePrefs();
    if (prefs.background === 'off') return;

    const still = prefs.motion === 'reduced' || matchMedia('(prefers-reduced-motion: reduce)').matches;
    const theme = getComputedStyle(document.documentElement);
    const accent = theme.getPropertyValue('--accent').trim();

    if (prefs.background === 'matrix' || prefs.background === 'visualizer') {
        // Falling text can't be held still, so reduced animation leaves it out.
        if (!still) startRain(prefs.background, theme.getPropertyValue('--accent-rgb').split(',').map(Number));
        return;
    }

    const box = document.createElement('div');
    box.id = 'tsparticles';
    document.body.prepend(box);

    const calm = prefs.background === 'calm';
    const profileLook = PARTICLE_LOOKS[prefs.background];
    const load = () => tsParticles.load('tsparticles', profileLook ? {
        ...profileLook,
        fpsLimit: 60,
        particles: { ...profileLook.particles, color: { value: ['#ffffff', accent] } },
    } : {
        // Slow drift, so 30fps looks the same as 120 and costs a quarter of the work.
        fpsLimit: 30,
        particles: {
            number: { value: calm ? 24 : 55, density: { enable: true, area: 900 } },
            color: { value: [accent, theme.getPropertyValue('--accent-2').trim(), '#ffffff'] },
            shape: { type: 'circle' },
            opacity: { value: calm ? 0.3 : 0.45 },
            size: { value: { min: 1, max: 2.5 } },
            links: { enable: true, distance: 150, color: accent, opacity: calm ? 0.08 : 0.16, width: 1 },
            move: { enable: !still, speed: calm ? 0.25 : 0.6, outModes: { default: 'out' } },
        },
        // The canvas ignores the pointer so links stay clickable, so hover is read from the window.
        interactivity: {
            detectsOn: 'window',
            events: { onHover: { enable: !calm && !still, mode: 'grab' } },
            modes: { grab: { distance: 150, links: { opacity: 0.55 } } },
        },
    }).then(container => { if (still) setTimeout(() => container.pause(), 400); });

    if (window.tsParticles) return load();
    const script = document.createElement('script');
    script.src = 'https://cdnjs.cloudflare.com/ajax/libs/tsparticles/2.12.0/tsparticles.bundle.min.js';
    script.integrity = 'sha384-gZSNMuUgSbqcltOBBRNXCH+szg+2C69ISFyCk2w+xsZc0iFU+bIVPfYPmLwLtNzz';
    script.crossOrigin = 'anonymous';
    script.onload = load;
    document.head.appendChild(script);
}

// Redraws the background after a setting changes.
function restartNetwork() {
    window.tsParticles?.domItem(0)?.destroy();
    document.getElementById('tsparticles')?.remove();
    document.getElementById('matrix-bg')?.remove();
    startNetwork();
}

// A small way back to the site, plus an edit link when the owner is viewing their own page.
function renderMiniNav() {
    const pill = document.createElement('div');
    pill.className = 'mini-nav';
    pill.style.cssText = 'position:fixed;top:14px;left:14px;z-index:900;display:flex;gap:2px;padding:4px;background:rgba(6,7,11,.72);border:1px solid rgba(255,255,255,.14);border-radius:9px;backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);font:700 12px "JetBrains Mono",monospace';
    const add = (href, text) => {
        const a = pill.appendChild(document.createElement('a'));
        a.href = href;
        a.textContent = text;
        a.style.cssText = 'padding:5px 9px;color:#f3f5f9;text-decoration:none';
    };
    add('/', '← wrk.money');
    const slug = localStorage.getItem('wrk_slug');
    const viewing = decodeURIComponent(location.pathname).replace(/^\/|\/$/g, '');
    if (localStorage.getItem('wrk_token') && slug && slug.toLowerCase() === viewing.toLowerCase()) add('/settings', 'edit');
    document.body.appendChild(pill);
}

if (siteMode === 'mini') renderMiniNav();
else { applyPrefs(sitePrefs()); renderNav(); startNetwork(); }
