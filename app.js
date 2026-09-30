/* GridBoard — read-only renderer for /status.json.
   The page never calls Kraken and never places an order. */
"use strict";

const $ = (sel) => document.querySelector(sel);

const COLUMNS = [
  { key: "symbol", label: "Symbol", kind: "str" },
  { key: "pair", label: "Pair", kind: "str" },
  { key: "spot", label: "Spot", kind: "num", title: "Last spot in the feed" },
  { key: "pct", label: "% vs seed", kind: "num", title: "Percent versus seed, as published" },
  { key: "nEq", label: "Neutral", kind: "num", title: "Neutral book equity" },
  { key: "nDelta", label: "N Δ", kind: "num", title: "Neutral equity minus the book start" },
  { key: "nSeed", label: "N seed", kind: "num" },
  { key: "nOrders", label: "N orders", kind: "num", title: "Open paper rungs" },
  { key: "lEq", label: "Long", kind: "num", title: "Long book equity" },
  { key: "lDelta", label: "L Δ", kind: "num", title: "Long equity minus the book start" },
  { key: "lSeed", label: "L seed", kind: "num" },
  { key: "lOrders", label: "L orders", kind: "num", title: "Open paper rungs" },
  { key: "statusRank", label: "Status", kind: "num", title: "Threat, hot, then gap" },
];

const state = {
  model: null,
  query: "",
  filter: "all",
  sort: { key: "attention", dir: "asc" },
};

function num(v) {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const s = v.trim();
    if (!s || s === "—" || s === "-" || s.toUpperCase() === "ERR") return null;
    const n = Number(s.replace(/[$,\s]/g, ""));
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function money(n, digits = 2) {
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function formatDelta(n) {
  if (n == null || !Number.isFinite(n)) return "—";
  const sign = n > 0 ? "+" : n < 0 ? "−" : "";
  return sign + money(Math.abs(n));
}

function formatPx(n) {
  if (n == null || !Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  const sign = n < 0 ? "−" : "";
  let max = 2;
  if (abs > 0 && abs < 1) {
    max = Math.min(12, Math.ceil(-Math.log10(abs)) + 6);
  } else if (abs >= 1 && abs < 1000) {
    max = 4;
  }
  const body = abs.toLocaleString("en-US", {
    minimumFractionDigits: abs >= 100 ? 2 : 0,
    maximumFractionDigits: max,
  });
  return sign + "$" + body;
}

function formatPct(n) {
  if (n == null || !Number.isFinite(n)) return "—";
  const sign = n > 0 ? "+" : n < 0 ? "−" : "";
  const abs = Math.abs(n);
  const digits = abs >= 100 ? 0 : abs >= 10 ? 1 : 2;
  return sign + abs.toFixed(digits) + "%";
}

function formatQty(n) {
  if (n == null || !Number.isFinite(n)) return "—";
  return n.toLocaleString("en-US", { maximumFractionDigits: 6 });
}

function formatTs(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(d);
}

function formatDur(sec) {
  if (typeof sec !== "number" || !Number.isFinite(sec)) return "—";
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h && m) return h + "h " + m + "m";
  if (h) return h + "h";
  if (m) return m + "m";
  return s + "s";
}

function deltaClass(n) {
  if (n == null || !Number.isFinite(n) || n === 0) return "flat";
  return n > 0 ? "up" : "down";
}

function textOf(v) {
  if (v == null || v === "" || v === "-" || v === "—") return "—";
  if (typeof v === "number") return formatPx(v);
  const s = String(v).trim();
  if (s.toUpperCase() === "ERR") return "ERR";
  return s;
}

function el(tag, attrs, kids) {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === "class") node.className = v;
      else if (k === "text") node.textContent = String(v);
      else node.setAttribute(k, String(v));
    }
  }
  if (kids != null) {
    const list = Array.isArray(kids) ? kids : [kids];
    for (const kid of list) {
      if (kid == null || kid === false || kid === "") continue;
      node.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    }
  }
  return node;
}

function sideRaw(pair, flat, nested, side) {
  if (pair[flat] != null && pair[flat] !== "") return pair[flat];
  const box = pair[nested];
  if (box && typeof box === "object" && box[side] != null) return box[side];
  return null;
}

