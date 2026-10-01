/* GridBoard — read-only. The only request is status.json. No orders, no Kraken API. */
(function () {
  var state = {
    data: null,
    query: "",
    filter: "all",
    sortKey: "symbol",
    sortDir: "asc",
  };

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

  function feeRate(data) {
    var label = String(data.fee_label || "0.80%").replace("%", "");
    var n = num(label);
    return n == null ? 0.008 : n / 100;
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

  function hotMap(data) {
    var hot = data.rollup && data.rollup.hot;
    var map = {};
    if (!hot || typeof hot !== "object") return map;
    Object.keys(hot).forEach(function (k) { map[upper(k)] = hot[k]; });
    return map;
  }

  function filledSet(data) {
    var set = {};
    (Array.isArray(data.fills) ? data.fills : []).forEach(function (f) {
      if (f && f.symbol) set[upper(f.symbol)] = true;
    });
    return set;
  }

  function isHot(row) {
    return !!hotMap(state.data)[upper(row.symbol)];
  }

  function isUnseeded(row) {
    return num(row.neutral_equity) == null || num(row.long_equity) == null;
  }

  function deltaChip(delta, pct, caption) {
    var box = el("div", { class: "delta " + tone(delta) }, [
      el("div", { class: "delta-main", text: signedUsd(delta, moneyDigits(delta)) }),
      el("div", { class: "delta-sub", text: signedPct(pct) + (caption ? " " + caption : "") }),
    ]);
    return box;
  }

  function stampLine(data) {
    var when = data._revised ? new Date(data._revised) : new Date();
    if (Number.isNaN(when.getTime())) when = new Date();
    var date = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      month: "numeric",
      day: "numeric",
    }).format(when);
    var time = data.updated_et || "";
    return time ? date + "  " + time : date;
  }

  function renderFeed(data) {
    document.getElementById("stamp").textContent = stampLine(data);
    var feed = document.getElementById("app-feed");
    if (feed) {
      feed.textContent = "";
      feed.hidden = true;
    }
    var banner = document.getElementById("banner");
    if (data.paper_only === false) {
      banner.hidden = false;
      banner.textContent = "This update is not marked as practice only. This site still cannot place orders.";
    } else {
      banner.hidden = true;
      banner.textContent = "";
    }
  }

  function renderNear(data) {
    var hot = data.rollup && data.rollup.hot;
    var hotCard = el("article", { class: "card" });
    var names = hot && typeof hot === "object" ? Object.keys(hot) : [];
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

  function sideStats(rows, key, capital) {
    var sum = 0;
    var count = 0;
    var missing = 0;
    rows.forEach(function (row) {
      var v = num(row[key]);
      if (v == null) missing += 1;
      else {
        sum += v;
        count += 1;
      }
    });
    var baseline = capital * rows.length;
    return {
      sum: sum,
      count: count,
      missing: missing,
      baseline: baseline,
      gap: sum - baseline,
      pricedGap: sum - capital * count,
    };
  }

  function sumField(rows, key) {
    var sum = 0;
    var count = 0;
    var missing = 0;
    rows.forEach(function (row) {
      var v = num(row[key]);
      if (v == null) missing += 1;
      else {
        sum += v;
        count += 1;
      }
    });
    return { sum: sum, count: count, missing: missing };
  }

  function moneyRow(label, value) {
    return el("div", { class: "money-row" }, [
      el("span", { class: "k", text: label }),
      el("span", { class: "start-num", text: value == null ? "—" : usd(value, 0) }),
    ]);
  }

  function totalsCard(title, atWork, cash, now, baseline) {
    var card = el("article", { class: "card" }, [
      el("h3", { class: "card-title", text: title }),
    ]);
    card.append(moneyRow("At work", atWork));
    card.append(moneyRow("Cash", cash));
    card.append(moneyRow("Now", now));
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
    var missing = 0;
    rows.forEach(function (row) {
      var held = holdValue(capital, row.neutral_seed, row.spot, fee);
      if (held == null) missing += 1;
      else {
        sum += held;
        count += 1;
      }
    });
    var baseline = capital * rows.length;
    return {
      sum: sum,
      count: count,
      missing: missing,
      baseline: baseline,
      gap: sum - baseline,
      pricedGap: sum - capital * count,
    };
  }

  function renderTotals(data) {
    var rows = pairsOf(data);
    var capital = capitalOf(data);
    var fee = feeRate(data);
    var neutralNow = sideStats(rows, "neutral_equity", capital);
    var longNow = sideStats(rows, "long_equity", capital);
    var neutralCoin = sumField(rows, "neutral_coin_usd");
    var neutralCash = sumField(rows, "neutral_cash_usd");
    var longCoin = sumField(rows, "long_coin_usd");
    var longCash = sumField(rows, "long_cash_usd");
    var held = holdBook(rows, capital, fee);
    var host = document.getElementById("totals");
    host.replaceChildren(
      totalsCard("Neutral", neutralCoin.count ? neutralCoin.sum : null, neutralCash.count ? neutralCash.sum : null, neutralNow.count ? neutralNow.sum : null, neutralNow.baseline),
      totalsCard("Long", longCoin.count ? longCoin.sum : null, longCash.count ? longCash.sum : null, longNow.count ? longNow.sum : null, longNow.baseline),
      totalsCard("Buy & hold", held.count ? held.sum : null, held.count ? 0 : null, held.count ? held.sum : null, held.baseline)
    );
  }

  function sortValue(row, key) {
    if (key === "symbol") return String(row.symbol || "");
    if (key === "neutral") return num(row.neutral_equity);
    if (key === "long") return num(row.long_equity);
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

  function visible(row) {
    if (state.filter === "hot") return isHot(row);
    if (state.filter === "unseeded") return isUnseeded(row);
    if (state.filter === "filled") return !!filledSet(state.data)[upper(row.symbol)];
    return true;
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
    var rows = pairsOf(data).filter(visible).sort(compare);
    var body = document.getElementById("books-body");
    var frag = document.createDocumentFragment();
    if (!rows.length) {
      frag.append(el("tr", {}, [
        el("td", { class: "empty", colspan: "5", text: "No tokens match." }),
      ]));
    }
    rows.forEach(function (row) {
      var tr = el("tr");
      if (isHot(row)) tr.classList.add("is-hot");
      if (num(row.neutral_equity) == null && num(row.long_equity) == null) tr.classList.add("is-gap");

      tr.append(el("td", { class: "sym" }, [
        el("span", { class: "sym-name", text: row.symbol || "—" }),
      ]));
      var trades = tradeCounts(row, data);
      tr.append(equityCell(row.neutral_equity, capital));
      tr.append(equityCell(row.long_equity, capital));
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

    var aria = {
      symbol: state.sortKey === "symbol" ? (state.sortDir === "asc" ? "ascending" : "descending") : "none",
      neutral: state.sortKey === "neutral" ? (state.sortDir === "asc" ? "ascending" : "descending") : "none",
      long: state.sortKey === "long" ? (state.sortDir === "asc" ? "ascending" : "descending") : "none",
      held: state.sortKey === "held" ? (state.sortDir === "asc" ? "ascending" : "descending") : "none",
      trades: state.sortKey === "trades" ? (state.sortDir === "asc" ? "ascending" : "descending") : "none",
    };
    var heads = document.querySelectorAll("#books-table thead th");
    if (heads[0]) heads[0].setAttribute("aria-sort", aria.symbol);
    if (heads[1]) heads[1].setAttribute("aria-sort", aria.neutral);
    if (heads[2]) heads[2].setAttribute("aria-sort", aria.long);
    if (heads[3]) heads[3].setAttribute("aria-sort", aria.held);
    if (heads[4]) heads[4].setAttribute("aria-sort", aria.trades);
  }

  function render() {
    renderFeed(state.data);
    renderNear(state.data);
    renderTotals(state.data);
    renderBooks();
  }

  function fail(message) {
    var banner = document.getElementById("banner");
    banner.hidden = false;
    banner.textContent = message;
  }

  function load() {
    var stamp = document.getElementById("stamp");
    if (!state.data && stamp) stamp.textContent = "Loading…";
    fetch("status.json", { cache: "no-cache", headers: { Accept: "application/json" } })
      .then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        var revised = res.headers.get("Last-Modified");
        return res.json().then(function (data) {
          if (data && typeof data === "object") data._revised = revised;
          return data;
        });
      })
      .then(function (data) {
        if (!data || !Array.isArray(data.pairs)) throw new Error("status.json has no pairs");
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
