# GridBoard

Read-only **Paper Grid Ops** board for Mark Maga’s Kraken paper books.

**Live target:** [gridboard.markmaga.com](https://gridboard.markmaga.com)

75 Kraken USD pairs, each with a Neutral book and a Long book (150 books). Capital is $10,000 a book. Fee is 0.80% a side. Spacing is geometric, r = 1.05 (5%). Neutral is about a 50% seed with 3 buys and 3 sells. Long is about a 50% seed with 4 buys and 2 sells.

This site does not trade. There is no order button, no Kraken API call from the browser, and no secret in the repo. The page only fetches `/status.json`.

## Local

From the repo root:

```bash
python3 -m http.server 4173
```

Open http://127.0.0.1:4173 . Opening `index.html` as a file will not load the feed.

## Deploy on Vercel

Import [agamkram/gridboard-app](https://github.com/agamkram/gridboard-app). Same path as the other markmaga.com apps: GitHub → Vercel → Namecheap.

- Framework preset: **Other**
- Build command: empty
- Output directory: empty (the repo root is the site)
- Install command: empty

`vercel.json` sets `framework` to null and sends `Cache-Control: public, max-age=0, must-revalidate` on HTML, CSS, JS, and JSON. The page fetches `/status.json` with `cache: "no-cache"`, so a reload revalidates instead of sitting on a stale board. There is no service worker.

## DNS

Add `gridboard.markmaga.com` on the Vercel project, then point Namecheap at Vercel.

In Namecheap → Domain List → markmaga.com → Advanced DNS:

| Type | Host | Value |
|------|------|--------|
| CNAME | `gridboard` | `cname.vercel-dns.com` |

Remove any parked A record or URL redirect on the host `gridboard`. If Vercel’s domain screen shows a different CNAME target, use that value. TTL can stay automatic.

## How `status.json` is updated

There is no backend in this pull request. Mark’s maintain job overwrites `status.json` at the repo root on publish and pushes `main`. Vercel deploys that file to `/status.json`. Until the first job run, the committed snapshot is what the homepage renders.

Unread equity is the em dash `—`. A missing seed is `ERR`. The board leaves those out of sums. It does not treat them as zero.

### Feed fields

Top level: `schema_version`, `paper_only`, `updated_et`, `headline`, `fee_label`, `capital_per_book`, `spacing`, `neutral_spec`, `long_spec`, `scanned`, `core_symbols`, `threats[]`, `rollup`, `fills[]`, `pairs[]`.

Each pair: `symbol`, `pair`, `neutral_equity`, `long_equity`, `neutral_seed`, `long_seed`, `neutral_orders`, `long_orders`, `neutral_ws`, `long_ws`. Optional: `spot`, `pct_vs_seed` (percent points, so `-0.87` means −0.87%), `threat`, and the nested shapes `seeds.neutral` / `seeds.long` and `orders.neutral` / `orders.long` if a later job writes those instead of the flat fields.

`rollup.hot` is keyed by symbol (`until`, `last_fill`, `fills`, `remaining_s`, `quiet_s`). `threats` may be empty. Fills carry `ts`, `symbol`, `style`, `side`, `price`, `volume`, `reladder_side`, `reladder_price`, `placed`, `workspace`, `cycle`, `mode`, `note`.

`paper_only` must stay `true`. If a future file omits it, the stamp switches to a warning. The page still has no trade controls.

## Verify

1. Homepage shows **PAPER ONLY**, fee 0.80%, geometric 5%, the update time, and the headline.
2. Core strip is ADA, ETH, BTC, ZEC with spot, % vs seed, Neutral equity, and Long equity.
3. Threats is an empty near-band state on the snapshot. Rollup shows quiet counts and the LIGHTER hot window.
4. The pair table lists all 75 symbols. Column headers sort. Chips filter Core, Hot, Threats, and Gaps. The search box matches symbol, pair, and workspace.
5. Totals show the Neutral sum and the Long sum against the $10,000 × 75 baseline, plus how many books actually reported, and the scanned count (150).
6. Fills lists the LIGHTER Neutral buy. An empty `fills` array shows the empty state.
7. Footer reads: Neutral 3+3 · Long 4+2 · paper simulator · not financial advice.