function threatText(t) {
  if (t == null || t === false || t === "" || t === "—" || t === "-" || t === 0) return "";
  if (t === true) return "Near band";
  if (typeof t === "string" || typeof t === "number") return String(t);
  if (typeof t === "object") {
    const head = [t.symbol, t.style || t.book, t.side].filter(Boolean).join(" · ");
    const dist = t.distance_pct ?? t.pct_to_band ?? t.distance;
    const distStr = typeof dist === "number" ? formatPct(dist) : dist ? String(dist) : "";
    const extra = [t.note, t.message, t.reason, t.band].filter(Boolean).join(" — ");
    return [head, distStr, extra].filter(Boolean).join(" · ") || "Near band";
  }
  return "";
}

function sumSide(pairs, key) {
  let sum = 0;
  let n = 0;
  for (const p of pairs) {
    if (p[key] == null) continue;
    sum += p[key];
    n += 1;
  }
  return { sum, n };
}

function build(data) {
  const capital = num(data.capital_per_book) ?? 10000;
  const hotMap = data.rollup && data.rollup.hot && typeof data.rollup.hot === "object" ? data.rollup.hot : {};
  const hotSet = new Set(Object.keys(hotMap).map((s) => s.toUpperCase()));
  const coreSymbols = Array.isArray(data.core_symbols) && data.core_symbols.length
    ? data.core_symbols.map(String)
    : ["ADA", "ETH", "BTC", "ZEC"];
  const coreSet = new Set(coreSymbols.map((s) => s.toUpperCase()));

  const pairs = (Array.isArray(data.pairs) ? data.pairs : []).map((p) => {
    const symbol = String(p.symbol || "").toUpperCase();
    const nEq = num(p.neutral_equity);
    const lEq = num(p.long_equity);
    const nSeedRaw = sideRaw(p, "neutral_seed", "seeds", "neutral");
    const lSeedRaw = sideRaw(p, "long_seed", "seeds", "long");
    const nOrdRaw = sideRaw(p, "neutral_orders", "orders", "neutral");
    const lOrdRaw = sideRaw(p, "long_orders", "orders", "long");
    const threat = threatText(p.threat);
    const hot = hotSet.has(symbol);
    const gap = nEq == null || lEq == null;
    let statusRank = 5;
    if (gap) statusRank = 2;
    if (hot) statusRank = 1;
    if (threat) statusRank = 0;
    return {
      symbol,
      pair: p.pair || "",
      spot: num(p.spot),
      pct: num(p.pct_vs_seed),
      nEq,
      lEq,
      nDelta: nEq == null ? null : nEq - capital,
      lDelta: lEq == null ? null : lEq - capital,
      nSeedRaw,
      lSeedRaw,
      nSeed: num(nSeedRaw),
      lSeed: num(lSeedRaw),
      nOrders: num(nOrdRaw),
      lOrders: num(lOrdRaw),
      nOrdRaw,
      lOrdRaw,
      nWs: p.neutral_ws || p.neutral_workspace || "",
      lWs: p.long_ws || p.long_workspace || "",
      threat,
      hot,
      core: coreSet.has(symbol),
      gap,
      statusRank,
    };
  });

  const threats = [];
  const seen = new Set();
  for (const t of Array.isArray(data.threats) ? data.threats : []) {
    const text = typeof t === "string" ? t : threatText(t);
    const symbol = t && typeof t === "object" && t.symbol ? String(t.symbol).toUpperCase() : "";
    const key = symbol || text;
    if (!text || seen.has(key)) continue;
    seen.add(key);
    threats.push({ symbol, text });
  }
  for (const p of pairs) {
    if (!p.threat || seen.has(p.symbol)) continue;
    seen.add(p.symbol);
    threats.push({ symbol: p.symbol, text: p.symbol + " · " + p.threat });
  }

  return {
    data,
    capital,
    pairs,
    coreSymbols,
    hotMap,
    threats,
    neutral: sumSide(pairs, "nEq"),
    long: sumSide(pairs, "lEq"),
  };
}

function renderStamp(model) {
  const stamp = $("#stamp");
  const paper = model.data.paper_only === true;
  stamp.textContent = paper ? "Paper only" : "Not marked paper";
  stamp.classList.toggle("warn", !paper);
  stamp.setAttribute(
    "aria-label",
    paper
      ? "Paper only. This board does not trade."
      : "This feed is not marked paper only. The board still does not trade."
  );
  const headline = model.data.headline ? " — " + model.data.headline : "";
  document.title = paper ? "GridBoard" + headline : "GridBoard — feed is not marked paper only";
}

