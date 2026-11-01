# wrk.money

Personal domain and web platform by **wrk** (ogkush). Hosts profile cards, tools, and a user profile network — all pure HTML/CSS/JS on GitHub Pages with a Cloudflare Worker backend.

---

## Pages

| Route | Description |
|---|---|
| [wrk.money](https://wrk.money) | Main hub |
| [wrk.money/$](https://wrk.money/$) | ogkush — wrk's profile |
| [wrk.money/$$$](https://wrk.money/$$$) | pulse's profile |
| [wrk.money/insanity](https://wrk.money/insanity) | jerry's profile |
| [wrk.money/tools](https://wrk.money/tools) | Tools hub |
| [wrk.money/startpage](https://wrk.money/startpage) | Ad-free search |

## Tools

| Tool | Description |
|---|---|
| [/tools/ip-checker](https://wrk.money/tools/ip-checker) | IP & URL geolocation, DNS, reputation |
| [/tools/pastebin](https://wrk.money/tools/pastebin) | Syntax-highlighted pastes with expiry |
| [/tools/fileshare](https://wrk.money/tools/fileshare) | File upload with optional expiry |
| [/tools/shortener](https://wrk.money/tools/shortener) | URL shortener — `wrk.money/s/...` |

## Profiles

Anyone with an account gets a profile at `wrk.money/their-slug`. Profiles support a profile picture, cycling bio statements, tab groups with link/copy buttons, optional music player, and two background styles.

- **Login:** [wrk.money/login](https://wrk.money/login)
- **Register:** contact wrk at [wrk.money/$](https://wrk.money/$)

---

## Theme and navigation

Every page except the profiles shares `wrk_files/site.css` (colors are the variables at the top, so `--accent` recolors the site) and `wrk_files/site.js` (the nav, login helpers and background). Profiles keep their own look and load `site.js` with `data-nav="mini"` for a small link home.

Cloudflare keeps these files for 4 hours, so bump the `?v=` on their tags in each page whenever they change.

---

## Stack

- **Frontend:** Pure HTML/CSS/JS — no framework, no build step
- **Hosting:** GitHub Pages
- **DNS/Proxy:** Cloudflare
- **Backend:** Cloudflare Worker at `api.wrk.money`
- **Storage:** Cloudflare KV (metadata, accounts) + R2 (files)
- **Font:** JetBrains Mono
