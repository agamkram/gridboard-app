/* GridBoard — read-only. The only request is status.json. No orders, no Kraken API. */
(function () {
  var state = {
    data: null,
    sortKey: "symbol",
    sortDir: "asc",
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
    return Array.isArray(data.pairs) ? data.pairs : [];
  }

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
    return !!hotMap(state.data)[upper(row.symbol)];
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
     keep the date and the time apart on every day and hour. */
  function stampLine(data) {
    var built = data.generated_at ? Date.parse(data.generated_at) : NaN;
    if (!Number.isNaN(built)) {
      var at = new Date(built);
      return etPart(at, { month: "short", day: "numeric" }) + " · " +
        etPart(at, { hour: "numeric", minute: "2-digit" }) + " ET";
    }
    var when = snapshotTime(data);
    var fallback = Number.isNaN(when) ? new Date() : new Date(when);
    var date = etPart(fallback, { month: "short", day: "numeric" });
    var time = data.updated_et || "";
    return time ? date + " · " + time : date;
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
    node.textContent = "This dashboard tracks " + books + " automated grids continuously managed by Grok Bot.";
  }

  function renderNear(data) {
    var hot = (data.rollup && data.rollup.hot) || {};
    var hotCard = el("article", { class: "card" });
    var names = hotNames(data);
    if (!names.length) {
      hotCard.append(el("p", { class: "empty", text: "No tokens are on hot watch." }));
    } else {
      names.forEach(function (symbol) {
        var info = hot[symbol];
        var box = el("div", { class: "hot-item" }, [
          el("div", { class: "sym-name", text: symbol }),
        ]);
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
    if (key === "held") return holdValue(capitalOf(state.data), row.neutral_seed, row.spot, feeRate(state.data));
    if (key === "trades") {
      var t = tradeCounts(row, state.data || {});
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
    var data = state.data;
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

  function render() {
    renderFeed(state.data);
    renderPurpose(state.data);
    renderNear(state.data);
    renderTotals(state.data);
    renderTradesNote(state.data);
    renderBooks();
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

  function load() {
    var stamp = document.getElementById("stamp");
    if (!state.data && stamp) stamp.textContent = "Loading…";
    loadSnapshot()
      .then(function (data) {
        state.data = data;
        render();
      })
      .catch(function (err) {
        console.error(err);
        if (!state.data) fail("The update did not load.");
        else {
          var banner = document.getElementById("banner");
          banner.hidden = false;
          banner.textContent = "Reload failed. The numbers already on screen are still here.";
        }
      });
  }

  document.getElementById("reload").addEventListener("click", load);
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
