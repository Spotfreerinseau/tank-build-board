"use strict";
// Counts are local drafts; all saved figures and recipes come from Shopify.
const board = new TankBoard.Board({
  fetcher: window.fetch.bind(window),
  storage: {
    getItem: (key) => window.localStorage.getItem(key),
    setItem: (key, value) => window.localStorage.setItem(key, value),
    removeItem: (key) => window.localStorage.removeItem(key),
  },
  key:
    "tank-board:" +
    (new URLSearchParams(location.search).get("shop") ||
      new URLSearchParams(location.search).get("host") ||
      location.host),
});
let parts = [],
  movements = [],
  tank_board_product = [],
  tank_board_settings = {};
let page = "home",
  stockView = "now",
  partFilter = "all",
  partSearch = "",
  historySearch = "",
  historyKind = "all",
  action = "count",
  countIndex = 0,
  countReview = false,
  countDraft = board.readStored("counts", {}),
  reviewSnapshot = [],
  undoSnapshot = null,
  outSku = "",
  outQty = 1,
  outWhy = "gift",
  outWho = "",
  receiveCode = "",
  receiveQty = 1,
  receiveNote = "",
  toastTimer,
  busy = false,
  phase = "loading",
  error = "",
  draftError = "";
board.onUpdate = () => {
  parts = board.parts;
  movements = board.movements;
  tank_board_product = board.products;
  tank_board_settings = board.settings;
  countIndex = Math.max(0, Math.min(countIndex, parts.length - 1));
  if (!bySku(outSku)) outSku = tank_board_product[0]?.sku || "";
  if (!byCode(receiveCode))
    receiveCode =
      parts.find((p) => p.on_water > 0)?.code || parts[0]?.code || "";
};
function keepDraft() {
  try {
    board.store("counts", countDraft);
    draftError = "";
  } catch (e) {
    draftError = e.message;
  }
  const warning = $("#draft-storage-status");
  if (warning) {
    warning.textContent = draftError;
    warning.hidden = !draftError;
  }
}
function now() {
  return new Date();
}
function today() {
  return now().toLocaleDateString("en-AU", {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: "Australia/Brisbane",
  });
}
function message(e) {
  return (
    e?.message || "Shopify didn’t confirm that change. Your work is kept here."
  );
}
function statusBanners() {
  return (
    (error
      ? `<div class="flow-alert error" role="alert">${esc(error)}</div>`
      : "") +
    `<div id="draft-storage-status" class="flow-alert error" role="alert" ${draftError ? "" : "hidden"}>${esc(draftError)}</div>` +
    (board.pending
      ? `<div class="flow-alert warning" role="alert">A save is unfinished: ${esc(board.pending.movement.summary)}. Keep using this device to finish it. Don’t enter the same change again. <button class="btn" data-resume>Check and finish save</button></div>`
      : "")
  );
}
async function load() {
  if (busy || !window.shopify) return;
  busy = true;
  error = "";
  render();
  try {
    await board.refresh();
    phase = "ready";
  } catch (e) {
    error = message(e);
    if (!parts.length) phase = "error";
  } finally {
    busy = false;
    render();
  }
}
function finishSuccess(m) {
  if (m?.kind === "count") {
    for (const c of m.changes) {
      const d = countDraft[c.code];
      if (d && Number(d.garage) + Number(d.shed) === c.to)
        delete countDraft[c.code];
    }
    keepDraft();
    countReview = false;
    countIndex = 0;
  }
  if (m && ["gift", "sample", "faulty", "order"].includes(m.kind)) {
    outQty = 1;
    outWho = "";
  }
  if (m?.kind === "receive") {
    receiveNote = "";
    receiveQty = 1;
  }
}
async function save(build, resume = false) {
  if (busy) return;
  clearTimeout(toastTimer);
  $("#toast").innerHTML = "";
  busy = true;
  error = "";
  render();
  try {
    const m = resume ? await board.resume() : await board.save(build);
    finishSuccess(m);
    $("#modal").close();
    toast("Saved to Shopify. History keeps the record.");
  } catch (e) {
    error = message(e);
  } finally {
    busy = false;
    render();
  }
}
const names = {
  home: "Home",
  parts: "Parts",
  trends: "Trends",
  actions: "Actions",
  history: "History",
};
const icons = {
  home: "home",
  parts: "parts",
  trends: "trends",
  actions: "actions",
  history: "history",
};
const whyLabels = {
  order: "Order",
  gift: "Gift",
  sample: "Sample",
  faulty: "Faulty",
  receive: "Delivery",
  count: "Stocktake",
  putback: "Put back",
};
const $ = (s) => document.querySelector(s),
  icon = (name, cls = "") =>
    `<svg class="icon ${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[c],
  );
const fmt = (n) =>
  n === null || n === undefined
    ? "—"
    : Number(n).toLocaleString("en-AU", { maximumFractionDigits: 1 });
const byCode = (code) => parts.find((p) => p.code === code);
const bySku = (sku) => tank_board_product.find((p) => p.sku === sku);
const date = (d) =>
  new Date(d).toLocaleDateString("en-AU", {
    day: "numeric",
    month: "short",
    timeZone: "Australia/Brisbane",
  });
const time = (d) =>
  new Date(d).toLocaleTimeString("en-AU", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "Australia/Brisbane",
  });
const weeks = (units, rate) => TankBoard.weeks(units, rate);
const severity = (w) =>
  w === null ? "amber" : w < 6 ? "red" : w < 12 - 0.05 ? "amber" : "green";
const trend = (p) =>
  p.prev_sales > 0
    ? Math.round((p.monthly_sales / p.prev_sales - 1) * 100)
    : null;
function trendText(p) {
  const n = trend(p);
  return n === null
    ? p.prev_sales === null
      ? "Previous sales unavailable"
      : p.monthly_sales
        ? "New sales"
        : "No sales"
    : `${n >= 0 ? "↑" : "↓"} ${Math.abs(n)}%`;
}
function pace(code) {
  return TankBoard.pace(code, tank_board_product);
}
function partInfo(p) {
  return TankBoard.partInfo(
    p,
    pace(p.code),
    board.reservations()[p.code] || 0,
    now(),
  );
}
function arrivalText(info) {
  return info.arrival ? "lands ~" + date(info.arrival) : "Arrival date not set";
}
function allocate(includeWater = false) {
  return TankBoard.allocate(
    parts,
    tank_board_product,
    board.reservations(),
    includeWater,
  );
}
function tankArt(pro) {
  return `<svg class="tank-art" viewBox="0 0 92 140" fill="none" aria-hidden="true"><defs><linearGradient id="tank-${pro ? "p" : "l"}" x1="20" x2="75"><stop stop-color="#e5e8e1"/><stop offset=".4" stop-color="#fafbf8"/><stop offset="1" stop-color="#d7dfd0"/></linearGradient></defs><ellipse cx="46" cy="129" rx="28" ry="4" fill="#e0e5d9"/><path d="M21 52c0-13 50-13 50 0v65c0 16-50 16-50 0Z" fill="url(#tank-${pro ? "p" : "l"})" stroke="#b9c4ad"/><path d="M22 57c13 8 35 8 48 0 M23 114c13 8 33 8 46 0" stroke="#c5cebd"/><rect x="35" y="27" width="22" height="19" rx="5" fill="${pro ? "#384436" : "#537d9c"}"/><path d="M38 29V17h17c8 0 10 12 2 13" stroke="#48583c" stroke-width="5"/><path d="M45 28v-8 M32 36H19v9" stroke="${pro ? "#384436" : "#537d9c"}" stroke-width="7" stroke-linecap="round"/><rect x="33" y="75" width="26" height="24" rx="3" fill="${pro ? "#49623e" : "#6c8860"}"/><path d="M41 83h11 M41 87h8 M41 91h10" stroke="#fff" stroke-opacity=".6" stroke-width="1.5"/><circle cx="60" cy="43" r="5" fill="#edf3e7" stroke="#677e54"/><path d="m60 43 2-2" stroke="#677e54"/></svg>`;
}
function nav() {
  const html = Object.entries(names)
    .map(
      ([key, name]) =>
        `<button type="button" data-page="${key}" ${page === key ? 'aria-current="page"' : ""}>${icon(icons[key])}<span>${name}</span>${key === "parts" && page !== key ? `<span class="nav-count">${parts.filter((p) => partInfo(p).sev === "red").length}</span>` : ""}</button>`,
    )
    .join("");
  $("#desktop-nav").innerHTML = html;
  $("#mobile-nav").innerHTML = html.replace(
    /<span class="nav-count">.*?<\/span>/g,
    "",
  );
  $("#crumb").textContent = names[page];
}
function heading(title, subtitle, buttons = "") {
  return `<div class="page-heading"><div><div class="eyebrow">${page === "home" ? esc(today()) : "Your workshop"}</div><h1>${title}</h1><p>${subtitle}</p></div><div class="heading-actions">${buttons}</div></div>`;
}
function footer() {
  const sync = tank_board_settings.sync;
  const at =
    sync?.at && !isNaN(Date.parse(sync.at))
      ? `${date(sync.at)}, ${time(sync.at)}`
      : "Time not supplied";
  return `<footer class="page-footer"><span>${icon("check")}Daily sync · ${esc(at)}${sync?.through ? " · Through order " + esc(sync.through) : ""}</span><span>Scheduled for 6:51 am · Shopify data</span></footer>`;
}
function productCard(r, index) {
  const p = r.p,
    full = r.mode === "full",
    bundle = r.mode === "bundle",
    tank = ["SFR-TANK-10L", "SFR-TANK-15L"].includes(p.sku),
    pro = p.sku === "SFR-TANK-15L",
    block = r.blocked ? byCode(r.blocked)?.name || r.blocked : "parts",
    cover = r.unknown
      ? full && r.uncounted.length && r.n === null
        ? "Count the parts first"
        : "Check the recipe first"
      : r.w === null
        ? "No sales pace"
        : `${r.w.toFixed(1)} weeks of cover`,
    tag = bundle
      ? "Shopify bundle"
      : r.unknown
        ? full && r.uncounted.length && r.n === null
          ? "Count parts first"
          : "Check recipe"
        : r.sev === "red"
          ? "Running low"
          : r.atCap || (full && r.sev === "green")
            ? "Well stocked"
            : "Keep an eye on it",
    water = r.blocked && byCode(r.blocked)?.on_water > 0;
  return `<article class="panel product ${bundle ? "" : r.sev} ${!tank ? "secondary" : ""}"><div class="product-main"><div class="product-top"><div class="product-title"><span class="mini-icon">${icon(tank ? "drop" : "parts")}</span><div><h3>${esc(p.short_name)}</h3>${tank ? `<small>${pro ? "15" : "10"} litre DI water tank</small>` : ""}</div></div><span class="pill ${bundle ? "" : r.sev}"><span class="dot"></span>${tag}</span></div><div class="product-numbers">${bundle ? '<div class="small muted">Stock comes from the products inside it in Shopify</div>' : `<div><div class="build-number num">${r.unknown ? "—" : fmt(r.n)}</div><div class="metric-label">can be built</div></div>`}<div class="sale"><div class="sale-number num">${fmt(p.listed)}</div><div class="metric-label">last listed in Shopify</div></div></div>${tank ? tankArt(pro) : ""}</div><div class="product-cover">${!bundle && (!full || r.w !== null) ? `<div class="cover-line"><b>${cover}</b><span>${fmt(p.monthly_sales)} sold / 30 days</span></div>` : ""}${!bundle && !full ? `<div class="cover-track" role="img" aria-label="${esc(cover)} out of a 12-week target"><i style="width:${Math.min(100, ((r.w || 0) / 12) * 100)}%"></i></div>` : ""}<div class="trend-caption"><b class="${trend(p) !== null && trend(p) < 0 ? "down" : "up"}">${trendText(p)}</b> · Previous 30 days: ${fmt(p.prev_sales)} ${r.mode === "shared" && !r.unknown && p.listed !== null && p.listed > r.n ? '<span class="pill red">Listed exceeds parts</span>' : ""}</div></div><div class="product-foot"><span>${bundle ? "" : icon(r.atCap ? "check" : "parts")}${bundle ? "" : full ? (r.blocked ? "Held back by " + esc(block) : "Everything you can build") : r.unknown ? "A recipe needs checking" : r.atCap ? "At the 12-week limit" : "Held back by " + esc(block)}${water && stockView === "now" && r.w !== null && partInfo(byCode(r.blocked)).gap ? " · Runs out before the delivery lands" : ""}</span><button type="button" data-recipe="${esc(p.sku)}" aria-expanded="false" aria-controls="recipe-${index}">Parts ${icon("arrow")}</button></div><div id="recipe-${index}" class="recipe-details" hidden>${p.parts.map((i) => `<div class="recipe-line"><span>${esc(byCode(i.code)?.name || i.code)} × ${fmt(i.qty)}</span><b>${fmt(byCode(i.code)?.on_hand)} on hand</b></div>`).join("") || (bundle ? "<p>No recipe recorded in Shopify.</p>" : "<p>Recipe missing or invalid. Check this product in Shopify.</p>")}<p>${bundle ? "Stock comes from the products inside it in Shopify." : full ? "Recipe from Shopify. These units use the parts left after the shared products." : "Recipe from Shopify. Shared parts are counted once across the board."}${!bundle && r.uncounted.length ? " Uncounted parts are treated as unlimited for this estimate, matching the daily sync: " + r.uncounted.map((code) => esc(byCode(code).name)).join(", ") + ". Count them before taking stock out." : ""}${p.listed === null ? " The daily sync has not supplied a listed quantity." : ""}</p></div></article>`;
}
function tankMix(previous = false) {
  const lite = bySku("SFR-TANK-10L"),
    pro = bySku("SFR-TANK-15L"),
    field = previous ? "prev_sales" : "monthly_sales";
  if (!lite || !pro || lite[field] === null || pro[field] === null) return null;
  const total = lite[field] + pro[field];
  return total > 0
    ? {
        lite: lite[field],
        pro: pro[field],
        total,
        percent: Math.round((lite[field] / total) * 100),
      }
    : null;
}
function mix() {
  const m = tankMix();
  if (!m) return '<p class="muted">No tank sales pace available yet.</p>';
  return `<div class="mix-track" role="img" aria-label="Lite ${m.percent}%, Pro ${100 - m.percent}% of tank sales"><div class="lite" style="width:${m.percent}%"></div><div class="pro" style="width:${100 - m.percent}%"></div></div><div class="mix-labels"><span><i class="legend-dot"></i>Lite <b>${m.percent}%</b> · ${m.lite} sold</span><span><i class="legend-dot pro"></i>Pro <b>${100 - m.percent}%</b> · ${m.pro} sold</span></div>`;
}
function shortStatus(info) {
  if (info.gap) {
    const unit = litres(info.p.unit)
      ? "litres"
      : info.p.unit === "each"
        ? "units"
        : info.p.unit || "units";
    return `${fmt(info.p.on_water)} on the way, ${arrivalText(info)}. Runs out about ${info.gapWeeks.toFixed(1)} weeks before it lands, about ${fmt(info.shortfall)} ${unit} short`;
  }
  return info.overdue ? "Overdue: order now" : "Order by " + date(info.due);
}
function runningShortPanel() {
  const rows = TankBoard.runningShort(
    parts,
    tank_board_product,
    board.reservations(),
    now(),
  );
  return `<section id="running-short" class="panel running-short" aria-labelledby="running-short-title"><div class="panel-head"><h2 id="running-short-title">Running short</h2></div>${rows.length ? rows.map((info) => `<button type="button" class="shortage-row ${info.gap || info.overdue ? "red" : "amber"}" data-part-focus="${esc(info.p.code)}" aria-label="View ${esc(info.p.name)} in Parts"><span class="shortage-part"><strong>${esc(info.p.name)}</strong><small class="muted">${esc(info.p.supplier)}</small><span class="small muted">Holds back: ${info.products.map((p) => esc(p.short_name || p.name || p.sku)).join(", ")}</span></span><span class="shortage-cover"><strong class="num">${info.w.toFixed(1)} weeks</strong><small class="muted">runs out ~${date(info.runOut)}</small></span><span class="shortage-status">${esc(shortStatus(info))}</span>${icon("arrow")}</button>`).join("") : '<div class="panel-body small muted">Nothing running short at the current pace.</div>'}</section>`;
}
function home() {
  const syncAt = tank_board_settings.sync?.at,
    lastRun =
      syncAt && !isNaN(Date.parse(syncAt))
        ? `${date(syncAt)}, ${time(syncAt)}`
        : "not recorded";
  const a = allocate(stockView === "after"),
    tanks = a.result.filter((r) =>
      ["SFR-TANK-10L", "SFR-TANK-15L"].includes(r.p.sku),
    ),
    tankTotal = tanks.some((r) => r.unknown)
      ? null
      : tanks.reduce((s, r) => s + r.n, 0),
    sales = tank_board_product.reduce((s, p) => s + p.monthly_sales, 0),
    prev = tank_board_product.some((p) => p.prev_sales === null)
      ? null
      : tank_board_product.reduce((s, p) => s + p.prev_sales, 0),
    change = prev > 0 ? Math.round((sales / prev - 1) * 100) : null,
    urgent = parts
      .map(partInfo)
      .filter((x) => x.sev !== "green")
      .sort((a, b) => (a.due ?? Infinity) - (b.due ?? Infinity)),
    oldMix = tankMix(true);
  return (
    heading(
      "Here’s what you can build.",
      "Your parts, shared out to keep up with sales.",
      `<button class="btn" data-flow="count">${icon("count")}Count stock</button><button class="btn primary" data-flow="out">${icon("out")}Take stock out</button>`,
    ) +
    `${parts.some((p) => p.on_hand === null) ? '<div class="flow-alert warning">Uncounted parts are treated as unlimited in the build estimate, as in the daily sync. Count them before taking stock out.</div>' : ""}${runningShortPanel()}<div class="summary"><div class="summary-item"><div class="label">${icon("drop")}Tanks you can build</div><strong class="num">${fmt(tankTotal)}</strong><small>Lite + Pro, shared parts</small></div><div class="summary-item"><div class="label">${icon("trends")}Sold in the last 30 days</div><strong class="num">${fmt(sales)}</strong><small>${change !== null ? `<span class="${change < 0 ? "down" : "up"}">${change < 0 ? "↓" : "↑"} ${Math.abs(change)}%</span>` : "Previous total: " + fmt(prev)} · across all products</small></div><div class="summary-item"><div class="label">${icon("truck")}Parts on the way</div><strong class="num">${parts.filter((p) => p.on_water > 0).length}</strong><small>part types awaiting delivery</small></div></div><div class="section-heading"><h2>Your build board <span class="muted small">· ${tank_board_product.length} products</span></h2><div class="segmented" role="group" aria-label="Stock to include"><button data-stock="now" aria-pressed="${stockView === "now"}">On hand</button><button data-stock="after" aria-pressed="${stockView === "after"}">After delivery</button></div></div>${stockView === "after" ? '<div class="flow-alert">Includes stock on the way. Only stock on hand can be built today.</div>' : ""}<div class="product-grid">${a.result.map(productCard).join("")}</div><p id="reservation-note" class="small muted">Parts for unshipped orders are set aside at each daily sync (last run ${esc(lastRun)}).</p><details class="explanation"><summary>${icon("parts")} How these numbers are worked out</summary><p>After the parts set aside at the last daily sync, shared products get two units each where possible, then share the remaining parts by sales pace up to 12 weeks of cover; full products get everything they can build from what’s left, with no cap. Shopify bundles use the products inside them in Shopify and take no parts from this pool.</p></details><div class="bottom-grid"><section class="panel"><div class="panel-head"><h2>Next on your list</h2><p>Counts, deliveries and parts to order.</p></div><div class="panel-body">${
      urgent
        .slice(0, 2)
        .map(
          (x) =>
            `<div class="task-line"><span class="task-dot ${x.sev}"></span><div class="grow"><b>${esc(x.p.name)}</b><p>${reorderText(x)}</p></div><button class="btn" data-part-focus="${esc(x.p.code)}">View ${icon("arrow")}</button></div>`,
        )
        .join("") ||
      '<p class="muted">No urgent parts at the current sales pace.</p>'
    }</div></section><section class="panel"><div class="panel-head"><h2>Lite or Pro?</h2><p>Tank sales in the last 30 days.</p></div><div class="panel-body">${mix()}</div><div class="panel-footer"><span>${oldMix ? `Pro was ${100 - oldMix.percent}% in the previous 30 days` : "Previous tank mix unavailable"}</span><button class="text-btn" data-page="trends">See trends →</button></div></section></div>`
  );
}
function filteredParts() {
  return parts
    .map(partInfo)
    .filter(
      (x) =>
        (partFilter !== "order" || x.sev !== "green") &&
        (partFilter !== "water" || x.p.on_water > 0) &&
        `${x.p.name} ${x.p.code}`
          .toLowerCase()
          .includes(partSearch.toLowerCase()),
    )
    .sort(
      (a, b) => (a.due?.getTime() ?? Infinity) - (b.due?.getTime() ?? Infinity),
    );
}
function reorderText(x) {
  if (x.p.on_hand === null) return "Count this part first";
  if (x.p.on_water > 0)
    return x.gap
      ? shortStatus(x)
      : `Delivery on the way, ${arrivalText(x)}${x.due ? " · next order by " + date(x.due) : ""}`;
  if (x.p.lead_days === null) return "Set this part’s lead time in Shopify";
  return x.due
    ? `Order by ${date(x.due)}${x.overdue ? " · Overdue" : ""}`
    : "No sales pace yet";
}
function partsResults() {
  const rows = filteredParts();
  return rows.length
    ? `<table class="part-table"><thead><tr><th>Part</th><th>On hand</th><th>On the way</th><th>On hold</th><th>Weeks left</th><th>Order by</th></tr></thead><tbody>${rows.map((x) => `<tr><td class="part-first"><b>${esc(x.p.name)}</b><small>${esc(x.p.code)} <span class="supplier-name">· ${esc(x.p.supplier)}</span></small></td><td><span class="cell-num num">${fmt(x.p.on_hand)}</span> <span class="muted small">${litres(x.p.unit) ? "L" : ""}</span></td><td><span class="num ${x.p.on_water ? "up" : "muted"}">${fmt(x.p.on_water)}</span>${x.p.on_water ? `<small class="arrival-date">${arrivalText(x)}</small>` : ""}</td><td><span class="num muted">${fmt(x.p.on_hold)}</span></td><td><span class="pill ${x.sev}">${x.w === null ? "—" : x.w.toFixed(1) + " weeks"}</span></td><td><div class="order-date ${x.sev}">${reorderText(x)}</div><small>${x.p.lead_days === null ? "Lead time not set" : x.p.lead_days + " days to land"}</small></td></tr>`).join("")}</tbody></table><div class="part-cards">${rows.map((x) => `<article class="part-card"><div class="row between"><div><h3>${esc(x.p.name)}</h3><div class="small muted">${esc(x.p.code)} · ${x.p.lead_days === null ? "Lead time not set" : x.p.lead_days + " days to land"}</div></div><span class="pill ${x.sev}">${x.w === null ? "—" : x.w.toFixed(1) + " weeks"}</span></div><div class="part-stocks"><div><b class="num">${fmt(x.p.on_hand)}${litres(x.p.unit) ? " L" : ""}</b>On hand</div><div><b class="num ${x.p.on_water ? "up" : ""}">${fmt(x.p.on_water)}</b>On the way${x.p.on_water ? `<small class="arrival-date">${arrivalText(x)}</small>` : ""}</div><div><b class="num">${fmt(x.p.on_hold)}</b>On hold</div></div><div class="part-reorder ${x.sev}"><span>${reorderText(x)}</span>${x.p.on_water ? `<button class="text-btn" data-receive="${esc(x.p.code)}">Receive →</button>` : ""}</div></article>`).join("")}</div><div class="data-note">Weeks left use all products’ sales and the parts set aside at the last daily sync. Reorder dates count stock on the way as coming and use each part’s lead time. Delivery warnings use the part’s ETA, or today plus its lead time when ETA is blank. On hold is separate from usable stock.</div>`
    : '<div class="empty">No parts match. Try another name or filter.</div>';
}
function partsPage() {
  return (
    heading(
      "Parts, before you run short.",
      "Most urgent first. Extrepure parts take about 90 days to land.",
      `<button class="btn" data-flow="count">${icon("count")}Count stock</button><button class="btn primary" data-flow="receive">${icon("in")}Receive delivery</button>`,
    ) +
    `<div class="toolbar"><label class="search">${icon("search")}<input id="parts-search" type="search" placeholder="Find a part…" aria-label="Find a part" value="${esc(partSearch)}"></label><div class="filters" role="group" aria-label="Filter parts">${[
      ["all", "All parts"],
      ["order", "Order soon"],
      ["water", "On the way"],
    ]
      .map(
        ([k, v]) =>
          `<button data-part-filter="${k}" aria-pressed="${partFilter === k}">${v}</button>`,
      )
      .join(
        "",
      )}</div></div><section class="panel" id="parts-results" aria-label="Parts and reorder dates">${partsResults()}</section><p class="explanation">“Overdue” means the reorder date has passed, even if parts remain on the shelf. Stock already on the way is shown as a delivery to check.</p>`
  );
}
function trendsPage() {
  const m = tankMix(),
    prev = tankMix(true);
  return (
    heading(
      "Sales, side by side.",
      tank_board_settings.sales_window
        ? esc(tank_board_settings.sales_window)
        : "Latest 30 days compared with the 30 days before, from the daily sync.",
    ) +
    `<div class="trend-grid"><section class="panel trend-card trend-full"><h2>The tank mix</h2>${mix()}<p class="small muted" style="margin-top:16px">${prev ? `Previous 30 days: Lite ${prev.percent}% (${prev.lite}) · Pro ${100 - prev.percent}% (${prev.pro}).` : "Previous tank mix unavailable."} ${m ? `Current: Lite ${m.percent}% (${m.lite}) · Pro ${100 - m.percent}% (${m.pro}).` : ""}</p></section>${tank_board_product
      .map((p) => {
        const max = Math.max(p.monthly_sales, p.prev_sales || 0, 1);
        return `<section class="panel trend-card"><div class="trend-card-head"><h2>${esc(p.short_name)}</h2><span class="pill ${trend(p) !== null && trend(p) < 0 ? "red" : "green"}">${trendText(p)}</span></div><div class="trend-values"><strong class="num">${fmt(p.monthly_sales)}</strong><span>sold · was ${fmt(p.prev_sales)}</span></div><div class="bar-chart" role="img" aria-label="${esc(p.name)}: ${p.monthly_sales} sold in the last 30 days, ${p.prev_sales === null ? "unavailable" : p.prev_sales} in the previous 30 days"><div class="bar-row"><span>Last 30 days</span><div class="bar-track"><i style="width:${(p.monthly_sales / max) * 100}%"></i></div><b>${fmt(p.monthly_sales)}</b></div><div class="bar-row previous"><span>Previous 30 days</span><div class="bar-track"><i style="width:${((p.prev_sales || 0) / max) * 100}%"></i></div><b>${fmt(p.prev_sales)}</b></div></div></section>`;
      })
      .join(
        "",
      )}</div><p class="explanation">Each chart compares two 30-day totals supplied by Shopify. Cover and the parts split use the latest 30 days.</p>`
  );
}
function quantity(id, value, min = 0, step = 1, label = "Quantity") {
  return `<div class="quantity"><button type="button" data-step="${id}" data-amount="-${step}" aria-label="Reduce ${esc(label.toLowerCase())}">−</button><input type="number" id="${id}" min="${min}" step="${step}" inputmode="${step === 1 ? "numeric" : "decimal"}" value="${value === "" ? "" : esc(value)}" aria-label="${esc(label)}" placeholder="—"><button type="button" data-step="${id}" data-amount="${step}" aria-label="Add to ${esc(label.toLowerCase())}">+</button></div>`;
}
function flowShell(title, subtitle, body, foot) {
  return `<section class="panel flow"><div class="flow-head"><h2>${title}</h2><p>${subtitle}</p></div><div class="flow-body">${body}</div>${foot ? `<div class="flow-footer">${foot}</div>` : ""}</section>`;
}
function countChanges() {
  return parts.flatMap((p) => {
    const d = countDraft[p.code];
    return d &&
      validQuantity(d.garage, p.unit, true) &&
      validQuantity(d.shed, p.unit, true)
      ? [
          {
            code: p.code,
            from: p.on_hand,
            to: Number(d.garage) + Number(d.shed),
          },
        ]
      : [];
  });
}
function countFlow() {
  const p = parts[countIndex],
    d = countDraft[p.code] || { garage: "", shed: "" },
    completed = countChanges().length;
  if (countReview) {
    const ch = reviewSnapshot;
    return flowShell(
      "Check your stocktake",
      `${completed} of ${parts.length} parts counted. Skipped parts stay as they are.`,
      `<div class="flow-alert">Garage and shed are added together. A blank box means not counted; enter 0 for an empty location.</div><div class="changes"><h3>On hand · before → after</h3>${ch.map((c) => `<div class="change"><span>${esc(byCode(c.code).name)}</span><b>${fmt(c.from)} → ${fmt(c.to)}</b></div>`).join("") || '<div class="change">No complete counts yet.</div>'}</div>`,
      `<button class="btn" data-count-back>Keep counting</button><button class="btn primary" data-save-count ${ch.length ? "" : "disabled"}>Save ${ch.length} counts</button>`,
    );
  }
  return flowShell(
    "Count what’s actually there",
    "Count both locations, then check the total before saving.",
    `<div class="count-progress"><span>Part ${countIndex + 1} of ${parts.length}</span><span>${completed} counted</span></div><div class="count-track"><i style="width:${(completed / parts.length) * 100}%"></i></div><div class="count-title"><h3>${esc(p.name)}</h3><p>${esc(p.code)} · ${litres(p.unit) ? "Count in litres" : "Count in individual units"} · ${fmt(p.on_hand)} on hand now</p></div>${["garage", "shed"].map((loc) => `<div class="location"><div class="row">${icon("garage")}${loc === "garage" ? "Garage" : "Shed"}</div>${quantity("count-" + loc, d[loc], 0, litres(p.unit) ? 0.1 : 1, `${loc === "garage" ? "Garage" : "Shed"} count`)}</div>`).join("")}<div class="count-total"><span>Total on hand ${litres(p.unit) ? "(L)" : ""}</span><strong id="count-total">${d.garage !== "" && d.shed !== "" ? fmt(Number(d.garage) + Number(d.shed)) : "—"}</strong></div><div id="count-error" class="small down" role="alert"></div><div class="row between"><button class="text-btn" data-count-prev ${countIndex === 0 ? "disabled" : ""}>← Previous</button><button class="text-btn" data-count-skip>Skip for now →</button></div>`,
    `<small>Drafts stay on this device until saved.</small><button class="btn primary" data-count-next>${countIndex === parts.length - 1 ? "Review counts" : "Next part"} ${icon("arrow")}</button><button class="text-btn" data-count-review>Review ${completed} counted</button>`,
  );
}
function outPlan(sku = outSku, quantity = outQty) {
  const p = bySku(sku),
    q = Number(quantity),
    valid = !!p?.parts.length && Number.isInteger(q) && q > 0;
  return {
    p,
    q,
    valid,
    changes: (p?.parts || []).map((i) => ({
      code: i.code,
      delta: -i.qty * (valid ? q : 0),
    })),
    over: valid
      ? p.parts.filter(
          (i) =>
            !byCode(i.code) ||
            byCode(i.code).on_hand === null ||
            byCode(i.code).on_hand + 1e-8 < i.qty * q,
        )
      : [],
  };
}
function outPreview() {
  const plan = outPlan();
  return `<div class="changes"><h3>Parts that will come off the shelf</h3>${plan.changes
    .map((c) => {
      const p = byCode(c.code);
      return `<div class="change"><span>${esc(p?.name || c.code)}</span><b>${fmt(p?.on_hand)} → ${p?.on_hand === null || !p ? "Count first" : fmt(p.on_hand + c.delta)}</b></div>`;
    })
    .join(
      "",
    )}</div>${!plan.valid ? '<div class="flow-alert error">Choose a product with a valid recipe and enter a whole number of at least 1.</div>' : plan.over.length ? `<div class="flow-alert error">Not enough counted stock of ${plan.over.map((i) => esc(byCode(i.code)?.name || i.code)).join(", ")}. Count these parts before taking stock out.</div>` : ""}`;
}
function outFlow() {
  return flowShell(
    "Take stock out",
    "Choose a product. All its parts come off together.",
    `<div class="field"><label for="out-sku">What’s leaving?</label><select id="out-sku">${tank_board_product.map((p) => `<option value="${esc(p.sku)}" ${p.sku === outSku ? "selected" : ""}>${esc(p.name)}</option>`).join("")}</select></div><div class="field"><label for="out-qty">How many?</label>${quantity("out-qty", outQty, 1, 1, "Product quantity")}</div><div class="field"><label>Why?</label><div class="reasons" role="group" aria-label="Reason for stock out">${["gift", "sample", "faulty"].map((k) => `<button type="button" data-why="${k}" aria-pressed="${outWhy === k}">${whyLabels[k]}</button>`).join("")}</div></div><div class="field"><label for="out-who">Who or a short note (optional)</label><input id="out-who" value="${esc(outWho)}" placeholder="e.g. Local detailer"></div><div id="out-preview">${outPreview()}</div><div id="out-error" class="small down" role="alert"></div>`,
    `<small>Saves to Shopify with a History entry.</small><button class="btn primary" id="save-out" data-save-out ${!outPlan().valid || outPlan().over.length ? "disabled" : ""}>${icon("out")}Take ${Number(outQty) || 0} out of stock</button>`,
  );
}
function receivePreview() {
  const p = byCode(receiveCode),
    q = Number(receiveQty);
  return `<div class="changes"><h3>Delivery goes onto the shelf</h3><div class="change"><span>On hand</span><b>${fmt(p.on_hand)} → ${p.on_hand === null ? "Count first" : fmt(p.on_hand + (Number.isFinite(q) && q > 0 ? q : 0))}</b></div><div class="change"><span>On the way</span><b>${fmt(p.on_water)} → ${fmt(Math.max(0, p.on_water - (Number.isFinite(q) && q > 0 ? q : 0)))}</b></div></div>${q > p.on_water ? '<div class="flow-alert warning">This is more than the amount on the way. Check the delivery quantity before saving.</div>' : ""}`;
}
function receiveFlow() {
  const p = byCode(receiveCode);
  return flowShell(
    "Receive a delivery",
    "Add what arrived. The amount on the way comes down too.",
    `<div class="field"><label for="receive-code">Which part arrived?</label><select id="receive-code">${parts.map((p) => `<option value="${esc(p.code)}" ${p.code === receiveCode ? "selected" : ""}>${esc(p.name)}${p.on_water ? " · " + fmt(p.on_water) + " on the way" : ""}</option>`).join("")}</select></div><div class="field"><label for="receive-qty">How many arrived? ${litres(p.unit) ? "(litres)" : ""}</label>${quantity("receive-qty", receiveQty, litres(p.unit) ? 0.1 : 1, litres(p.unit) ? 0.1 : 1, "Delivery quantity")}</div><div class="field"><label for="receive-note">Delivery note (optional)</label><input id="receive-note" value="${esc(receiveNote)}" placeholder="e.g. Handles from the factory"></div><div id="receive-preview">${receivePreview()}</div><div id="receive-error" class="small down" role="alert"></div>`,
    `<small>Saves to Shopify with a History entry.</small><button class="btn primary" data-save-receive ${p.on_hand === null ? "disabled" : ""}>${icon("in")}Add delivery to stock</button>`,
  );
}
function canUndo(m) {
  return TankBoard.canUndo(m, movements, board.pending?.movement.handle);
}
function actionsPage() {
  return (
    heading(
      "A quick job, done.",
      "Count it, take it out, or put it back. Every change gets a record.",
    ) +
    `<div class="action-choices">${[
      ["count", "count", "Count stock", "Garage + shed"],
      ["out", "out", "Take stock out", "Gift, sample or faulty"],
      ["receive", "in", "Receive delivery", "Move it onto the shelf"],
      ["putback", "back", "Put back or undo", "Fix a change, keep a record"],
    ]
      .map(
        ([key, ico, title, desc]) =>
          `<button class="action-choice" type="button" data-action="${key}" aria-pressed="${action === key}">${icon(ico)}<b>${title}</b><small>${desc}</small></button>`,
      )
      .join("")}</div>${
      action === "count"
        ? countFlow()
        : action === "out"
          ? outFlow()
          : action === "receive"
            ? receiveFlow()
            : flowShell(
                "Put back or undo",
                "Choose a change to reverse. A new entry keeps the full story.",
                `<div class="flow-alert">Undoing a count restores its previous number only if stock has not changed since. Undoing a delivery also puts the quantity back on the way. Review the change before confirming.</div>${
                  movements.filter(canUndo).length
                    ? movements
                        .filter(canUndo)
                        .map((m) => historyRow(m, true))
                        .join("")
                    : '<p class="muted">Nothing to put back yet.</p>'
                }`,
                "",
              )
    }`
  );
}
function movementDetails(m) {
  return m.changes
    .map((c) => {
      const p = byCode(c.code);
      return `${esc(p?.name || c.code)} ${c.to !== undefined ? `${fmt(c.from)} → ${fmt(c.to)}` : `${c.delta > 0 ? "+" : ""}${fmt(c.delta)}`}${c.water_delta ? ` · on the way ${c.water_delta > 0 ? "+" : ""}${fmt(c.water_delta)}` : ""}`;
    })
    .join("<br>");
}
function historyRow(m, short = false) {
  const undone = movements.some((x) => x.undoes === m.handle);
  return `<article class="history-row"><div class="history-icon">${icon(m.kind === "receive" ? "in" : m.kind === "count" ? "count" : m.kind === "putback" ? "back" : "out")}</div><div class="body"><h3>${esc(m.summary)} <span class="pill ${m.kind === "faulty" ? "red" : m.kind === "putback" ? "green" : ""}">${esc(undone ? "Undone" : whyLabels[m.kind] || m.kind)}</span></h3><p>${date(m.at)}, ${time(m.at)} · ${esc(m.who || m.recorded_by)}${m.recorded_by !== TankBoard.BY ? " · Read-only" : ""}</p>${!short ? `<details><summary>${m.changes.length} part${m.changes.length === 1 ? "" : "s"} · View recorded changes</summary><div>${movementDetails(m)}</div></details>` : ""}</div>${canUndo(m) ? `<button class="btn" data-undo="${esc(m.handle)}">${m.changes.some((c) => c.delta < 0) ? "Put back" : "Undo"}</button>` : ""}</article>`;
}
function historyResults() {
  const rows = movements.filter(
    (m) =>
      (historyKind === "all" || m.kind === historyKind) &&
      `${m.summary} ${m.who} ${movementDetails(m)}`
        .toLowerCase()
        .includes(historySearch.toLowerCase()),
  );
  return rows.length
    ? `<div class="history-group">${rows.length} change${rows.length === 1 ? "" : "s"} · Latest first</div>${rows.map((m) => historyRow(m)).join("")}`
    : '<div class="empty">No changes match this search.</div>';
}
function historyPage() {
  return (
    heading(
      "The full story, on record.",
      "Stock counts, deliveries and stock out — with a way back.",
    ) +
    `<div class="toolbar"><label class="search">${icon("search")}<input type="search" id="history-search" aria-label="Search history" placeholder="Find an order, part or change…" value="${esc(historySearch)}"></label><div class="history-controls"><select id="history-kind" aria-label="Filter history by type"><option value="all">All changes</option>${Object.entries(
      whyLabels,
    )
      .map(
        ([k, v]) =>
          `<option value="${k}" ${historyKind === k ? "selected" : ""}>${v}</option>`,
      )
      .join(
        "",
      )}</select><span class="small muted">Shopify history</span></div></div><section class="panel" id="history-results" aria-label="Stock change history">${historyResults()}</section><p class="explanation">Daily sync entries are read-only here. This helps avoid putting fulfilled orders back into stock by mistake. Every saved board change appears here with its part changes. Entries written by other tools are read-only too.</p>`
  );
}
function render() {
  nav();
  $(".topbar-right").innerHTML =
    `<span class="date">${esc(today())}</span><span><span class="sync-dot"></span>${busy ? "Working…" : board.loadedAt ? "Shopify · " + time(board.loadedAt) : "Shopify"}</span><button class="btn" data-refresh>Refresh</button>`;
  $("#main").innerHTML =
    phase === "ready"
      ? statusBanners() +
        {
          home,
          parts: partsPage,
          trends: trendsPage,
          actions: actionsPage,
          history: historyPage,
        }[page]() +
        footer()
      : heading("Tank Build Board", "Your workshop, from Shopify.") +
        (phase === "nomcp"
          ? '<div class="flow-alert">Open this board from Apps in your Shopify admin to load the numbers.</div>'
          : phase === "loading"
            ? '<div class="flow-alert" role="status">Loading from Shopify…</div>'
            : `<div class="flow-alert error" role="alert">${esc(error)} <button class="btn" data-refresh>Try again</button></div>`);
  if (busy)
    document
      .querySelectorAll("button, input, select")
      .forEach((el) => (el.disabled = true));
  if (board.pending)
    document
      .querySelectorAll(
        "[data-save-count], [data-save-out], [data-save-receive], [data-confirm-undo]",
      )
      .forEach((el) => (el.disabled = true));
}
function go(next) {
  page = next;
  render();
  window.scrollTo({ top: 0, behavior: "instant" });
  $("#main").focus({ preventScroll: true });
}
function renderFlow() {
  render();
  const flow = $(".flow");
  if (flow) {
    flow.scrollIntoView({ block: "start", behavior: "instant" });
    const title = flow.querySelector(".count-title h3, h2");
    if (title) {
      title.tabIndex = -1;
      title.focus({ preventScroll: true });
    }
  }
}
function toast(message) {
  clearTimeout(toastTimer);
  $("#toast").innerHTML =
    `<div class="toast">${icon("check")}<span>${esc(message)}</span><button type="button" data-dismiss-toast aria-label="Dismiss notification">Close</button></div>`;
  toastTimer = setTimeout(() => ($("#toast").innerHTML = ""), 6000);
}
function litres(unit) {
  return /^(l|litres?|liters?)$/i.test(unit);
}
function validQuantity(value, unit, zero = false) {
  return (
    String(value).trim() !== "" &&
    Number.isFinite(Number(value)) &&
    (zero ? Number(value) >= 0 : Number(value) > 0) &&
    (litres(unit) || Number.isInteger(Number(value)))
  );
}
function checkCount() {
  const p = parts[countIndex],
    d = countDraft[p.code] || { garage: "", shed: "" };
  if (
    !validQuantity(d.garage, p.unit, true) ||
    !validQuantity(d.shed, p.unit, true)
  ) {
    $("#count-error").textContent =
      "Count both locations. Enter 0 if a location is empty.";
    return false;
  }
  return true;
}
async function openUndo(handle) {
  if (busy) return;
  busy = true;
  error = "";
  render();
  try {
    await board.refresh();
    const m = movements.find((m) => m.handle === handle);
    if (!m || !canUndo(m))
      throw new Error(
        "This entry cannot be undone. It may already be reversed or belong to the daily sync.",
      );
    const changes = TankBoard.undoChanges(m, parts);
    undoSnapshot = changes.map((c) => ({
      code: c.code,
      on_hand: byCode(c.code).on_hand,
      on_water: byCode(c.code).on_water,
    }));
    $("#modal-content").innerHTML =
      `<h2 id="modal-title">Reverse this change?</h2><p>${esc(m.summary)}. This adds a new History entry.</p><div class="changes"><h3>On hand · now → after undo</h3>${changes.map((c) => `<div class="change"><span>${esc(byCode(c.code).name)}</span><b>${fmt(byCode(c.code).on_hand)} → ${fmt(Object.hasOwn(c, "to") ? c.to : byCode(c.code).on_hand + c.delta)}</b></div>${c.water_delta ? `<div class="change"><span>On the way</span><b>${fmt(byCode(c.code).on_water)} → ${fmt(byCode(c.code).on_water + c.water_delta)}</b></div>` : ""}`).join("")}</div><div class="row between"><button class="btn" data-close-modal>Cancel</button><button class="btn primary" data-confirm-undo="${esc(handle)}">Confirm undo</button></div>`;
    $("#modal").showModal();
  } catch (e) {
    error = message(e);
  } finally {
    busy = false;
    render();
  }
}
document.addEventListener("click", async (e) => {
  const b = e.target.closest("button");
  if (!b || b.disabled || busy) return;
  if (b.hasAttribute("data-refresh")) {
    await load();
    return;
  }
  if (b.hasAttribute("data-resume")) {
    await save(null, true);
    return;
  }
  if (b.dataset.page) {
    go(b.dataset.page);
    return;
  }
  if (b.dataset.flow) {
    action = b.dataset.flow;
    go("actions");
    return;
  }
  if (b.dataset.partFocus) {
    partSearch = byCode(b.dataset.partFocus).name;
    partFilter = "all";
    go("parts");
    return;
  }
  if (b.dataset.stock) {
    stockView = b.dataset.stock;
    render();
    return;
  }
  if (b.dataset.recipe) {
    const box = document.getElementById(b.getAttribute("aria-controls")),
      open = b.getAttribute("aria-expanded") === "true";
    box.hidden = open;
    b.setAttribute("aria-expanded", String(!open));
    return;
  }
  if (b.dataset.partFilter) {
    partFilter = b.dataset.partFilter;
    render();
    return;
  }
  if (b.dataset.receive) {
    receiveCode = b.dataset.receive;
    receiveQty = byCode(receiveCode).on_water || 1;
    action = "receive";
    go("actions");
    return;
  }
  if (b.dataset.action) {
    action = b.dataset.action;
    renderFlow();
    return;
  }
  if (b.dataset.step) {
    const input = document.getElementById(b.dataset.step),
      step = Number(b.dataset.amount),
      val = Math.max(Number(input.min), Number(input.value || 0) + step);
    input.value = String(Math.round(val * 10) / 10);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    return;
  }
  if (b.hasAttribute("data-count-next")) {
    if (!checkCount()) return;
    if (countIndex === parts.length - 1) {
      countReview = true;
      reviewSnapshot = countChanges();
    } else countIndex++;
    renderFlow();
    return;
  }
  if (b.hasAttribute("data-count-skip")) {
    if (countIndex === parts.length - 1) {
      countReview = true;
      reviewSnapshot = countChanges();
    } else countIndex++;
    renderFlow();
    return;
  }
  if (b.hasAttribute("data-count-prev")) {
    countIndex = Math.max(0, countIndex - 1);
    renderFlow();
    return;
  }
  if (b.hasAttribute("data-count-review")) {
    reviewSnapshot = countChanges();
    countReview = true;
    renderFlow();
    return;
  }
  if (b.hasAttribute("data-count-back")) {
    countReview = false;
    renderFlow();
    return;
  }
  if (b.hasAttribute("data-save-count")) {
    const reviewed = structuredClone(reviewSnapshot);
    await save(() => {
      if (!reviewed.length)
        throw new Error("Review the completed counts before saving.");
      if (
        reviewed.some((c) => !TankBoard.same(byCode(c.code)?.on_hand, c.from))
      ) {
        reviewSnapshot = countChanges();
        throw new Error(
          "Stock changed in Shopify while you were counting. Review the updated before and after totals, then save again. Your draft is kept.",
        );
      }
      return {
        kind: "count",
        summary: `${reviewed.length} parts counted`,
        qty: reviewed.length,
        who: "Garage + shed",
        changes: reviewed,
      };
    });
    return;
  }
  if (b.dataset.why) {
    outWhy = b.dataset.why;
    render();
    return;
  }
  if (b.hasAttribute("data-save-out")) {
    const shown = outPlan();
    if (!shown.valid || shown.over.length) return;
    const selected = {
      sku: outSku,
      qty: shown.q,
      why: outWhy,
      who: outWho.trim(),
      recipe: JSON.stringify(shown.p.parts),
    };
    await save(() => {
      const plan = outPlan(selected.sku, selected.qty);
      if (
        !plan.valid ||
        plan.over.length ||
        JSON.stringify(plan.p.parts) !== selected.recipe
      )
        throw new Error(
          "Stock or the recipe changed in Shopify. Review the parts before saving again.",
        );
      return {
        kind: selected.why,
        summary: `${selected.qty} ${plan.p.short_name} taken out`,
        changes: plan.changes,
        sku: selected.sku,
        qty: selected.qty,
        who: selected.who,
        orders: [],
        value: plan.changes.reduce(
          (s, c) => s - c.delta * byCode(c.code).unit_cost,
          0,
        ),
      };
    });
    return;
  }
  if (b.hasAttribute("data-save-receive")) {
    const shown = byCode(receiveCode),
      code = receiveCode,
      q = Number(receiveQty),
      note = receiveNote.trim();
    await save(() => {
      const p = byCode(code);
      if (!p || !validQuantity(q, p.unit))
        throw new Error(
          "Enter a valid delivery quantity: litres or whole units as labelled.",
        );
      if (p.on_hand === null)
        throw new Error(
          "Count this part before receiving a delivery, so its total is known.",
        );
      if (
        !TankBoard.same(p.on_hand, shown.on_hand) ||
        !TankBoard.same(p.on_water, shown.on_water)
      )
        throw new Error(
          "This part changed in Shopify. Review the updated delivery totals before saving again.",
        );
      return {
        kind: "receive",
        summary: `${fmt(q)} ${p.name} received`,
        qty: q,
        who: note || "Delivery received",
        changes: [{ code, delta: q, water_delta: -Math.min(p.on_water, q) }],
      };
    });
    return;
  }
  if (b.dataset.undo) {
    openUndo(b.dataset.undo);
    return;
  }
  if (b.dataset.confirmUndo) {
    const handle = b.dataset.confirmUndo;
    $("#modal").close();
    await save(() => {
      const m = movements.find((m) => m.handle === handle);
      if (!m || !canUndo(m))
        throw new Error("This entry cannot be undone again.");
      if (
        !undoSnapshot ||
        undoSnapshot.some(
          (c) =>
            !TankBoard.same(byCode(c.code)?.on_hand, c.on_hand) ||
            !TankBoard.same(byCode(c.code)?.on_water, c.on_water),
        )
      )
        throw new Error(
          "Stock changed since the undo review. Open the entry and review it again.",
        );
      return {
        kind: "putback",
        summary: "Undid: " + m.summary,
        changes: TankBoard.undoChanges(m, parts),
        undoes: handle,
        sku: m.sku,
        qty: m.qty,
        value: m.value,
        who: "Reversed in Tank Build Board",
      };
    });
    return;
  }
  if (b.hasAttribute("data-close-modal")) {
    $("#modal").close();
    return;
  }
  if (b.hasAttribute("data-dismiss-toast")) {
    $("#toast").innerHTML = "";
    return;
  }
});
document.addEventListener("input", (e) => {
  const el = e.target;
  if (el.id === "parts-search") {
    partSearch = el.value;
    $("#parts-results").innerHTML = partsResults();
  }
  if (el.id === "history-search") {
    historySearch = el.value;
    $("#history-results").innerHTML = historyResults();
  }
  if (el.id === "count-garage" || el.id === "count-shed") {
    const p = parts[countIndex],
      loc = el.id.slice(6);
    countDraft[p.code] ??= { garage: "", shed: "" };
    countDraft[p.code][loc] = el.value;
    keepDraft();
    const d = countDraft[p.code];
    $("#count-total").textContent =
      d.garage !== "" && d.shed !== ""
        ? fmt(Number(d.garage) + Number(d.shed))
        : "—";
    $("#count-error").textContent = "";
  }
  if (el.id === "out-qty") {
    outQty = el.value;
    $("#out-preview").innerHTML = outPreview();
    const plan = outPlan();
    $("#save-out").disabled = !plan.valid || plan.over.length > 0;
    $("#save-out").innerHTML =
      `${icon("out")}Take ${plan.valid ? plan.q : 0} out of stock`;
  }
  if (el.id === "out-who") outWho = el.value;
  if (el.id === "receive-qty") {
    receiveQty = el.value;
    $("#receive-preview").innerHTML = receivePreview();
  }
  if (el.id === "receive-note") receiveNote = el.value;
});
document.addEventListener("change", (e) => {
  if (e.target.id === "out-sku") {
    outSku = e.target.value;
    render();
  }
  if (e.target.id === "receive-code") {
    receiveCode = e.target.value;
    receiveQty = byCode(receiveCode).on_water || 1;
    render();
  }
  if (e.target.id === "history-kind") {
    historyKind = e.target.value;
    $("#history-results").innerHTML = historyResults();
  }
});
$("#modal").addEventListener("click", (e) => {
  if (e.target === $("#modal")) $("#modal").close();
});
render();
if (window.shopify) load();
else {
  phase = "nomcp";
  render();
}
document.addEventListener("visibilitychange", () => {
  if (
    document.visibilityState === "visible" &&
    window.shopify &&
    !busy &&
    !$("#modal").open &&
    !["INPUT", "SELECT"].includes(document.activeElement?.tagName) &&
    board.loadedAt &&
    Date.now() - board.loadedAt.getTime() > 60000
  )
    load();
});