function renderPills(model) {
  const d = model.data;
  const bits = [];
  if (d.fee_label) bits.push("Trade fee " + d.fee_label);
  if (d.spacing) bits.push(d.spacing);
  bits.push(money(model.capital, 0) + " each book");
  $("#pills").replaceChildren(...bits.map((b) => el("li", { text: b })));
}

function renderSpecs(model) {
  const d = model.data;
  const lines = [];
  if (d.neutral_spec) lines.push("Neutral " + d.neutral_spec);
  if (d.long_spec) lines.push("Long " + d.long_spec);
  if (lines.length) $("#specs").textContent = lines.join("  ·  ");
}

function quote(k, v) {
  return el("p", { class: "quote" }, [
    el("span", { class: "k", text: k }),
    el("span", { class: "v", text: v }),
  ]);
}

function sideBlock(label, p, prefix) {
  const block = el("div", { class: "side-block " + prefix });
  block.append(el("h4", { text: label }));
  if (!p) {
    block.append(el("p", { class: "eq", text: "—" }));
    return block;
  }
  const eq = p[prefix + "Eq"];
  const delta = p[prefix + "Delta"];
  const eqNode = el("p", { class: "eq", text: eq == null ? "—" : money(eq) });
  if (eq != null) eqNode.title = String(eq);
  block.append(eqNode);
  if (eq == null) block.append(el("p", { class: "unread", text: "Unread" }));
  else block.append(el("p", { class: "delta " + deltaClass(delta), text: formatDelta(delta) }));
  const seed = p[prefix + "Seed"];
  const seedTxt = seed == null ? textOf(p[prefix + "SeedRaw"]) : formatPx(seed);
  const orders = p[prefix + "Orders"];
  const ordTxt = orders == null ? textOf(p[prefix + "OrdRaw"]) : String(Math.round(orders));
  block.append(el("p", { class: "seedline", text: "seed " + seedTxt + " · orders " + ordTxt }));
  return block;
}

function coreCard(sym, p) {
  const card = el("article", { class: "card core-card" + (p ? "" : " missing") });
  const head = el("header", { class: "core-head" });
  head.append(el("h3", { text: sym }));
  head.append(el("p", { class: "pair", text: p && p.pair ? p.pair : "—" }));
  card.append(head);
  const quotes = el("div", { class: "quotes" });
  quotes.append(quote("Spot", p && p.spot != null ? formatPx(p.spot) : "—"));
  quotes.append(quote("% vs seed", p ? formatPct(p.pct) : "—"));
  card.append(quotes);
  const books = el("div", { class: "books" });
  books.append(sideBlock("Neutral", p, "n"));
  books.append(sideBlock("Long", p, "l"));
  card.append(books);
  if (!p) card.append(el("p", { class: "note", text: "Not in this feed." }));
  return card;
}

function renderCore(model) {
  const bySym = new Map(model.pairs.map((p) => [p.symbol, p]));
  const cards = model.coreSymbols.map((sym) => coreCard(sym.toUpperCase(), bySym.get(sym.toUpperCase()) || null));
  $("#core").replaceChildren(...cards);
}

function renderThreats(model) {
  const box = $("#threats");
  $("#threat-count").textContent = String(model.threats.length);
  if (!model.threats.length) {
    box.replaceChildren(el("p", { class: "empty", text: "No pairs are inside the near band." }));
    return;
  }
  const ul = el("ul", { class: "threat-list" });
  for (const t of model.threats) {
    const li = el("li");
    if (t.symbol) {
      const btn = el("button", { type: "button", class: "linkish", text: t.symbol });
      btn.addEventListener("click", () => focusSymbol(t.symbol));
      const rest = t.text.startsWith(t.symbol) ? t.text.slice(t.symbol.length) : " · " + t.text;
      li.append(btn, document.createTextNode(rest));
    } else {
      li.textContent = t.text;
    }
    ul.append(li);
  }
  box.replaceChildren(ul);
}

