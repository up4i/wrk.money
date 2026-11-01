// A member's appearance options, shared by every profile page and the settings preview.
// Values are re-checked here because they end up inside CSS.

const PROFILE_FONTS = {
    sans: { family: "'Space Grotesk', sans-serif", css: 'Space+Grotesk:wght@400;500;700' },
    serif: { family: "'Playfair Display', serif", css: 'Playfair+Display:wght@400;600;800' },
    pixel: { family: "'Pixelify Sans', sans-serif", css: 'Pixelify+Sans:wght@400;500;700' },
};

const isProfileColor = value => /^#[0-9a-fA-F]{6}$/.test(value);

function formatAka(names) {
    const list = (names || []).filter(Boolean);
    if (list.length < 2) return list.length ? `aka ${list[0]}` : '';
    return `aka ${list.slice(0, -1).join(', ')}${list.length > 2 ? ',' : ''} & ${list.at(-1)}`;
}

function profileCss(p, root = ':root') {
    const css = [];
    const cards = 'header,.audio-box,.hub-btn';
    const noBlur = 'backdrop-filter:none;-webkit-backdrop-filter:none';

    const tint = isProfileColor(p.accentColor) ? p.accentColor : null;
    const accent = tint || (isProfileColor(p.nameColor) ? p.nameColor : '#ffffff');
    const [r, g, b] = [1, 3, 5].map(i => parseInt(accent.slice(i, i + 2), 16));
    css.push(`${root}{--profile-accent:${accent}${tint ? `;--glass:rgba(${r},${g},${b},0.08);--border:rgba(${r},${g},${b},0.3)` : ''}}`);

    const avatar = { square: '6px', rounded: '16px', circle: '50%' }[p.avatarShape];
    if (avatar) css.push(`.pfp,.enter-card img{border-radius:${avatar}}`);

    const corners = { sharp: '4px', soft: '14px', round: '26px' }[p.corners];
    if (corners) css.push(`${cards}{border-radius:${corners}}`);

    if (p.cardStyle === 'solid') css.push(`${cards}{background:rgba(10,12,16,0.92);${noBlur}}`);
    if (p.cardStyle === 'clear') css.push(`${cards}{background:transparent;box-shadow:none;${noBlur}}header,.audio-box{border-color:transparent}`);

    if (p.buttonStyle === 'outline') css.push(`.hub-btn{background:transparent;${noBlur}}`);
    if (p.buttonStyle === 'solid') {
        const light = 0.299 * r + 0.587 * g + 0.114 * b > 140;
        css.push(`.hub-btn{background:var(--profile-accent);border-color:transparent;color:${light ? '#08090c' : '#ffffff'};font-weight:700}.hub-btn:hover{background:var(--profile-accent);filter:brightness(1.12)}`);
    }

    if (isProfileColor(p.nameColor)) css.push(`.name-row h1{color:${p.nameColor}}`);
    if (p.nameEffect === 'glow') css.push(`.name-row h1{text-shadow:0 0 22px ${accent}}`);
    if (p.nameEffect === 'money') css.push('.name-row h1{background:linear-gradient(95deg,#ffffff 15%,#85bb65 85%);-webkit-background-clip:text;background-clip:text;color:transparent}');

    if (PROFILE_FONTS[p.font]) css.push(`*{font-family:${PROFILE_FONTS[p.font].family}}`);
    if (p.hideVisits) css.push('.visit-count{display:none}');
    if (p.hideUid) css.push('.uid-label{display:none}');
    if (Number.isFinite(p.bgOpacity)) css.push(`#bg-media{opacity:${Math.min(100, Math.max(0, p.bgOpacity)) / 100}}`);
    return css.join('');
}

function loadProfileFont(p) {
    const font = PROFILE_FONTS[p.font];
    if (!font || document.querySelector(`link[data-font="${p.font}"]`)) return;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.dataset.font = p.font;
    link.href = `https://fonts.googleapis.com/css2?family=${font.css}&display=swap`;
    document.head.appendChild(link);
}

function applyProfile(p) {
    loadProfileFont(p);
    const style = document.createElement('style');
    style.textContent = profileCss(p);
    document.head.appendChild(style);

    // Added in reverse so the akas end up directly under the name, above the status.
    const addUnderName = (className, text) => {
        if (!text) return;
        const line = document.createElement('div');
        line.className = className;
        line.textContent = text;
        document.querySelector('.name-row').after(line);
    };
    addUnderName('profile-status', p.status);
    addUnderName('profile-aka', formatAka(p.aka));

    const prompt = document.querySelector('.enter-text');
    if (prompt) {
        if (p.enterText) prompt.textContent = p.enterText;
        const card = document.createElement('div');
        card.className = 'enter-card';
        const avatar = card.appendChild(new Image());
        avatar.alt = '';
        avatar.src = p.avatar || document.querySelector('.pfp').src;
        card.appendChild(document.createElement('span')).textContent = document.querySelector('.name-row h1').textContent;
        prompt.before(card);
    }

    const audio = document.getElementById('p-audio') || document.getElementById('audio');
    if (audio && Number.isFinite(p.musicVolume)) {
        audio.volume = Math.min(100, Math.max(0, p.musicVolume)) / 100;
        const slider = document.getElementById('p-volume') || document.getElementById('volumeSlider');
        if (slider) slider.value = audio.volume;
    }
}
