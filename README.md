# GridBoard

Read-only paper grid ops for Mark Maga’s Kraken paper books.

**Live:** [gridboard.markmaga.com](https://gridboard.markmaga.com)

75 USD pairs × Neutral + Long = 150 paper books. Each book is $10,000, fee 0.80% per side, geometric spacing r = 1.05 (5%). Neutral is ~50% seed with 3 buys / 3 sells. Long is ~50% seed with 4 buys / 2 sells.

This site does not place orders, does not hold secrets, and does not call the Kraken API. The browser only reads `/status.json`.

## What the page shows

Header, then three sections:

- **Hot watch** — tokens whose watch window is still open. Entries whose `until` has already passed are dropped, so a stale snapshot cannot show an expired name as live.
- **Totals** — one card each for Neutral, Long, and Buy & hold. Neutral and Long read At work, Cash, Now, with a chip comparing Now to $10,000 × 75. Buy & hold is that stake bought once at the book’s own start price. When the two opens differ, the card lists a Neutral hold and a Long hold.
- **Tokens** — one row per symbol with Neutral, Long, Held, and a buy·sell count, plus a sort menu. When the two opens differ, Held shows both. There is no filter and no footer.

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

**Pushing to `main` is the only way the site deploys.** Vercel builds this repo on push, so anything committed but unpushed is a pending rollback: the next build publishes what GitHub has, not what is on your disk.

Grok Bot pushes a new `status.json` to `main` every 5 to 15 minutes. Those must not each trigger a build — Vercel’s free plan allows 100 production deploys a day across every project on the account, and status writes alone are about 100. The `ignoreCommand` in `vercel.json` skips the build when `status.json` is the only changed file:

```
[ $(git rev-list --parents -n 1 HEAD | wc -w) -eq 2 ] && git diff --quiet HEAD^ HEAD -- . ':!status.json'
```

Exit 0 skips, exit 1 builds, so only a plain commit touching nothing but `status.json` is skipped. A merge always builds. That costs a deploy on a merge that carried no code, but the rule used to compare a merge against its first parent, and when that parent was the code commit being shipped the diff came back empty and the deploy was silently skipped. Erring toward one wasted build is much cheaper than serving yesterday's code and not knowing it.

There is no local publisher. A launchd agent used to deploy the folder with the Vercel CLI on every status write, which is what exhausted the quota; it was retired once the board started reading its data from GitHub instead, and the Mac stopped being sent a copy of `status.json` at all. Deploying from two places also meant a stale checkout could overwrite current code, which happened. Do not add a second deploy path.

## status.json

There is no backend in this repo. The page reads one file, and that is the whole data path.

It reads it from GitHub, not from this site:

```
https://raw.githubusercontent.com/agamkram/gridboard-app/main/status.json
```

Grok Bot pushes there every 5 to 15 minutes, so the board sees new numbers without anything being deployed. GitHub caches for 5 minutes, which is why the board can be a few minutes behind the latest push. The copy deployed next to `index.html` is only the fallback for when GitHub cannot be reached, and it is as old as the last build — the staleness notice will say so. `connect-src` in `vercel.json` has to list `raw.githubusercontent.com` or the browser blocks the fetch.

The board fetches once on load and once per Reload. It does not poll.

Fields the board actually reads:

| Field | Use |
| --- | --- |
| `paper_only` | Banner when false. The page still cannot trade either way. |
| `updated_et` | Time half of the header stamp; the date comes from the `Last-Modified` header |
| `fee_label` | Fee rate for the Buy & hold column |
| `capital_per_book` | Seed per book and the $10k × pair-count baseline |
| `rollup.hot` | Hot watch, filtered by each entry’s `until` |
| `fills[]` | Fallback source for the buy·sell counts, and the trades note |
| `pairs[]` | One row per symbol: `symbol`, `spot`, `neutral_seed`, `long_seed`, and `coin_usd` / `cash_usd` / `equity` per side. Each hold uses that book’s seed. One figure means the seeds match. |

Everything else in the file — `headline`, `scanned`, `spacing`, `neutral_spec`, `long_spec`, `core_symbols`, `threats[]`, the quiet counts, and the per-pair `pair`, `*_ws`, `*_orders`, `pct_vs_seed`, `threat` — is shipped and ignored. Dropping it would cut the payload roughly in half.

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
- At 390px wide, the `HELD` header is fully readable and not overlapped by `BUY/SELL`. When a token’s seeds differ, the cell shows an N figure and an L figure.
- The N figures in Held sum to the Buy & hold card’s Neutral line, and the L figures sum to its Long line.
- `python3 scripts/bump-version.py --check` exits 0.
- `python3 serve-https.py` prints `https://127.0.0.1:8912/`.