function renderRollup(model) {
  const box = $("#rollup");
  const r = model.data.rollup;
  if (!r || typeof r !== "object") {
    box.replaceChildren(el("p", { class: "empty", text: "No rollup in this feed." }));
    return;
  }
  const stats = el("dl", { class: "stats" });
  const rows = [
    ["Neutral quiet", r.n_quiet],
    ["Long quiet", r.l_quiet],
    ["Other pairs", r.other_pairs],
    ["Neutral fills", r.n_fills],
    ["Long fills", r.l_fills],
    ["Fills since last ping", r.continuous_fills_since_last_ping],
  ];
  for (const [k, v] of rows) {
    if (v == null) continue;
    stats.append(el("div", {}, [el("dt", { text: k }), el("dd", { text: String(v) })]));
  }
  const known = new Set([
    "n_quiet",
    "l_quiet",
    "other_pairs",
    "n_fills",
    "l_fills",
    "continuous_fills_since_last_ping",
    "hot",
  ]);
  for (const k of Object.keys(r)) {
    if (known.has(k) || r[k] == null || typeof r[k] === "object") continue;
    const label = k.replaceAll("_", " ");
    stats.append(el("div", {}, [el("dt", { text: label }), el("dd", { text: String(r[k]) })]));
  }

  const hotWrap = el("div", { class: "hot-list" });
  hotWrap.append(el("h3", { text: "Hot window" }));
  const hotKeys = Object.keys(model.hotMap);
  if (!hotKeys.length) {
    hotWrap.append(el("p", { class: "muted", text: "No books in the hot window." }));
  } else {
    hotKeys.sort((a, b) => (model.hotMap[b].remaining_s || 0) - (model.hotMap[a].remaining_s || 0));
    for (const sym of hotKeys) {
      const h = model.hotMap[sym] || {};
      const card = el("article", { class: "hot" });
      card.append(el("strong", { text: sym }));
      const bits = [];
      if (h.fills != null) bits.push(h.fills + " fill" + (h.fills === 1 ? "" : "s"));
      if (h.quiet_s != null) bits.push("quiet " + formatDur(h.quiet_s));
      if (h.remaining_s != null) bits.push(formatDur(h.remaining_s) + " left in window");
      if (bits.length) card.append(el("p", { text: bits.join(" · ") }));
      const sub = [];
      if (h.last_fill) sub.push("Last fill " + formatTs(h.last_fill));
      if (h.until) sub.push("until " + formatTs(h.until));
      if (sub.length) card.append(el("p", { class: "muted", text: sub.join(" · ") }));
      hotWrap.append(card);
    }
  }
  box.replaceChildren(stats, hotWrap);
}

function startNow(startText, nowText, extra) {
  return el("div", { class: "sn" }, [
    el("div", {}, [
      el("p", { class: "k", text: "Start" }),
      el("p", { class: "v", text: startText }),
    ]),
    el("div", {}, [
      el("p", { class: "k", text: "Now" }),
      el("p", { class: "v now", text: nowText }),
      extra,
    ]),
  ]);
}

function totalCard(label, agg, bookCount, capital) {
  const card = el("article", { class: "card total" });
  card.append(el("h3", { text: label }));
  const fullStart = capital * bookCount;
  const reportedStart = capital * agg.n;
  const unread = bookCount - agg.n;
  const fullDelta = agg.n ? agg.sum - fullStart : null;
  const perfDelta = agg.n ? agg.sum - reportedStart : null;
  const nowText = agg.n ? money(agg.sum) : "—";

  if (!agg.n) {
    card.append(startNow(money(fullStart, 0), "—", el("p", { class: "unread", text: "No readings" })));
    card.append(el("p", { class: "caveat", text: "Nothing is counted as $0." }));
    return card;
  }

  card.append(el("p", { class: "sn-label", text: "Full baseline · " + money(capital, 0) + " × " + bookCount }));
  if (unread > 0) {
    card.append(startNow(
      money(fullStart, 0),
      nowText,
      el("div", {}, [
        el("p", { class: "baseline-gap", text: formatDelta(fullDelta) }),
        el("p", { class: "note", text: unread + " unread, not counted as $0" }),
      ])
    ));
    card.append(el("p", { class: "sn-label", text: "Reporting books · " + agg.n }));
    card.append(startNow(
      money(reportedStart, 0),
      nowText,
      el("p", { class: "delta " + deltaClass(perfDelta), text: formatDelta(perfDelta) })
    ));
  } else {
    card.append(startNow(
      money(fullStart, 0),
      nowText,
      el("div", {}, [
        el("p", { class: "delta " + deltaClass(fullDelta), text: formatDelta(fullDelta) }),
        el("p", { class: "note", text: "All " + bookCount + " books" }),
      ])
    ));
  }
  return card;
}

