// Shared site chrome: nav, login helpers and the network background.
// Profile pages load this with data-nav="mini" and only get the small home pill.

const SITE_API = 'https://api.wrk.money';
const siteMode = document.currentScript?.dataset.nav;

function logout() {
    localStorage.removeItem('wrk_token');
    localStorage.removeItem('wrk_slug');
    location.href = '/';
}

// Sends the visitor to log in, and back to this page afterwards.
function goLogin() {
    localStorage.removeItem('wrk_token');
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
            localStorage.removeItem('wrk_token');
            localStorage.removeItem('wrk_slug');
            location.reload();
            return null;
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

function startNetwork() {
    const box = document.createElement('div');
    box.id = 'tsparticles';
    document.body.prepend(box);
    const script = document.createElement('script');
    script.src = 'https://cdnjs.cloudflare.com/ajax/libs/tsparticles/2.12.0/tsparticles.bundle.min.js';
    script.onload = () => tsParticles.load('tsparticles', {
        // Slow drift, so 30fps looks the same as 120 and costs a quarter of the work.
        fpsLimit: 30,
        particles: {
            number: { value: 55, density: { enable: true, area: 900 } },
            color: { value: ['#00ff88', '#8b5cff', '#ffffff'] },
            shape: { type: 'circle' },
            opacity: { value: 0.45 },
            size: { value: { min: 1, max: 2.5 } },
            links: { enable: true, distance: 150, color: '#7dfcc6', opacity: 0.16, width: 1 },
            move: { enable: true, speed: 0.6, outModes: { default: 'out' } },
        },
        // The canvas ignores the pointer so links stay clickable, so hover is read from the window.
        interactivity: {
            detectsOn: 'window',
            events: { onHover: { enable: true, mode: 'grab' } },
            modes: { grab: { distance: 150, links: { opacity: 0.55 } } },
        },
    });
    document.head.appendChild(script);
}

// A small way back to the site, plus an edit link when the owner is viewing their own page.
function renderMiniNav() {
    const pill = document.createElement('div');
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
else { renderNav(); startNetwork(); }
