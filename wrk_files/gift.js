// Telegram gift helpers shared by the profile pages, settings and directory.

function parseGift(url) {
    const m = String(url || '').match(/^(?:https?:\/\/)?t\.me\/nft\/([a-zA-Z0-9]+)-(\d+)(?:[/?#]|$)/i);
    if (!m) return null;
    const base = `https://nft.fragment.com/gift/${m[1].toLowerCase()}-${m[2]}`;
    return {
        url: `https://t.me/nft/${m[1]}-${m[2]}`,
        label: m[1].replace(/([a-z])([A-Z])/g, '$1 $2') + ' #' + m[2],
        number: `#${Number(m[2]).toLocaleString('en-US')}`,
        image: `${base}.webp`,
        lottie: `${base}.lottie.json`,
    };
}

// Fragment's animation is a full card: the model shrunk to 63% over a pattern and backdrop.
// Keeping only that layer at full size leaves the model on a transparent background.
function giftModelOnly(animation) {
    const model = animation.layers.find(l => l.nm === 'Gift');
    model.ks.s.k = [100, 100, 100];
    return { ...animation, layers: [model] };
}

let lottieScript;
function loadLottie() {
    return lottieScript ??= new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = 'https://cdnjs.cloudflare.com/ajax/libs/lottie-web/5.12.2/lottie.min.js';
        s.integrity = 'sha384-J8C0MvgX4WP58J4N2W99vCKd2J6z99ynOJ5bEfE6jeP7kVTW1drYtv/jzrxM5jbm';
        s.crossOrigin = 'anonymous';
        s.onload = resolve;
        s.onerror = reject;
        document.head.appendChild(s);
    });
}

async function drawGiftModel(container, gift, autoplay = true) {
    const [res] = await Promise.all([fetch(gift.lottie), loadLottie()]);
    if (!res.ok) throw new Error(`gift animation: ${res.status}`);
    const animationData = giftModelOnly(await res.json());
    if (!container.isConnected) return;
    const anim = lottie.loadAnimation({ container, renderer: 'svg', autoplay: false, animationData });
    if (!autoplay) return;
    // Every second frame at 30fps: same speed and smooth at badge size, for half of lottie's own 60fps work.
    const timer = setInterval(() => {
        if (!container.isConnected) return clearInterval(timer);
        anim.goToAndStop((anim.currentFrame + 2) % anim.totalFrames, true);
    }, 1000 / 30);
}

// Places the animated badge with insert(el), falling back to Fragment's still card image.
function addGiftBadge(url, insert) {
    const gift = parseGift(url);
    if (!gift) return;

    const div = document.createElement('div');
    div.className = 'badge-container';
    const a = document.createElement('a');
    a.href = gift.url; a.target = '_blank'; a.rel = 'noopener';
    a.className = 'badge-img';
    a.setAttribute('aria-label', gift.label);
    a.style.cssText = 'display:inline-block;cursor:pointer';
    div.appendChild(a);
    const tooltip = document.createElement('span');
    tooltip.className = 'tooltip'; tooltip.textContent = gift.label;
    div.appendChild(tooltip);
    insert(div);

    drawGiftModel(a, gift).catch(() => {
        const img = document.createElement('img');
        img.src = gift.image; img.alt = gift.label; img.style.cssText = 'width:100%;height:100%';
        img.onerror = () => div.remove();
        a.replaceChildren(img);
    });
}