function scannedCard(model) {
  const card = el("article", { class: "card total" });
  card.append(el("h3", { text: "Scanned" }));
  const scanned = model.data.scanned;
  card.append(el("p", { class: "figure", text: scanned == null ? "—" : String(scanned) }));
  const books = model.pairs.length * 2;
  card.append(el("p", { class: "note", text: model.pairs.length + " pairs · " + books + " books on this board" }));
  if (scanned != null && Number(scanned) !== books) {
    card.append(el("p", { class: "note", text: "The scanned count and the pair list differ." }));
  }
  return card;
}

function renderTotals(model) {
  const n = model.pairs.length;
  $("#totals").replaceChildren(
    totalCard("Neutral", model.neutral, n, model.capital),
    totalCard("Long", model.long, n, model.capital),
    scannedCard(model)
  );
}

function matchFilter(p) {
  if (state.filter === "core") return p.core;
  if (state.filter === "hot") return p.hot;
  if (state.filter === "threat") return !!p.threat;
  if (state.filter === "gap") return p.gap;
  return true;
}

function matchQuery(p) {
  const q = state.query.trim().toLowerCase();
  if (!q) return true;
  return [p.symbol, p.pair, p.nWs, p.lWs, p.threat].join(" ").toLowerCase().includes(q);
}

function compareAttention(a, b) {
  const ag = (a.nEq == null ? 1 : 0) + (a.lEq == null ? 1 : 0);
  const bg = (b.nEq == null ? 1 : 0) + (b.lEq == null ? 1 : 0);
  if (ag !== bg) return bg - ag;
  const af = (a.threat ? 2 : 0) + (a.hot ? 1 : 0);
  const bf = (b.threat ? 2 : 0) + (b.hot ? 1 : 0);
  if (af !== bf) return bf - af;
  const aw = Math.min(a.nDelta == null ? Infinity : a.nDelta, a.lDelta == null ? Infinity : a.lDelta);
  const bw = Math.min(b.nDelta == null ? Infinity : b.nDelta, b.lDelta == null ? Infinity : b.lDelta);
  if (aw !== bw) return aw - bw;
  return a.symbol.localeCompare(b.symbol);
}

function sorterFor(key) {
  if (key === "attention") return compareAttention;
  const col = COLUMNS.find((c) => c.key === key);
  const dir = state.sort.dir === "asc" ? 1 : -1;
  if (!col || col.kind === "num") {
    return (a, b) => {
      const av = a[key];
      const bv = b[key];
      if (av == null && bv == null) return a.symbol.localeCompare(b.symbol);
      if (av == null) return 1;
      if (bv == null) return -1;
      if (av !== bv) return (av - bv) * dir;
      return a.symbol.localeCompare(b.symbol);
    };
  }
  return (a, b) => String(a[key] || "").localeCompare(String(b[key] || "")) * dir || a.symbol.localeCompare(b.symbol);
}

function sortNote() {
  if (state.sort.key === "attention") {
    return "Sorted by attention: unread books, threats, then the weakest equity.";
  }
  const col = COLUMNS.find((c) => c.key === state.sort.key);
  const dir = state.sort.dir === "asc" ? "low to high" : "high to low";
  return "Sorted by " + (col ? col.label : state.sort.key) + ", " + dir + ".";
}

function tag(label, cls) {
  return el("span", { class: "tag " + cls, text: label });
}

function eqCell(v) {
  const td = el("td", { class: "num", text: v == null ? "—" : money(v) });
  if (v != null) td.title = String(v);
  return td;
}

function deltaCell(v) {
  if (v == null) return el("td", { class: "num", text: "—" });
  return el("td", { class: "num" }, el("span", { class: "delta " + deltaClass(v), text: formatDelta(v) }));
}

function seedCell(numVal, raw) {
  const td = el("td", { class: "num" });
  if (numVal != null) {
    td.textContent = formatPx(numVal);
    td.title = String(raw);
  } else if (textOf(raw) === "ERR") {
    td.append(el("span", { class: "err", text: "ERR" }));
  } else {
    td.textContent = "—";
  }
  return td;
}

function ordersCell(numVal, raw) {
  const td = el("td", { class: "num" });
  if (numVal != null) td.textContent = String(Math.round(numVal));
  else if (textOf(raw) === "ERR") td.append(el("span", { class: "err", text: "ERR" }));
  else td.textContent = "—";
  return td;
}

