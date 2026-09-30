# GridBoard

Read-only paper grid ops for Mark Maga’s Kraken paper books.

**Live target:** [gridboard.markmaga.com](https://gridboard.markmaga.com)

75 USD pairs × Neutral + Long = 150 paper books. Each book is $10,000, fee 0.80% per side, geometric spacing r = 1.05 (5%). Neutral is ~50% seed with 3 buys / 3 sells. Long is ~50% seed with 4 buys / 2 sells.

This site does not place orders, does not hold secrets, and does not call the Kraken API. The browser only reads `/status.json`.

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

Mark’s `~/bin/preview-ctl.py` and `~/Local previews/GridBoard.webloc` point at that URL after he installs the preview on his Mac. This repo does not edit `preview-ctl`. That script lives on his Mac, outside the repo.

The first run writes a self-signed `.local-cert.pem` / `.local-key.pem` (gitignored). The browser will ask you to proceed once. A plain `python3 -m http.server` also serves the files, but the preview Mark uses is the HTTPS server above.

The page loads `status.json` with `cache: "no-cache"`. The Vercel Analytics script requests `/_vercel/insights/script.js`, which 404s locally. That is expected. The board still renders.

How the books work is on [about.html](about.html), linked from the header.

## Vercel

Import this repo as a static project. `vercel.json` sets `framework` to null, so Vercel serves the files at the repo root (`index.html`, `styles.css`, `app.js`, `status.json`). No install step and no build step.

After the first deploy, open the project → **Analytics** → **Enable**. `index.html` already includes the official HTML snippet for Vercel Web Analytics (`window.va` queue plus `/_vercel/insights/script.js`). Pageviews start once that switch is on. No environment variables and no `@vercel/analytics` package — plain HTML does not need one.

## DNS

1. In the Vercel project, add the domain `gridboard.markmaga.com`.
2. At Namecheap, on `markmaga.com`, add a CNAME:
   - Host: `gridboard`
   - Value: `cname.vercel-dns.com`
3. Wait until Vercel shows the certificate as ready.

If Vercel’s domain panel prints a different target, use that record.

## status.json

There is no backend in this repo. The page fetches `/status.json` and that is the whole data path.

Mark’s maintain job overwrites `status.json` on publish. Commit the new file (or let that job push it) and Vercel redeploys the static site. `vercel.json` sends `Cache-Control: public, max-age=0, must-revalidate` for `/status.json`, and the page asks the browser to revalidate.

Fields the board reads:

| Field | Use |
| --- | --- |
| `paper_only` | Keeps the paper banner honest. The page still cannot trade if this is false. |
| `updated_et`, `headline` | Header line |
| `fee_label`, `spacing`, `neutral_spec`, `long_spec` | Fee pill and book specs |
| `capital_per_book` | Seed for START and the $10k × pair-count baseline |
| `scanned` | Books scanned |
| `core_symbols` | ADA / ETH / BTC / ZEC strip, in feed order |
| `threats[]` | Threat band. Strings or objects. Empty is a calm empty state. |
| `rollup` | Quiet counts, fill counts, and `hot` names |
| `fills[]` | Recent paper fills. Empty is fine. |
| `pairs[]` | One row per symbol: `pair`, `spot`, `pct_vs_seed`, equities, seeds, orders, optional `threat` |

`spot`, `pct_vs_seed`, and `threat` may be null. Equity or seed may be a number or an unseeded mark (`—`, `ERR`). Unseeded books stay out of the NOW sum.

## Verify

- The only `h1` is `GridBoard`, centered, in Michroma.
- Document title, `apple-mobile-web-app-title`, and `og:title` are `GridBoard`.
- The paper pill is visible. There is no order button.
- Core cards show START $10,000 and NOW equity for Neutral and Long, including a missing mark (ZEC Neutral is unseeded in the shipped snapshot).
- Totals show summed Neutral equity and summed Long equity against $10,000 × 75.
- The pair table lists all 75 symbols, sorts, and filters.
- Fills shows the LIGHTER Neutral buy. Threats can be empty.
- Footer reads: Neutral 3+3 · Long 4+2 · paper simulator · not financial advice.
- About (`about.html`) explains paper-only books, Neutral vs Long, re-ladder, hot watch, and that wider spacing in wild volatility is a design direction, not something the feed claims yet.
- `python3 serve-https.py` prints `https://127.0.0.1:8912/`.
