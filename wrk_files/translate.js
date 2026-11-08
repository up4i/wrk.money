// Puts the visitor's language in place of the site's English: the markup, and any text scripts add later.
// Each file in lang/ calls siteTranslate with its words. A {} in a key matches any text, passed on in order.
// Members' own words sit inside translate="no" and stay as written.

const TRANSLATED_ATTRS = ['placeholder', 'title', 'aria-label'];

function makeTranslator(words) {
    const exact = new Map(Object.entries(words));
    const patterns = [...exact].filter(([key]) => key.includes('{}')).map(([key, to]) => [
        new RegExp(`^${key.split('{}').map(part => part.replace(/[.*+?^$()|[\]\\{}]/g, '\\$&')).join('(.+?)')}$`),
        to,
    ]);
    return (text, key) => {
        const core = text.replace(/\s+/g, ' ').trim();
        if (!core) return text;
        let out = exact.get(key ?? core);
        for (const [pattern, to] of out === undefined ? patterns : []) {
            const found = core.match(pattern);
            if (!found) continue;
            let i = 1;
            out = to.replace(/\{\}/g, () => found[i++]);
            break;
        }
        // The spaces around it are kept, since they sit between this text and a link or tag beside it.
        return out === undefined ? text : text.match(/^\s*/)[0] + out + text.match(/\s*$/)[0];
    };
}

function siteTranslate(words) {
    const translate = siteText = makeTranslator(words);
    const skipped = el => !el || el.closest('[translate="no"]');

    const fixText = node => {
        const el = node.parentElement;
        // A textarea's text is what the visitor typed into it.
        if (skipped(el) || el.closest('script, style, textarea')) return;
        // data-key picks the meaning where one English word means two things.
        const to = translate(node.data, el.dataset.key);
        if (to !== node.data) node.data = to;
    };
    const fixAttrs = el => {
        if (skipped(el)) return;
        for (const name of TRANSLATED_ATTRS) {
            const value = el.getAttribute(name);
            const to = value && translate(value);
            if (to !== value) el.setAttribute(name, to);
        }
    };
    const fixTree = root => {
        if (root.nodeType === Node.TEXT_NODE) return fixText(root);
        if (root.nodeType !== Node.ELEMENT_NODE) return;
        fixAttrs(root);
        root.querySelectorAll('[placeholder], [title], [aria-label]').forEach(fixAttrs);
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) fixText(walker.currentNode);
    };

    fixTree(document.documentElement);
    new MutationObserver(changes => {
        for (const change of changes) {
            if (change.type === 'childList') change.addedNodes.forEach(fixTree);
            else if (change.type === 'characterData') fixText(change.target);
            else fixAttrs(change.target);
        }
    }).observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributeFilter: TRANSLATED_ATTRS });
}
