/* GridBoard — read-only. The only request is status.json. No orders, no Kraken API.
   The 5% books are the snapshot itself. The 25% books are sets["25"], with the
   same pairs, fills, and rollup. History points for that set use n25, l25, h25. */
(function () {
  var GAP_KEY = "gridboard-gap";

  function storedGap() {
    try {
      return localStorage.getItem(GAP_KEY) === "25" ? "25" : "5";
    } catch (e) {
      return "5";
    }
  }

  var state = {
    data: null,
    view: null,
    gap: storedGap(),
    sortKey: "symbol",
    sortDir: "asc",
    trend: [],
    trendAt: null,
  };

  /* The publisher writes a snapshot about every 15 minutes. */
  var STALE_MS = 45 * 60 * 1000;

  function num(v) {
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
    return null;
  }

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    var a = attrs || {};
    Object.keys(a).forEach(function (key) {
      var value = a[key];
      if (value == null || value === false) return;
      if (key === "class") node.className = value;
      else if (key === "text") node.textContent = String(value);
      else node.setAttribute(key, String(value));
    });
    (children || []).forEach(function (child) {
      if (child == null || child === false) return;
      node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    });
    return node;
  }

  function usd(n, digits) {
    return Math.abs(n).toLocaleString("en-US", {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    });
  }

  function signedUsd(n, digits) {
    var body = usd(n, digits);
    if (n < -0.0000001) return "−" + body;
    if (n > 0.0000001) return "+" + body;
    return body;
  }

  function signedPct(n) {
    var body = Math.abs(n).toFixed(2) + "%";
    if (n < 0) return "−" + body;
    if (n > 0) return "+" + body;
    return body;
  }

  function moneyDigits(n) {
    return Math.abs(n) >= 100 ? 0 : 2;
  }

  function tone(delta) {
    if (delta == null || Math.abs(delta) < 0.005) return "flat";
    return delta < 0 ? "down" : "up";
  }

  function formatEt(iso) {
    var d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso ? String(iso) : "—";
    return d.toLocaleString("en-US", {
      timeZone: "America/New_York",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
    });
  }

  /* fee_rate is the number the simulator charges. fee_label is only how it is
     written on screen, so it is the fallback for snapshots older than the field. */
  function feeRate(data) {
    var rate = num(data.fee_rate);
    if (rate != null && rate >= 0 && rate < 1) return rate;
    var n = num(String(data.fee_label || "").replace("%", ""));
    return n == null ? 0.008 : n / 100;
  }

  /* The feed values equity and coin from two price reads a moment apart, so
     equity can disagree with coin + cash by a few dollars. The card shows all
     three, so it has to add up: take the two the reader can see. */
  function bookValue(row, side) {
    var coin = num(row[side + "_coin_usd"]);
    var cash = num(row[side + "_cash_usd"]);
    if (coin != null && cash != null) return coin + cash;
    return num(row[side + "_equity"]);
  }

  function holdValue(capital, seed, spot, fee) {
    var start = num(seed);
    var price = num(spot);
    if (start == null || price == null || start === 0) return null;
    return capital * (1 - fee) * (price / start);
  }

  function capitalOf(data) {
    var n = num(data.capital_per_book);
    return n == null ? 10000 : n;
  }

  function pairsOf(data) {
    return data && Array.isArray(data.pairs) ? data.pairs : [];
  }

  /* The 25% books arrive inside the same snapshot. Until that block has pairs,
     the 25% screen stays empty rather than repeating the 5% numbers. */
  function set25(data) {
    if (!data || !data.sets || typeof data.sets !== "object") return null;
    var s = data.sets["25"];
    if (!s || typeof s !== "object" || !Array.isArray(s.pairs) || !s.pairs.length) return null;
    return s;
  }

  function viewFrom(root) {
    if (!root) return null;
    if (state.gap !== "25") return root;
    var s = set25(root);
    if (!s) return null;
    return {
      pairs: s.pairs,
      fills: Array.isArray(s.fills) ? s.fills : [],
      rollup: s.rollup && typeof s.rollup === "object" ? s.rollup : {},
      generated_at: s.generated_at || root.generated_at,
      capital_per_book: s.capital_per_book != null ? s.capital_per_book : root.capital_per_book,
      fee_rate: s.fee_rate != null ? s.fee_rate : root.fee_rate,
      fee_label: s.fee_label || root.fee_label,
      paper_only: s.paper_only != null ? s.paper_only : root.paper_only,
      _revised: root._revised,
    };
  }

  var WAITING = "The 25% books are not in this update yet.";

  function upper(v) {
    return String(v || "").toUpperCase();
  }

  /* A snapshot can outlive the hot window it describes. Drop entries whose
     watch has already run out rather than showing a stale name as live. */
  function hotNames(data) {
    var hot = data && data.rollup && data.rollup.hot;
    if (!hot || typeof hot !== "object") return [];
    var now = Date.now();
    return Object.keys(hot).filter(function (symbol) {
      var info = hot[symbol];
      if (!info || typeof info !== "object" || !info.until) return true;
      var until = Date.parse(info.until);
      return Number.isNaN(until) ? true : until > now;
    });
  }

  function hotMap(data) {
    var hot = (data && data.rollup && data.rollup.hot) || {};
    var map = {};
    hotNames(data).forEach(function (k) { map[upper(k)] = hot[k]; });
    return map;
  }

  function isHot(row) {
    return !!hotMap(state.view)[upper(row.symbol)];
  }

  /* generated_at is when Grok Bot built the snapshot. Prefer it: the
     Last-Modified header is deploy time, which hides a feed that has stalled
     while deploys keep happening. */
  function snapshotTime(data) {
    var built = data.generated_at ? Date.parse(data.generated_at) : NaN;
    if (!Number.isNaN(built)) return built;
    var header = data._revised ? Date.parse(data._revised) : NaN;
    if (!Number.isNaN(header)) return header;
    var newest = NaN;
    (Array.isArray(data.fills) ? data.fills : []).forEach(function (fill) {
      var ts = fill && fill.ts ? Date.parse(fill.ts) : NaN;
      if (!Number.isNaN(ts) && (Number.isNaN(newest) || ts > newest)) newest = ts;
    });
    return newest;
  }

  function describeAge(ms) {
    var minutes = Math.round(ms / 60000);
    if (minutes < 90) return minutes + " minutes";
    var hours = Math.round(minutes / 60);
    if (hours < 36) return hours + " hours";
    return Math.round(hours / 24) + " days";
  }

  function deltaChip(delta, pct, caption) {
    var box = el("div", { class: "delta " + tone(delta) }, [
      el("div", { class: "delta-main", text: signedUsd(delta, moneyDigits(delta)) }),
      el("div", { class: "delta-sub", text: signedPct(pct) + (caption ? " " + caption : "") }),
    ]);
    return box;
  }

  function etPart(date, opts) {
    opts.timeZone = "America/New_York";
    return new Intl.DateTimeFormat("en-US", opts).format(date);
  }

  /* Date and time have to come from the same instant. Taking the date from
     the deploy header and the time from updated_et read "10/1  11:59 PM ET"
     across midnight. */
  /* "10/1" next to "1:14" reads as "10/11:14". A month name and a separator
     keep the date and the time apart on every day and hour.

     Both halves are formatted here from one timestamp rather than printing a
     field from the feed. updated_et is free text and has changed shape
     already, which would land in the header verbatim. */
  function stampLine(data) {
    var built = data.generated_at ? Date.parse(data.generated_at) : NaN;
    var when = Number.isNaN(built) ? snapshotTime(data) : built;
    var at = Number.isNaN(when) ? new Date() : new Date(when);
    return etPart(at, { month: "short", day: "numeric" }) + " · " +
      etPart(at, { hour: "numeric", minute: "2-digit" }) + " ET";
  }

  function renderFeed(data) {
    document.getElementById("stamp").textContent = stampLine(data);

    var notes = [];
    if (data.paper_only === false) {
      notes.push("This update is not marked as practice only. This site still cannot place orders.");
    }
    var when = snapshotTime(data);
    if (!Number.isNaN(when) && Date.now() - when > STALE_MS) {
      notes.push("This update is " + describeAge(Date.now() - when) + " old. The job that writes it may have stopped.");
    }

    var banner = document.getElementById("banner");
    banner.textContent = notes.join(" ");
    banner.hidden = notes.length === 0;
  }

  function renderPurpose(data) {
    var node = document.getElementById("purpose");
    if (!node) return;
    var books = pairsOf(data).length * 2;
    if (!books) return;
    var here = state.gap === "25" ? "25%" : "5%";
    var other = state.gap === "25" ? "5%" : "25%";
    var otherBooks = books;
    var otherData = state.gap === "25" ? state.data : set25(state.data);
    if (otherData) {
      var counted = pairsOf(otherData).length * 2;
      if (counted) otherBooks = counted;
    }
    node.textContent = "This " + here + " set has " + books + " books. The " + other + " set has another " + otherBooks + ".";
  }

  function renderNear(data) {
    var section = document.getElementById("near-section");
    if (section) section.hidden = false;
    var hot = (data.rollup && data.rollup.hot) || {};
    var hotCard = el("article", { class: "card" });
    var names = hotNames(data);
    if (!names.length) {
      hotCard.append(el("p", { class: "empty", text: "No tokens are on hot watch." }));
    } else {
      names.forEach(function (symbol) {
        var info = hot[symbol];
        var name = el("div", { class: "sym-name", text: symbol });
        var box = el("div", { class: "hot-item" }, [name]);
        if (info && typeof info === "object" && info.last_fill) {
          box.append(el("div", { class: "mini", text: "Last trade " + formatEt(info.last_fill) }));
        } else if (info != null && typeof info !== "object") {
          box.append(el("div", { class: "mini", text: String(info) }));
        }
        hotCard.append(box);
      });
    }

    var wrap = el("div", { class: "near-grid" }, [hotCard]);
    var host = document.getElementById("near");
    host.replaceChildren(wrap);
  }

  function sumField(rows, key) {
    var sum = 0;
    var count = 0;
    rows.forEach(function (row) {
      var v = num(row[key]);
      if (v != null) {
        sum += v;
        count += 1;
      }
    });
    return { sum: sum, count: count };
  }

  function moneyRow(label, value) {
    return el("div", { class: "money-row" }, [
      el("span", { class: "k", text: label }),
      el("span", { class: "start-num", text: value == null ? "—" : usd(value, 0) }),
    ]);
  }

  /* Every row on this card is whole dollars, so Now is built from the two
     rounded numbers above it. Summing first would let the card miss by $1. */
  function totalsCard(title, coin, cash, baseline, fees) {
    var atWork = coin.count ? Math.round(coin.sum) : null;
    var waiting = cash.count ? Math.round(cash.sum) : null;
    var now = atWork == null && waiting == null ? null : (atWork || 0) + (waiting || 0);
    var card = el("article", { class: "card" }, [
      el("h3", { class: "card-title", text: title }),
    ]);
    card.append(moneyRow("At work", atWork));
    card.append(moneyRow("Cash", waiting));
    card.append(moneyRow("Now", now));
    /* Fees are already spent and already inside Now. The muted row keeps it
       from reading as one more number to subtract. */
    if (fees != null) {
      var feeRow = moneyRow("Fees paid", Math.round(fees));
      feeRow.classList.add("money-row-note");
      card.append(feeRow);
    }
    if (now != null && baseline) {
      var gap = now - baseline;
      var chip = deltaChip(gap, (gap / baseline) * 100, "vs start");
      chip.classList.add("delta-corner");
      card.append(chip);
    }
    return card;
  }

  function holdBook(rows, capital, fee) {
    var sum = 0;
    var count = 0;
    rows.forEach(function (row) {
      var held = holdValue(capital, row.neutral_seed, row.spot, fee);
      if (held != null) {
        sum += held;
        count += 1;
      }
    });
    return { sum: sum, count: count };
  }

  function feesTotal(rows, key) {
    var total = sumField(rows, key);
    return total.count ? total.sum : null;
  }

  function renderTotals(data) {
    var rows = pairsOf(data);
    var capital = capitalOf(data);
    var baseline = capital * rows.length;
    var fee = feeRate(data);
    var held = holdBook(rows, capital, fee);
    var neutralFees = feesTotal(rows, "neutral_fees_paid");
    var longFees = feesTotal(rows, "long_fees_paid");
    /* Buy & hold pays its one fee going in, so its total is that fee on every
       book the column can price. Show it only when the grids report theirs, or
       the cards would not be comparable. */
    var heldFees = neutralFees == null && longFees == null ? null : held.count * capital * fee;
    var host = document.getElementById("totals");
    host.replaceChildren(
      totalsCard("Neutral", sumField(rows, "neutral_coin_usd"), sumField(rows, "neutral_cash_usd"), baseline, neutralFees),
      totalsCard("Long", sumField(rows, "long_coin_usd"), sumField(rows, "long_cash_usd"), baseline, longFees),
      totalsCard("Buy & hold", held, { sum: 0, count: held.count }, baseline, heldFees)
    );
  }

  function sortValue(row, key) {
    if (key === "symbol") return String(row.symbol || "");
    if (key === "neutral") return bookValue(row, "neutral");
    if (key === "long") return bookValue(row, "long");
    if (key === "held") return holdValue(capitalOf(state.view), row.neutral_seed, row.spot, feeRate(state.view));
    if (key === "trades") {
      var t = tradeCounts(row, state.view || {});
      return (t.buys || 0) + (t.sells || 0);
    }
    return null;
  }

  function compare(a, b) {
    var va = sortValue(a, state.sortKey);
    var vb = sortValue(b, state.sortKey);
    if (typeof va === "string" || typeof vb === "string") {
      var cs = String(va == null ? "" : va).localeCompare(String(vb == null ? "" : vb));
      if (cs === 0) cs = String(a.symbol || "").localeCompare(String(b.symbol || ""));
      return state.sortDir === "asc" ? cs : -cs;
    }
    var na = va == null;
    var nb = vb == null;
    if (na && nb) return String(a.symbol || "").localeCompare(String(b.symbol || ""));
    if (na) return 1;
    if (nb) return -1;
    var c = va - vb;
    if (c === 0) c = String(a.symbol || "").localeCompare(String(b.symbol || ""));
    return state.sortDir === "asc" ? c : -c;
  }

  function equityCell(equity, capital) {
    var n = num(equity);
    var td = el("td", { class: "num" }, [
      el("div", { class: "eq", text: n == null ? "—" : usd(n, 2) }),
    ]);
    if (n != null) {
      var d = n - capital;
      td.append(el("div", {
        class: "mini " + tone(d),
        text: signedPct((d / capital) * 100),
      }));
    }
    return td;
  }

  /* True when the feed carries its own totals. Without them the counts below
     are only the fills the snapshot happens to still be carrying. */
  function hasTradeTotals(rows) {
    return rows.some(function (row) {
      return num(row.buys) != null || num(row.buy_count) != null ||
        num(row.neutral_buys) != null || num(row.long_buys) != null;
    });
  }

  function tradesNote(data) {
    var rows = pairsOf(data);
    if (!rows.length || hasTradeTotals(rows)) return "";
    var fills = Array.isArray(data.fills) ? data.fills : [];
    if (!fills.length) return "No trades in the window this update carries.";
    var oldest = fills.reduce(function (best, fill) {
      var ts = fill && fill.ts ? Date.parse(fill.ts) : NaN;
      if (Number.isNaN(ts)) return best;
      return Number.isNaN(best) || ts < best ? ts : best;
    }, NaN);
    var since = Number.isNaN(oldest) ? "" : " since " + formatEt(new Date(oldest).toISOString());
    return "Buy and sell count the " + fills.length + " trades this update carries" + since +
      ", not the whole life of each book.";
  }

  function tradeCounts(row, data) {
    var buys = num(row.buys);
    if (buys == null) buys = num(row.buy_count);
    var sells = num(row.sells);
    if (sells == null) sells = num(row.sell_count);
    var nb = num(row.neutral_buys);
    var ns = num(row.neutral_sells);
    var lb = num(row.long_buys);
    var ls = num(row.long_sells);
    if (nb != null || lb != null) buys = (nb || 0) + (lb || 0);
    if (ns != null || ls != null) sells = (ns || 0) + (ls || 0);
    if (buys == null || sells == null) {
      var countedBuys = 0;
      var countedSells = 0;
      var sym = upper(row.symbol);
      (Array.isArray(data.fills) ? data.fills : []).forEach(function (fill) {
        if (!fill || upper(fill.symbol) !== sym) return;
        var side = String(fill.side || "").toLowerCase();
        if (side === "buy") countedBuys += 1;
        else if (side === "sell") countedSells += 1;
      });
      if (buys == null) buys = countedBuys;
      if (sells == null) sells = countedSells;
    }
    return { buys: buys, sells: sells };
  }

  function renderBooks() {
    var data = state.view;
    if (!data) return;
    var capital = capitalOf(data);
    var fee = feeRate(data);
    var rows = pairsOf(data).slice().sort(compare);
    var body = document.getElementById("books-body");
    var frag = document.createDocumentFragment();
    if (!rows.length) {
      frag.append(el("tr", {}, [
        el("td", { class: "empty", colspan: "5", text: "No tokens to show." }),
      ]));
    }
    rows.forEach(function (row) {
      var tr = el("tr");
      if (isHot(row)) tr.classList.add("is-hot");
      var neutral = bookValue(row, "neutral");
      var long = bookValue(row, "long");
      if (neutral == null && long == null) tr.classList.add("is-gap");

      tr.append(el("td", { class: "sym" }, [
        el("span", { class: "sym-name", text: row.symbol || "—" }),
      ]));
      var trades = tradeCounts(row, data);
      tr.append(equityCell(neutral, capital));
      tr.append(equityCell(long, capital));
      tr.append(equityCell(holdValue(capital, row.neutral_seed, row.spot, fee), capital));
      tr.append(el("td", { class: "num trades" }, [
        el("span", { class: "buy-n", text: String(trades.buys) }),
        el("span", { class: "trade-dot", text: "·" }),
        el("span", { class: "sell-n", text: String(trades.sells) }),
      ]));
      frag.append(tr);
    });
    body.replaceChildren(frag);

    var sortSelect = document.getElementById("sort-select");
    if (sortSelect) sortSelect.value = state.sortKey + ":" + state.sortDir;

    var order = state.sortDir === "asc" ? "ascending" : "descending";
    var heads = document.querySelectorAll("#books-table thead th");
    ["symbol", "neutral", "long", "held", "trades"].forEach(function (key, i) {
      if (heads[i]) heads[i].setAttribute("aria-sort", state.sortKey === key ? order : "none");
    });
  }

  function renderTradesNote(data) {
    var node = document.getElementById("trades-note");
    if (!node) return;
    var note = tradesNote(data);
    node.textContent = note;
    node.hidden = !note;
  }

  /* Whole dollars, matching the three Totals cards, so the line ends on the
     numbers printed under it. */
  function trendPoint(data) {
    var rows = pairsOf(data);
    if (!rows.length || !data.generated_at) return null;
    function side(coinKey, cashKey) {
      var coin = sumField(rows, coinKey);
      var cash = sumField(rows, cashKey);
      var at = coin.count ? Math.round(coin.sum) : null;
      var waiting = cash.count ? Math.round(cash.sum) : null;
      if (at == null && waiting == null) return null;
      return (at || 0) + (waiting || 0);
    }
    var held = holdBook(rows, capitalOf(data), feeRate(data));
    var h = held.count ? Math.round(held.sum) : null;
    var n = side("neutral_coin_usd", "neutral_cash_usd");
    var l = side("long_coin_usd", "long_cash_usd");
    if (n == null || l == null || h == null) return null;
    return { t: data.generated_at, n: n, l: l, h: h };
  }

  function trio(p, a, b, c) {
    return num(p[a]) != null && num(p[b]) != null && num(p[c]) != null;
  }

  function keepTrend(p) {
    return p && typeof p.t === "string" && (trio(p, "n", "l", "h") || trio(p, "n25", "l25", "h25"));
  }

  var TREND_KEY = "gridboard-trend";

  function readTrend() {
    try {
      var raw = localStorage.getItem(TREND_KEY);
      var data = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(data)) return [];
      return data.filter(keepTrend);
    } catch (e) {
      return [];
    }
  }

  /* The file is the shared backfill. This browser keeps any newer point it
     has already seen, and the open snapshot is always the last one. */
  function mergeTrend(filePoints, stored, live) {
    var map = {};
    function put(p) {
      if (!p || typeof p.t !== "string") return;
      var prev = map[p.t] || { t: p.t };
      ["n", "l", "h", "n25", "l25", "h25"].forEach(function (key) {
        if (num(p[key]) != null) prev[key] = num(p[key]);
      });
      if (!keepTrend(prev)) return;
      map[p.t] = prev;
    }
    stored.forEach(put);
    (filePoints || []).forEach(put);
    put(live);
    var points = Object.keys(map).map(function (k) { return map[k]; });
    points.sort(function (a, b) {
      if (a.t < b.t) return -1;
      if (a.t > b.t) return 1;
      return 0;
    });
    if (points.length > 4000) points = points.slice(points.length - 4000);
    try { localStorage.setItem(TREND_KEY, JSON.stringify(points)); } catch (e) {}
    return points;
  }

  var HISTORY_FEEDS = [
    "https://raw.githubusercontent.com/agamkram/gridboard-app/main/history.json",
    "history.json",
  ];

  function loadHistory(index) {
    var at = index || 0;
    if (at >= HISTORY_FEEDS.length) return Promise.resolve([]);
    return fetch(HISTORY_FEEDS[at], { cache: "no-cache", headers: { Accept: "application/json" } }).then(
      function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      }
    ).then(function (data) {
      return data && Array.isArray(data.points) ? data.points : [];
    }).catch(function () {
      return loadHistory(at + 1);
    });
  }

  var TREND_STROKE = { n: "#2f4d6f", l: "#1b7a34", h: "#b06a12" };

  function svgNode(name, attrs) {
    var node = document.createElementNS("http://www.w3.org/2000/svg", name);
    Object.keys(attrs || {}).forEach(function (key) {
      node.setAttribute(key, String(attrs[key]));
    });
    return node;
  }

  function trendDomain(points, base) {
    var lo = base;
    var hi = base;
    points.forEach(function (p) {
      ["n", "l", "h"].forEach(function (key) {
        if (p[key] < lo) lo = p[key];
        if (p[key] > hi) hi = p[key];
      });
    });
    var pad = (hi - lo) * 0.14 || 1000;
    return { lo: lo - pad, hi: hi + pad };
  }

  function trendX(i, n) {
    if (n <= 1) return 0;
    return (i / (n - 1)) * 860;
  }

  function trendY(v, domain) {
    var span = domain.hi - domain.lo || 1;
    return 96 - ((v - domain.lo) / span) * 90;
  }

  function seriesPath(points, key, domain) {
    return points.map(function (p, i) {
      var cmd = i ? "L" : "M";
      return cmd + trendX(i, points.length).toFixed(2) + " " + trendY(p[key], domain).toFixed(2);
    }).join(" ");
  }

  function trendWhen(iso, withTime) {
    var d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    if (withTime) {
      return etPart(d, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    }
    return etPart(d, { month: "short", day: "numeric" });
  }

  /* The chart follows the gap on screen. 5% reads n, l, h. 25% reads n25, l25, h25. */
  function seriesForGap() {
    var src = state.trend || [];
    if (state.gap === "25") {
      return src.filter(function (p) { return trio(p, "n25", "l25", "h25"); }).map(function (p) {
        return { t: p.t, n: p.n25, l: p.l25, h: p.h25 };
      });
    }
    return src.filter(function (p) { return trio(p, "n", "l", "h"); }).map(function (p) {
      return { t: p.t, n: p.n, l: p.l, h: p.h };
    });
  }

  function paintTrend() {
    var host = document.getElementById("trend");
    var plot = document.getElementById("trend-plot");
    var points = seriesForGap();
    if (!host || !plot || !state.view || points.length < 2) return;
    var base = capitalOf(state.view) * pairsOf(state.view).length;
    var domain = trendDomain(points, base);
    var at = state.trendAt;
    var scrubbing = at != null && at >= 0 && at < points.length;
    if (!scrubbing) at = points.length - 1;
    var focus = points[at];

    var svg = svgNode("svg", {
      viewBox: "0 0 1000 100",
      preserveAspectRatio: "none",
      "aria-hidden": "true",
    });
    var yBase = trendY(base, domain);
    svg.append(svgNode("path", { class: "base", d: "M0 " + yBase.toFixed(2) + " H860" }));
    ["n", "l", "h"].forEach(function (key) {
      svg.append(svgNode("path", {
        class: "series",
        d: seriesPath(points, key, domain),
        stroke: TREND_STROKE[key],
      }));
    });
    if (scrubbing) {
      var x = trendX(at, points.length).toFixed(2);
      svg.append(svgNode("path", { class: "rule", d: "M" + x + " 4 V96" }));
    }
    var old = plot.querySelector("svg");
    if (old) old.remove();
    plot.insertBefore(svg, plot.firstChild);
    var start = document.getElementById("trend-start");
    if (start) start.style.top = yBase.toFixed(2) + "%";

    var scale = document.getElementById("trend-scale");
    if (scale) {
      if (scrubbing) {
        scale.textContent = trendWhen(focus.t, true);
      } else {
        var from = trendWhen(points[0].t, false);
        var to = trendWhen(points[points.length - 1].t, false);
        scale.textContent = from === to ? from : from + " – " + to;
      }
    }
    ["n", "l", "h"].forEach(function (key) {
      var node = document.getElementById("trend-val-" + key);
      if (node) node.textContent = usd(focus[key], 0);
    });

    var latest = points[points.length - 1];
    host.setAttribute(
      "aria-label",
      "Neutral, Long, and buy and hold from " + trendWhen(points[0].t, false) +
      " to " + trendWhen(latest.t, true) +
      ". Latest Neutral " + usd(latest.n, 0) +
      ", Long " + usd(latest.l, 0) +
      ", buy and hold " + usd(latest.h, 0) + "."
    );
  }

  function renderTrend() {
    var host = document.getElementById("trend");
    if (!host) return;
    var points = seriesForGap();
    if (!state.view || points.length < 2) {
      host.hidden = true;
      return;
    }
    host.hidden = false;
    if (!document.getElementById("trend-plot")) {
      var plot = el("div", { class: "trend-plot", id: "trend-plot" });
      plot.append(el("span", { class: "trend-start", id: "trend-start", text: "start" }));
      var key = el("div", { class: "trend-key" });
      [
        ["n", "Neutral", "trend-n"],
        ["l", "Long", "trend-l"],
        ["h", "Buy & hold", "trend-h"],
      ].forEach(function (spec) {
        key.append(el("div", { class: spec[2] }, [
          el("span", { class: "name", text: spec[1] }),
          el("span", { class: "val", id: "trend-val-" + spec[0], text: "—" }),
        ]));
      });
      host.setAttribute("role", "img");
      host.replaceChildren(
        plot,
        el("div", { class: "trend-scale", id: "trend-scale" }),
        key
      );
      if (!host._trendBound) {
        host._trendBound = true;
        host.addEventListener("selectstart", function (event) {
          event.preventDefault();
        });
        host.addEventListener("pointermove", function (event) {
          var box = document.getElementById("trend-plot");
          var series = seriesForGap();
          if (!box || series.length < 2) return;
          var rect = box.getBoundingClientRect();
          if (!rect.width) return;
          var u = (event.clientX - rect.left) / rect.width / 0.86;
          if (u < 0) u = 0;
          if (u > 1) u = 1;
          var idx = Math.round(u * (series.length - 1));
          if (idx === state.trendAt) return;
          state.trendAt = idx;
          paintTrend();
        });
        host.addEventListener("pointerleave", function () {
          if (state.trendAt == null) return;
          state.trendAt = null;
          paintTrend();
        });
      }
    }
    paintTrend();
  }

  function liveTrend(root) {
    var point = trendPoint(root);
    var wide = set25(root);
    var extra = null;
    if (wide && root.generated_at) {
      extra = trendPoint({
        pairs: wide.pairs,
        generated_at: wide.generated_at || root.generated_at,
        capital_per_book: wide.capital_per_book != null ? wide.capital_per_book : root.capital_per_book,
        fee_rate: wide.fee_rate != null ? wide.fee_rate : root.fee_rate,
        fee_label: wide.fee_label || root.fee_label,
      });
    }
    if (!point && !extra) return null;
    var out = { t: (point && point.t) || (extra && extra.t) };
    if (point) { out.n = point.n; out.l = point.l; out.h = point.h; }
    if (extra) { out.n25 = extra.n; out.l25 = extra.l; out.h25 = extra.h; }
    return out;
  }

  function syncGap() {
    var five = document.getElementById("gap-5");
    var wide = document.getElementById("gap-25");
    if (five) five.setAttribute("aria-pressed", state.gap === "5" ? "true" : "false");
    if (wide) wide.setAttribute("aria-pressed", state.gap === "25" ? "true" : "false");
  }

  function renderWaiting() {
    renderFeed(state.data);
    var purpose = document.getElementById("purpose");
    if (purpose) purpose.textContent = WAITING;
    var near = document.getElementById("near-section");
    if (near) near.hidden = true;
    var totals = document.getElementById("totals");
    if (totals) totals.replaceChildren(el("p", { class: "empty", text: WAITING }));
    var trend = document.getElementById("trend");
    if (trend) trend.hidden = true;
    var note = document.getElementById("trades-note");
    if (note) { note.textContent = ""; note.hidden = true; }
    var body = document.getElementById("books-body");
    if (body) {
      body.replaceChildren(el("tr", {}, [
        el("td", { class: "empty", colspan: "5", text: WAITING }),
      ]));
    }
  }

  function render() {
    syncGap();
    state.view = viewFrom(state.data);
    if (state.gap === "25" && !state.view) {
      renderWaiting();
      return;
    }
    var near = document.getElementById("near-section");
    if (near) near.hidden = false;
    renderFeed(state.view);
    renderPurpose(state.view);
    renderNear(state.view);
    renderTotals(state.view);
    renderTrend();
    renderTradesNote(state.view);
    renderBooks();
  }

  function chooseGap(gap) {
    state.gap = gap === "25" ? "25" : "5";
    try { localStorage.setItem(GAP_KEY, state.gap); } catch (e) {}
    state.trendAt = null;
    if (state.data) render();
    else syncGap();
  }

  function fail(message) {
    var banner = document.getElementById("banner");
    banner.hidden = false;
    banner.textContent = message;
  }

  /* Grok Bot pushes status.json to GitHub every 12 to 15 minutes. Reading it
     there costs no deploy, and Vercel's free plan allows only 100 a day across
     every project on the account, so publishing the data that often used to
     exhaust it. The copy deployed beside this file is the fallback, kept warm
     by a slow publish so the board still works if GitHub cannot be reached. */
  var FEEDS = [
    "https://raw.githubusercontent.com/agamkram/gridboard-app/main/status.json",
    "status.json",
  ];

  function fetchSnapshot(url) {
    return fetch(url, { cache: "no-cache", headers: { Accept: "application/json" } }).then(
      function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        var revised = res.headers.get("Last-Modified");
        return res.json().then(function (data) {
          if (!data || !Array.isArray(data.pairs)) throw new Error("no pairs");
          data._revised = revised;
          return data;
        });
      }
    );
  }

  function loadSnapshot(index) {
    var at = index || 0;
    return fetchSnapshot(FEEDS[at]).catch(function (err) {
      if (at + 1 >= FEEDS.length) throw err;
      console.warn("snapshot: " + FEEDS[at] + " failed, trying the next", err);
      return loadSnapshot(at + 1);
    });
  }

  /* GitHub holds a snapshot for five minutes, so pressing Reload inside that
     window redraws the same numbers and nothing on screen moves. Without a
     word back the button reads as broken. */
  function say(button, text) {
    button.disabled = false;
    button.textContent = text;
    window.clearTimeout(button._revert);
    button._revert = window.setTimeout(function () {
      button.textContent = "Reload";
    }, 2200);
  }

  function load(button) {
    var stamp = document.getElementById("stamp");
    if (!state.data && stamp) stamp.textContent = "Loading…";
    var before = state.data ? state.data.generated_at : null;
    if (button) {
      button.disabled = true;
      button.textContent = "Checking…";
    }
    Promise.all([loadSnapshot(), loadHistory()])
      .then(function (both) {
        var data = both[0];
        var moved = !before || data.generated_at !== before;
        state.data = data;
        state.trendAt = null;
        state.trend = mergeTrend(both[1], readTrend(), liveTrend(data));
        render();
        if (button) say(button, moved ? "Updated" : "No change yet");
      })
      .catch(function (err) {
        console.error(err);
        if (button) say(button, "Failed");
        if (!state.data) fail("The update did not load.");
        else {
          var banner = document.getElementById("banner");
          banner.hidden = false;
          banner.textContent = "Reload failed. The numbers already on screen are still here.";
        }
      });
  }

  document.getElementById("gap-5").addEventListener("click", function () { chooseGap("5"); });
  document.getElementById("gap-25").addEventListener("click", function () { chooseGap("25"); });
  syncGap();

  document.getElementById("reload").addEventListener("click", function () {
    load(this);
  });
  document.getElementById("sort-select").addEventListener("change", function () {
    var parts = String(this.value || "symbol:asc").split(":");
    state.sortKey = parts[0] || "symbol";
    state.sortDir = parts[1] === "desc" ? "desc" : "asc";
    renderBooks();
  });

  load();

  function localHost() {
    var host = location.hostname || "";
    return host === "localhost" || host === "127.0.0.1" || /^\d+\.\d+\.\d+\.\d+$/.test(host);
  }
  if ("serviceWorker" in navigator && !localHost()) {
    navigator.serviceWorker.register("sw.js").catch(function () {});
  }
})();
