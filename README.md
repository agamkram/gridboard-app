# GridBoard

Read-only paper grid ops for Mark Maga’s Kraken paper books.

**Live:** [gridboard.markmaga.com](https://gridboard.markmaga.com)

75 USD pairs × Neutral + Long = 150 paper books. Each book is $10,000, fee 0.80% per side, geometric spacing r = 1.05 (5%). Neutral is ~50% seed with 3 buys / 3 sells. Long is ~50% seed with 4 buys / 2 sells.

This site does not place orders, does not hold secrets, and does not call the Kraken API. The browser only reads `/status.json`.

## What the page shows

Header, then three sections:

- **Hot watch** — tokens whose watch window is still open. Entries whose `until` has already passed are dropped, so a stale snapshot cannot show an expired name as live.
- **Totals** — one card each for Neutral, Long, and Buy & hold. Each card reads At work, Cash, Now, with a chip comparing Now to $10,000 × 75.
- **Tokens** — one row per symbol with Neutral, Long, Held, and a buy·sell count, plus a sort menu. There is no filter and no footer.

A banner appears above the sections only when `paper_only` is false, or when the snapshot is more than 45 minutes old.

## Local preview

From the repo root:

```bash
python3 serve-https.py
```

or:

```bash
npm run serve
```

The process listens on all interfaces, HTTPS, port **8912**, and prints:

`https://127.0.0.1:8912/`

In normal use launchd owns that server (`com.markmaga.preview.gridboard-app`), so it survives closing the editor. Mark’s `~/bin/preview-ctl.py` and `~/Local previews/GridBoard.webloc` point at that URL. This repo does not edit `preview-ctl`. That script lives on his Mac, outside the repo.

The first run writes a self-signed `.local-cert.pem` / `.local-key.pem` (gitignored). The browser will ask you to proceed once.

The page loads `status.json` with `cache: "no-cache"`. The Vercel Analytics script requests `/_vercel/insights/script.js`, which 404s locally. That is expected. The board still renders. The service worker does not register on localhost or a LAN address, and unregisters itself if it finds one there.

How the books work is on [about.html](about.html), linked from the header.

## Asset versions

`app.js` and `styles.css` are requested with a `?v=` query from `index.html`, `about.html`, and the `sw.js` precache list. The service worker caches by full URL, query included, so a page asking for `app.js?v=6` while the worker precached `app.js?v=1` never matches. Do not hand-edit those three files:

```bash
python3 scripts/bump-version.py --check   # exit 1 if they disagree
python3 scripts/bump-version.py js        # bump app.js
python3 scripts/bump-version.py css       # bump styles.css
python3 scripts/bump-version.py both
```

JS and CSS carry separate numbers because they go stale independently. Run `--check` before handing over a URL.

## Vercel

Import this repo as a static project. `vercel.json` sets `framework` to null, so Vercel serves the files at the repo root. No install step and no build step. It also sets a CSP, `nosniff`, `X-Frame-Options`, a referrer policy, and the manifest content type.

`index.html` already includes the official HTML snippet for Vercel Web Analytics (`window.va` queue plus `/_vercel/insights/script.js`). **Pageviews only start once Analytics is switched on in the Vercel project** — open the project → Analytics → Enable. Until then that script 404s in production and nothing is recorded. No environment variables and no `@vercel/analytics` package.

## DNS

1. In the Vercel project, add the domain `gridboard.markmaga.com`.
2. At Namecheap, on `markmaga.com`, add a CNAME:
   - Host: `gridboard`
   - Value: `cname.vercel-dns.com`
3. Wait until Vercel shows the certificate as ready.

If Vercel’s domain panel prints a different target, use that record.

## Publishing

Grok’s maintain job overwrites `status.json` roughly every 15 minutes. The launchd agent `com.markmaga.gridboard-publish` watches that file and runs `scripts/publish-live.py`, which deploys the folder with the Vercel CLI and logs to `~/Library/Logs/markmaga-preview/gridboard-publish.log`.

Deploys are capped at one every 30 minutes (`MIN_INTERVAL`). Vercel’s free plan allows 100 production deploys a day **across every project on the account**, so publishing every status write exhausts it before noon and then deploys start failing for the other apps too. Thirty minutes is 48 a day and still lands inside the 45 minutes after which the board marks itself stale. `StartInterval` in the plist re-runs the script every 10 minutes so a throttled snapshot still publishes once the floor has passed.

The Vercel CLI sometimes exits non-zero *after* the deployment has gone live, so the script confirms against the live site instead of trusting the exit code, and records progress in `gridboard-publish.state.json`. On the quota error it holds for an hour rather than retrying. Successful publishes log `live`, skipped ones log `unchanged`, `throttled`, or `quota backoff`.

That watcher deploys whatever is on disk. **Pause it before a multi-file edit** so a half-finished change cannot go live, and reload it when the change is verified:

```bash
launchctl unload ~/Library/LaunchAgents/com.markmaga.gridboard-publish.plist
launchctl load   ~/Library/LaunchAgents/com.markmaga.gridboard-publish.plist
```

## status.json

There is no backend in this repo. The page fetches `/status.json` and that is the whole data path. `vercel.json` sends `Cache-Control: public, max-age=0, must-revalidate` for it, and the page asks the browser to revalidate.

Fields the board actually reads:

| Field | Use |
| --- | --- |
| `paper_only` | Banner when false. The page still cannot trade either way. |
| `updated_et` | Time half of the header stamp; the date comes from the `Last-Modified` header |
| `fee_label` | Fee rate for the Buy & hold column |
| `capital_per_book` | Seed per book and the $10k × pair-count baseline |
| `rollup.hot` | Hot watch, filtered by each entry’s `until` |
| `fills[]` | Fallback source for the buy·sell counts, and the trades note |
| `pairs[]` | One row per symbol: `symbol`, `spot`, `neutral_seed`, and `coin_usd` / `cash_usd` / `equity` per side |

Everything else in the file — `headline`, `scanned`, `spacing`, `neutral_spec`, `long_spec`, `core_symbols`, `threats[]`, the quiet counts, and the per-pair `pair`, `*_ws`, `*_orders`, `long_seed`, `pct_vs_seed`, `threat` — is shipped and ignored. Dropping it would cut the payload roughly in half.

### Two known feed problems

Both come from the maintain job, not from this repo:

1. **`equity` disagrees with `coin_usd + cash_usd`** in most books, by up to about $33. For 74 of 75 tokens the Neutral and Long books imply the same price ratio, so the two figures are valued from price reads a moment apart. The page shows At work, Cash, and Now on one card, so it builds Now from the two rounded numbers above it rather than printing an `equity` that would not add up. Fix it upstream by valuing both from one read.
2. **No per-book trade counts.** `pairs[]` carries no `buys` / `sells`, so `tradeCounts()` falls back to counting `fills[]` — a rolling window, currently a few hours. Most tokens therefore read `0 · 0`. The Tokens section prints a note saying so whenever the fallback is in use; the note disappears on its own once the feed supplies real totals.

## Verify

- The only `h1` is `GridBoard`, centered, in Michroma.
- Document title, `apple-mobile-web-app-title`, and `og:title` are `GridBoard`.
- There is no order button.
- On each Totals card, At work + Cash equals Now exactly.
- The Neutral column of the token table sums to the Neutral card’s Now.
- The token table lists all 75 symbols and sorts by every option in the menu.
- At 390px wide, the `HELD` header is fully readable and not overlapped by `BUY/SELL`.
- `python3 scripts/bump-version.py --check` exits 0.
- `python3 serve-https.py` prints `https://127.0.0.1:8912/`.