function statusCell(p) {
  const td = el("td", { class: "status" });
  const tags = [];
  if (p.core) tags.push(["Core", "core"]);
  if (p.hot) tags.push(["Hot", "hot"]);
  if (p.threat) tags.push(["Threat", "threat"]);
  if (p.gap) tags.push(["Gap", "gap"]);
  if (!tags.length) tags.push(["Quiet", "quiet"]);
  for (const [label, cls] of tags) td.append(tag(label, cls));
  return td;
}

function rowFor(p) {
  const cls = [];
  if (p.gap) cls.push("gap");
  if (p.hot) cls.push("hot");
  if (p.threat) cls.push("threat");
  if (p.core) cls.push("core");
  const tr = el("tr", { class: cls.join(" "), "data-symbol": p.symbol });
  const sym = el("td", { class: "sym" });
  sym.append(el("span", { class: "symname", text: p.symbol || "—" }));
  const ws = [p.nWs, p.lWs].filter(Boolean).join(" · ");
  if (ws) sym.append(el("span", { class: "ws", title: ws, text: ws }));
  tr.append(sym);
  tr.append(el("td", { text: p.pair || "—" }));
  tr.append(el("td", { class: "num", text: p.spot == null ? "—" : formatPx(p.spot) }));
  tr.append(el("td", { class: "num", text: formatPct(p.pct) }));
  tr.append(eqCell(p.nEq));
  tr.append(deltaCell(p.nDelta));
  tr.append(seedCell(p.nSeed, p.nSeedRaw));
  tr.append(ordersCell(p.nOrders, p.nOrdRaw));
  tr.append(eqCell(p.lEq));
  tr.append(deltaCell(p.lDelta));
  tr.append(seedCell(p.lSeed, p.lSeedRaw));
  tr.append(ordersCell(p.lOrders, p.lOrdRaw));
  tr.append(statusCell(p));
  return tr;
}

function renderTable(opts) {
  const model = state.model;
  if (!model) return;
  const rows = model.pairs.filter((p) => matchFilter(p) && matchQuery(p));
  rows.sort(sorterFor(state.sort.key));

  const hr = el("tr");
  for (const col of COLUMNS) {
    const th = el("th", {
      scope: "col",
      class: (col.kind === "num" ? "num" : "") + (col.key === "symbol" ? " sym" : ""),
    });
    const active = state.sort.key === col.key;
    th.setAttribute("aria-sort", active ? (state.sort.dir === "asc" ? "ascending" : "descending") : "none");
    const btn = el("button", {
      type: "button",
      "data-sort": col.key,
      text: col.label,
      title: col.title || "Sort by " + col.label,
    });
    if (active) btn.append(document.createTextNode(state.sort.dir === "asc" ? " ▲" : " ▼"));
    btn.addEventListener("click", () => onSort(col.key));
    th.append(btn);
    hr.append(th);
  }
  const tbody = el("tbody");
  for (const p of rows) tbody.append(rowFor(p));
  $("#book-table").replaceChildren(
    el("caption", { class: "sr-only", text: "Paper grid books" }),
    el("thead", {}, hr),
    tbody
  );

  $("#showing").textContent = "Showing " + rows.length + " of " + model.pairs.length;
  $("#sort-note").textContent = sortNote();
  const empty = $("#table-empty");
  empty.hidden = rows.length > 0;
  const reset = $("#reset-sort");
  reset.setAttribute("aria-pressed", state.sort.key === "attention" ? "true" : "false");

  if (opts && opts.focus) {
    const btn = $("#book-table").querySelector('button[data-sort="' + opts.focus + '"]');
    if (btn) btn.focus();
  }
}

function onSort(key) {
  if (state.sort.key === key) {
    state.sort.dir = state.sort.dir === "asc" ? "desc" : "asc";
  } else {
    state.sort = { key, dir: "asc" };
  }
  renderTable({ focus: key });
}

