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

  function formatDuration(seconds) {
    if (!Number.isFinite(seconds)) return "—";
    var s = Math.max(0, Math.round(seconds));
    var h = Math.floor(s / 3600);
    var m = Math.floor((s % 3600) / 60);
    if (h > 0) return h + "h " + m + "m";
    if (m > 0) return m + "m";
    return s + "s";
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

  function renderFeed(data) {
    var fee = data.fee_label || "0.80%";
    document.getElementById("fee-pill").textContent = "Trade fee " + fee;
    document.getElementById("spacing").textContent = data.spacing || "geometric 5% (r=1.05)";
    var line = [data.updated_et, data.headline].filter(Boolean).join(" · ");
    document.getElementById("app-feed").textContent = line || "Snapshot loaded";
    var specs = [data.neutral_spec, data.long_spec].filter(Boolean).join("  ·  ");
    document.getElementById("specs").textContent = specs;
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
      hotCard.append(el("p", { class: "empty", text: "No coins are on hot watch." }));
    } else {
      names.forEach(function (symbol) {
        var info = hot[symbol];
        var box = el("div", { class: "hot-item" }, [
          el("div", { class: "sym-name", text: symbol }),
        ]);
        if (!info || typeof info !== "object") {
          box.append(el("div", { class: "mini", text: info == null ? "Hot" : String(info) }));
        } else {
          var bits = [];
          var fills = num(info.fills);
          if (fills != null) bits.push(fills + (fills === 1 ? " fill" : " fills"));
          var quiet = num(info.quiet_s);
          if (quiet != null) bits.push("quiet " + formatDuration(quiet));
          var left = num(info.remaining_s);
          if (left != null) bits.push(left > 0 ? formatDuration(left) + " left" : "window ended");
          box.append(el("div", { class: "mini", text: bits.join(" · ") || "Hot" }));
          if (info.last_fill) box.append(el("div", { class: "mini", text: "Last fill " + formatEt(info.last_fill) }));
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

  function totalsCard(title, stats, capital) {
    var card = el("article", { class: "card" }, [
      el("h3", { class: "card-title", text: title }),
    ]);
    card.append(el("div", { class: "sn" }, [
      el("div", {}, [
        el("span", { class: "k", text: "START" }),
        el("div", { class: "start-num", text: usd(stats.baseline, 0) }),
      ]),
      el("div", {}, [
        el("span", { class: "k", text: "NOW" }),
        el("div", { class: "now-num", text: stats.count ? usd(stats.sum, 2) : "—" }),
      ]),
    ]));
    card.append(el("p", { class: "mini", text: usd(capital, 0) + " × " + (stats.count + stats.missing) }));
    if (stats.count) {
      var pricedPct = stats.count ? (stats.pricedGap / (capital * stats.count)) * 100 : 0;
      card.append(deltaChip(stats.gap, (stats.gap / stats.baseline) * 100, "vs baseline"));
      if (stats.missing) {
        card.append(deltaChip(stats.pricedGap, pricedPct, "on priced books"));
        card.append(el("p", { class: "mini", text: stats.missing + " unseeded, left out of NOW" }));
      }
    } else {
      card.append(el("p", { class: "mini", text: "No priced accounts in this update." }));
    }
    return card;
  }

  function renderTotals(data) {
    var rows = pairsOf(data);
    var capital = capitalOf(data);
    var neutral = sideStats(rows, "neutral_equity", capital);
    var long = sideStats(rows, "long_equity", capital);
    var host = document.getElementById("totals");
    host.replaceChildren(
      totalsCard("Neutral", neutral, capital),
      totalsCard("Long", long, capital)
    );
  }

  function sortValue(row, key) {
    if (key === "symbol") return String(row.symbol || "");
    if (key === "neutral") return num(row.neutral_equity);
    if (key === "long") return num(row.long_equity);
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
    var q = state.query.trim().toLowerCase();
    if (q) {
      var hay = [row.symbol, row.pair, row.neutral_ws, row.long_ws].join(" ").toLowerCase();
      if (hay.indexOf(q) === -1) return false;
    }
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
        text: signedUsd(d, moneyDigits(d)) + " · " + signedPct((d / capital) * 100),
      }));
    }
    return td;
  }

  function renderBooks() {
    var data = state.data;
    if (!data) return;
    var capital = capitalOf(data);
    var rows = pairsOf(data).filter(visible).sort(compare);
    var body = document.getElementById("books-body");
    var frag = document.createDocumentFragment();
    if (!rows.length) {
      frag.append(el("tr", {}, [
        el("td", { class: "empty", colspan: "3", text: "No pairs match." }),
      ]));
    }
    rows.forEach(function (row) {
      var tr = el("tr");
      if (isHot(row)) tr.classList.add("is-hot");
      if (num(row.neutral_equity) == null && num(row.long_equity) == null) tr.classList.add("is-gap");

      tr.append(el("td", { class: "sym" }, [
        el("span", { class: "sym-name", text: row.symbol || "—" }),
      ]));
      tr.append(equityCell(row.neutral_equity, capital));
      tr.append(equityCell(row.long_equity, capital));
      frag.append(tr);
    });
    body.replaceChildren(frag);

    var all = pairsOf(data);
    var counts = { all: all.length, hot: 0, unseeded: 0, filled: 0 };
    all.forEach(function (row) {
      if (isHot(row)) counts.hot += 1;
      if (isUnseeded(row)) counts.unseeded += 1;
      if (filledSet(data)[upper(row.symbol)]) counts.filled += 1;
    });
    document.querySelectorAll("#chips [data-filter]").forEach(function (btn) {
      var key = btn.getAttribute("data-filter");
      var labels = {
        all: "All",
        hot: "Hot",
        unseeded: "Unseeded",
        filled: "Filled",
      };
      btn.textContent = labels[key] + " " + (counts[key] == null ? "" : counts[key]);
      btn.setAttribute("aria-pressed", key === state.filter ? "true" : "false");
    });
    document.getElementById("book-count").textContent = "Showing " + rows.length + " of " + all.length;

    document.querySelectorAll("#books-table [data-sort]").forEach(function (btn) {
      var key = btn.getAttribute("data-sort");
      var label = btn.getAttribute("data-label") || key;
      var on = key === state.sortKey;
      btn.textContent = label + (on ? (state.sortDir === "asc" ? " ↑" : " ↓") : "");
      var th = btn.closest("th");
      if (th) th.setAttribute("aria-sort", on ? (state.sortDir === "asc" ? "ascending" : "descending") : "none");
    });
  }

  function render() {
    renderFeed(state.data);
    renderNear(state.data);
    renderTotals(state.data);
    renderBooks();
  }

  function fail(message) {
    document.getElementById("app-feed").textContent = "Could not load the update.";
    var banner = document.getElementById("banner");
    banner.hidden = false;
    banner.textContent = message;
  }

  function load() {
    var feed = document.getElementById("app-feed");
    var previous = feed.textContent;
    feed.textContent = state.data ? "Reloading…" : "Loading…";
    fetch("status.json", { cache: "no-cache", headers: { Accept: "application/json" } })
      .then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
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
          feed.textContent = previous;
          var banner = document.getElementById("banner");
          banner.hidden = false;
          banner.textContent = "Reload failed. The numbers already on screen are still here.";
        }
      });
  }

  document.getElementById("reload").addEventListener("click", load);
  document.getElementById("q").addEventListener("input", function (e) {
    state.query = e.target.value;
    renderBooks();
  });
  document.getElementById("chips").addEventListener("click", function (e) {
    var btn = e.target.closest("[data-filter]");
    if (!btn) return;
    state.filter = btn.getAttribute("data-filter");
    renderBooks();
  });
  document.getElementById("books-table").addEventListener("click", function (e) {
    var btn = e.target.closest("[data-sort]");
    if (!btn) return;
    var key = btn.getAttribute("data-sort");
    if (state.sortKey === key) state.sortDir = state.sortDir === "asc" ? "desc" : "asc";
    else {
      state.sortKey = key;
      state.sortDir = "asc";
    }
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
