// Telegram gift helpers shared by the profile pages, settings and directory.

function parseGift(url) {
    const m = String(url || '').match(/^(?:https?:\/\/)?t\.me\/nft\/([a-zA-Z0-9]+)-(\d+)(?:[/?#]|$)/i);
    if (!m) return null;
    const base = `https://nft.fragment.com/gift/${m[1].toLowerCase()}-${m[2]}`;
    return {
        url: `https://t.me/nft/${m[1]}-${m[2]}`,
        label: m[1].replace(/([a-z])([A-Z])/g, '$1 $2') + ' #' + m[2],
        image: `${base}.webp`,
        lottie: `${base}.lottie.json`,
    };
}

// Places the animated badge with insert(el), replacing any hardcoded [data-gift] fallback.
function addGiftBadge(url, insert) {
    const gift = parseGift(url);
    if (!gift) return;

    const div = document.createElement('div');
    div.className = 'badge-container'; div.dataset.gift = '1';
    const a = document.createElement('a');
    a.href = gift.url; a.target = '_blank'; a.rel = 'noopener';
    a.style.cssText = 'display:inline-block;width:24px;height:24px';
    div.appendChild(a);
    const tooltip = document.createElement('span');
    tooltip.className = 'tooltip'; tooltip.textContent = gift.label;
    div.appendChild(tooltip);

    function showImage() {
        a.innerHTML = '';
        const img = document.createElement('img');
        img.src = gift.image; img.alt = gift.label; img.className = 'badge-img';
        img.onerror = () => { div.style.display = 'none'; };
        a.appendChild(img);
    }

    function show() {
        document.querySelectorAll('[data-gift]').forEach(b => b.remove());
        insert(div);
        if (!window.lottie) return showImage();
        lottie.loadAnimation({ container: a, renderer: 'svg', loop: true, autoplay: true, path: gift.lottie })
            .addEventListener('data_failed', showImage);
    }

    if (window.lottie) return show();
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/lottie-web/5.12.2/lottie.min.js';
    s.onload = s.onerror = show;
    document.head.appendChild(s);
}