function fillItem(f) {
  const art = el("article", { class: "fill" });
  const label = [f.symbol, f.style, f.side].filter(Boolean).join(" ");
  if (label) art.setAttribute("aria-label", label);
  art.append(el("time", { datetime: f.ts || "", text: formatTs(f.ts) }));
  const sym = el("button", { type: "button", class: "linkish", text: f.symbol || "—" });
  if (f.symbol) sym.addEventListener("click", () => focusSymbol(String(f.symbol).toUpperCase()));
  art.append(sym);
  art.append(el("span", { text: f.style || "—" }));
  const side = String(f.side || "").toLowerCase();
  const sideCls = side === "buy" || side === "sell" ? side : "";
  art.append(el("span", { class: "side " + sideCls, text: side ? side.toUpperCase() : "—" }));
  art.append(el("span", {
    class: "fill-px",
    text: (num(f.volume) == null ? "—" : formatQty(num(f.volume))) + " @ " + (num(f.price) == null ? "—" : formatPx(num(f.price))),
  }));
  const relSide = f.reladder_side ? String(f.reladder_side).toUpperCase() : "";
  const relPx = num(f.reladder_price);
  const placed = f.placed === true ? "placed" : f.placed === false ? "not placed" : "";
  const rel = [relSide && "reladder " + relSide, relPx != null && formatPx(relPx), placed].filter(Boolean).join(" · ");
  if (rel) art.append(el("span", { class: "rel", text: rel }));
  const meta = [f.workspace, f.cycle != null ? "cycle " + f.cycle : "", f.mode, f.note].filter(Boolean).join(" · ");
  if (meta) art.append(el("span", { class: "meta", text: meta }));
  return art;
}

function renderFills(model) {
  const fills = Array.isArray(model.data.fills) ? model.data.fills.slice() : [];
  $("#fill-count").textContent = String(fills.length);
  if (!fills.length) {
    $("#fills-body").replaceChildren(el("p", { class: "empty", text: "No fills in this digest." }));
    return;
  }
  fills.sort((a, b) => String(b.ts || "").localeCompare(String(a.ts || "")));
  $("#fills-body").replaceChildren(...fills.map(fillItem));
}

function focusSymbol(symbol) {
  state.filter = "all";
  state.query = symbol;
  const input = $("#q");
  input.value = symbol;
  document.querySelectorAll("[data-filter]").forEach((b) => {
    b.setAttribute("aria-pressed", b.dataset.filter === "all" ? "true" : "false");
  });
  renderTable();
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  $("#pairs").scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
}

function render() {
  const model = state.model;
  renderStamp(model);
  renderPills(model);
  renderSpecs(model);
  $("#updated").textContent = model.data.updated_et
    ? "Updated " + model.data.updated_et
    : "Update time not in the feed";
  const headline = $("#headline");
  if (model.data.headline) {
    headline.hidden = false;
    headline.textContent = model.data.headline;
  } else {
    headline.hidden = true;
    headline.textContent = "";
  }
  const schema = $("#schema");
  schema.textContent = model.data.schema_version != null ? "Schema " + model.data.schema_version + ". " : "";
  renderCore(model);
  renderThreats(model);
  renderRollup(model);
  renderTotals(model);
  renderTable();
  renderFills(model);
}

async function load() {
  const err = $("#error");
  err.hidden = true;
  document.body.setAttribute("aria-busy", "true");
  try {
    const res = await fetch("/status.json", { cache: "no-cache" });
    if (!res.ok) throw new Error("status.json returned " + res.status);
    const data = await res.json();
    if (!data || !Array.isArray(data.pairs)) throw new Error("status.json has no pairs array");
    state.model = build(data);
    render();
  } catch (e) {
    if (!state.model) $("#updated").textContent = "Feed unavailable";
    err.hidden = false;
    err.textContent =
      "Could not read /status.json. " +
      (e && e.message ? e.message : "Unknown error") +
      " Serve this folder over HTTP so the page can fetch the feed.";
  } finally {
    document.body.removeAttribute("aria-busy");
  }
}

$("#reload").addEventListener("click", load);
$("#reset-sort").addEventListener("click", () => {
  state.sort = { key: "attention", dir: "asc" };
  renderTable();
  $("#reset-sort").focus();
});
document.querySelectorAll("[data-filter]").forEach((btn) => {
  btn.addEventListener("click", () => {
    state.filter = btn.dataset.filter;
    document.querySelectorAll("[data-filter]").forEach((b) => {
      b.setAttribute("aria-pressed", b === btn ? "true" : "false");
    });
    renderTable();
  });
});
$("#q").addEventListener("input", () => {
  state.query = $("#q").value;
  renderTable();
});

load();
