/* FinTrace fraud monitoring UI — single-page app over the FinTrace API. */
"use strict";

// ---------------------------------------------------------------- helpers
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtInt = n => Number(n ?? 0).toLocaleString("en-US");
const fmtCompact = n => new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 }).format(n ?? 0);
const fmtAmt = n => Number(n ?? 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pct = (x, d = 2) => (x * 100).toFixed(d) + "%";
const pctSmart = x => x === 0 ? "0%" : x < 0.0001 ? (x * 100).toPrecision(2) + "%" : x < 0.01 ? (x * 100).toFixed(3) + "%" : (x * 100).toFixed(1) + "%";
const stepLabel = s => `Day ${Math.floor(s / 24) + 1} · ${String(s % 24).padStart(2, "0")}:00`;
const css = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

async function api(path, opts = {}) {
  const res = await fetch(path, { headers: { "Content-Type": "application/json" }, ...opts });
  if (!res.ok) {
    let detail = res.statusText;
    try { detail = (await res.json()).detail || detail; } catch (_) { /* not JSON */ }
    throw new Error(typeof detail === "string" ? detail : JSON.stringify(detail));
  }
  return res.json();
}

const ICON = {
  dashboard: '<path d="M3 13h8V3H3zM13 21h8V11h-8zM3 21h8v-6H3zM13 3v6h8V3z"/>',
  explorer: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
  engine: '<path d="M12 2v4M12 18v4M4.9 4.9l2.8 2.8M16.3 16.3l2.8 2.8M2 12h4M18 12h4M4.9 19.1l2.8-2.8M16.3 7.7l2.8-2.8"/><circle cx="12" cy="12" r="3"/>',
  risk: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
  analytics: '<path d="M3 3v18h18"/><path d="M7 15l4-4 3 3 5-6"/>',
  alerts: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.9 1.9 0 0 0 3.4 0"/>',
  model: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  ok: '<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>',
  warn: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>',
  bad: '<path d="M7.9 2h8.2L22 7.9v8.2L16.1 22H7.9L2 16.1V7.9z"/><path d="m15 9-6 6M9 9l6 6"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 16v-4M12 8h.01"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5M12 15V3"/>',
  doc: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M8 13h8M8 17h8"/>',
  print: '<path d="M6 9V2h12v7M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
  auto: '<circle cx="12" cy="12" r="9"/><path d="M12 3v18" /><path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor"/>',
  close: '<path d="M18 6 6 18M6 6l12 12"/>',
};
const icon = (name, cls = "") => `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[name]}</svg>`;

const BAND_ICON = { Low: "ok", Medium: "warn", High: "bad" };
const bandPill = band => `<span class="pill ${esc(band)}">${icon(BAND_ICON[band] || "info")}${esc(band)}</span>`;
const bandOf = s => s >= 50 ? "High" : s >= 25 ? "Medium" : "Low";
const labelPill = isFraud => isFraud ? `<span class="pill fraud">${icon("bad")}Fraud</span>` : `<span class="pill legit">Legit</span>`;
const flagPill = f => f ? `<span class="pill flag">${icon("warn")}Flagged</span>` : `<span class="muted">—</span>`;

const chips = list => `<div class="chips">${list.map(([cls, text]) => `<span class="chip ${cls}">${esc(text)}</span>`).join("")}</div>`;
const CHIP = {
  real: () => ["real", `Real data · PaySim ${fmtCompact(S.stats?.summary.total_transactions)} rows`],
  rule: () => ["rule", "Rule-based FinTrace engine (notebook §5)"],
  ml: () => S.health?.ml_model?.available ? ["rule", "ML model connected"] : ["none", "ML model: not connected"],
  label: () => ["real", "Ground truth: isFraud labels"],
};

function pageHead(title, desc, chipList) {
  return `<div class="page-head"><div><h1>${title}</h1><p>${desc}</p></div>${chips(chipList)}</div>`;
}
function notice(kind, html, ic = kind === "warn" ? "warn" : kind === "bad" ? "bad" : "info") {
  return `<div class="notice ${kind}">${icon(ic)}<div>${html}</div></div>`;
}
const loading = (msg = "Loading…") => `<div class="loading"><span class="spin"></span>${msg}</div>`;
const errorBox = e => notice("bad", `<b>Request failed.</b> ${esc(e.message || e)}`);

// chart card with "Table" toggle so values are never tooltip-only
function chartCard(id, title, sub, table) {
  return `<div class="card"><div class="card-head"><div><h2>${title}</h2><div class="sub">${sub}</div></div>
    <button class="linkbtn no-print" data-toggle-table="${id}">Table</button></div>
    <div class="viz" id="${id}"></div>
    <div class="table-wrap" id="${id}-table" hidden>${simpleTable(table.headers, table.rows)}</div></div>`;
}
function simpleTable(headers, rows) {
  return `<table><thead><tr>${headers.map((h, i) => `<th class="${i ? "num" : ""}">${esc(h)}</th>`).join("")}</tr></thead>
    <tbody>${rows.map(r => `<tr>${r.map((c, i) => `<td class="${i ? "num" : ""}">${esc(c)}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
}
document.addEventListener("click", e => {
  const b = e.target.closest("[data-toggle-table]");
  if (!b) return;
  const id = b.dataset.toggleTable;
  const t = document.getElementById(id + "-table"), v = document.getElementById(id);
  const showTable = t.hidden;
  t.hidden = !showTable; v.hidden = showTable;
  b.textContent = showTable ? "Chart" : "Table";
});

// Re-render charts on resize
let chartRenderers = [];
const drawCharts = () => chartRenderers.forEach(fn => { try { fn(); } catch (err) { console.error(err); } });
window.addEventListener("resize", debounce(drawCharts, 150));
function addChart(fn) { chartRenderers.push(fn); fn(); }

function gauge(score, caption = "risk score") {
  const band = bandOf(score);
  const color = band === "High" ? css("--critical") : band === "Medium" ? css("--warning") : css("--good");
  const R = 60, cx = 75, cy = 80;
  const pt = v => { const a = Math.PI * (1 - v / 100); return [cx + R * Math.cos(a), cy - R * Math.sin(a)]; };
  const arc = (a, b) => { const [x1, y1] = pt(a), [x2, y2] = pt(b); return `M${x1},${y1}A${R},${R} 0 0 1 ${x2},${y2}`; };
  const v = Math.max(0.5, Math.min(100, score));
  return `<svg viewBox="0 0 150 92" role="img" aria-label="${caption} ${score} of 100, ${band}">
    <path d="${arc(0, 100)}" class="g-track" stroke-width="12" fill="none" stroke-linecap="round"/>
    <path d="${arc(0, v)}" stroke="${color}" stroke-width="12" fill="none" stroke-linecap="round"/>
    ${[25, 50].map(t => { const [x, y] = pt(t); const [x2, y2] = [cx + (R + 9) * Math.cos(Math.PI * (1 - t / 100)), cy - (R + 9) * Math.sin(Math.PI * (1 - t / 100))]; return `<line x1="${x}" y1="${y}" x2="${x2}" y2="${y2}" stroke="${css("--baseline")}" stroke-width="1.5"/>`; }).join("")}
    <text x="75" y="76" text-anchor="middle" class="g-num">${score.toFixed(score % 1 ? 1 : 0)}</text>
    <text x="75" y="90" text-anchor="middle" class="g-cap">of 100</text></svg>`;
}

// ---------------------------------------------------------------- state & routing
const S = { stats: null, health: null };
const ROUTES = {
  dashboard: { title: "Fraud Detection Dashboard", nav: "Dashboard", icon: "dashboard", render: renderDashboard },
  explorer: { title: "Transaction Explorer", nav: "Transaction Explorer", icon: "explorer", render: renderExplorer },
  engine: { title: "Fraud Detection Engine", nav: "Detection Engine", icon: "engine", render: renderEngine },
  risk: { title: "Fraud Risk Analysis", nav: "Risk Analysis", icon: "risk", render: renderRisk },
  analytics: { title: "Fraud Analytics", nav: "Fraud Analytics", icon: "analytics", render: renderAnalytics },
  alerts: { title: "Alerts & Reports", nav: "Alerts & Reports", icon: "alerts", render: renderAlerts },
  model: { title: "Model Performance", nav: "Model Performance", icon: "model", render: renderModel },
  report: { title: "Summary Report", hidden: true, render: renderSummaryReport },
};

function parseHash() {
  const h = location.hash.replace(/^#\/?/, "");
  const [path, qs] = h.split("?");
  return { route: ROUTES[path] ? path : "dashboard", params: new URLSearchParams(qs || "") };
}
function go(route, params = {}) {
  const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== "" && v != null)).toString();
  location.hash = `#/${route}${qs ? "?" + qs : ""}`;
}

async function router() {
  const { route, params } = parseHash();
  chartRenderers = [];
  Charts.hideTip();
  closeDrawer();
  $$(".nav a").forEach(a => a.classList.toggle("active", a.dataset.route === route));
  $("#page-title").textContent = ROUTES[route].title;
  const view = $("#view");
  if (!S.stats && route !== "report") {
    view.innerHTML = S.bootError ? errorBox(S.bootError) + setupHelp() : loading("Connecting to the FinTrace API…");
    return;
  }
  try {
    await ROUTES[route].render(view, params);
  } catch (e) {
    console.error(e);
    view.innerHTML = errorBox(e);
  }
  window.scrollTo(0, 0);
}

function setupHelp() {
  return `<div class="card mt"><h2>Setup</h2><p>The UI needs the FinTrace API and the data store built from the PaySim CSV:</p>
  <pre class="mono small">python scripts/build_data.py path\\to\\PS_20174392719_1491204439457_log.csv
python -m uvicorn backend.app:app --port 8000</pre></div>`;
}

// ---------------------------------------------------------------- 1. Dashboard
async function renderDashboard(view) {
  const st = S.stats, sm = st.summary;
  const bands = Object.fromEntries(st.risk_distribution.bands.map(b => [b.band, b]));
  view.innerHTML = `
    ${pageHead("Fraud Detection Dashboard", "Overview of the full PaySim transaction log with the FinTrace rule engine's alerts.", [CHIP.real(), CHIP.rule(), CHIP.ml()])}
    <div class="tiles">
      <div class="tile hero"><div class="label">Total transactions <span class="src">Dataset</span></div>
        <div class="value">${fmtCompact(sm.total_transactions)}</div><div class="foot">${fmtInt(sm.total_transactions)} rows · ${sm.last_step} hourly steps</div></div>
      <div class="tile"><div class="label">Labeled fraud <span class="src">Label</span></div>
        <div class="value">${fmtInt(sm.labeled_fraud)}</div><div class="foot">isFraud = 1 in the dataset</div></div>
      <div class="tile"><div class="label">Fraud rate <span class="src">Label</span></div>
        <div class="value">${pct(sm.fraud_rate, 3)}</div><div class="foot">of all transactions</div></div>
      <div class="tile"><div class="label">Suspicious transactions <span class="src">Rules</span></div>
        <div class="value">${fmtInt(sm.suspicious)}</div><div class="foot">${fmtInt(sm.fintrace_high_risk)} FinTrace High risk + ${fmtInt(sm.paysim_flagged)} PaySim-flagged</div></div>
      <div class="tile"><div class="label">Fraud amount <span class="src">Label</span></div>
        <div class="value">${fmtCompact(sm.labeled_fraud_amount)}</div><div class="foot">labeled fraud total · suspicious: ${fmtCompact(sm.suspicious_amount)}</div></div>
    </div>
    ${notice("info", `<b>How to read these numbers.</b> <i>Labeled fraud</i> is the PaySim simulator's ground truth, not a detection.
      <i>Suspicious</i> means the project's rule-based engine scored the transaction 50 or higher (High risk), or PaySim's own <code>isFlaggedFraud</code> rule fired.
      No machine-learning model is connected, so nothing on this page is an ML prediction. Amounts are in the dataset's (unspecified) currency units.`)}
    <div class="grid g2 mt">
      ${chartCard("d-type", "Labeled fraud by transaction type", "Count of isFraud = 1 transactions per type",
        { headers: ["Type", "Fraud", "Transactions", "Fraud rate"], rows: st.by_type.map(t => [t.type, fmtInt(t.fraud), fmtInt(t.n), pctSmart(t.fraud_rate)]) })}
      ${chartCard("d-day", "Labeled fraud per day", "Fraud transactions per simulated day (step ÷ 24)",
        { headers: ["Day", "Fraud", "Transactions"], rows: st.by_day.map(d => [d.day, fmtInt(d.fraud), fmtInt(d.n)]) })}
    </div>
    <div class="grid g-2-1 mt">
      <div class="card"><div class="card-head"><div><h2>Highest-risk alerts</h2><div class="sub">Top suspicious transactions by FinTrace score</div></div>
        <a class="btn" href="#/alerts">View all alerts</a></div><div id="d-alerts">${loading()}</div></div>
      <div class="card"><h2>Risk band mix</h2><div class="sub">All transactions by FinTrace behavioral risk band</div>
        ${["High", "Medium", "Low"].map(b => {
          const x = bands[b] || { n: 0, fraud: 0 };
          return `<div class="signal"><div class="top"><span>${bandPill(b)}</span><span class="score">${fmtInt(x.n)}</span></div>
            <div class="meter"><i style="width:${Math.max(0.5, x.n / sm.total_transactions * 100)}%;background:${css(b === "High" ? "--critical" : b === "Medium" ? "--warning" : "--good")}"></i></div>
            <div class="detail">${pct(x.n / sm.total_transactions, 2)} of transactions · ${fmtInt(x.fraud)} labeled fraud inside (${pctSmart(x.n ? x.fraud / x.n : 0)})</div></div>`;
        }).join("")}
        <div class="small muted mt">Bands: Low &lt; 25 ≤ Medium &lt; 50 ≤ High.</div></div>
    </div>`;

  const typeSorted = [...st.by_type].sort((a, b) => b.fraud - a.fraud);
  addChart(() => Charts.bars($("#d-type"), {
    horizontal: true, categories: typeSorted.map(t => t.type),
    series: [{ name: "Labeled fraud", color: css("--critical"), values: typeSorted.map(t => t.fraud) }],
    fmt: fmtInt, axisFmt: fmtCompact,
    tipExtra: i => `<div>Fraud rate: <b>${pctSmart(typeSorted[i].fraud_rate)}</b> of ${fmtInt(typeSorted[i].n)}</div>`,
  }));
  addChart(() => Charts.line($("#d-day"), {
    x: st.by_day.map(d => d.day), xFmt: d => `Day ${d}`,
    series: [{ name: "Labeled fraud", color: css("--critical"), values: st.by_day.map(d => d.fraud) }],
    fmt: fmtInt, area: true, tipExtra: i => `<div>All transactions: <b>${fmtInt(st.by_day[i].n)}</b></div>`,
  }));

  try {
    const res = await api("/api/transactions?suspicious=true&sort=risk&order=desc&page_size=8");
    $("#d-alerts").innerHTML = txTable(res.rows, { compact: true });
    bindTxRows($("#d-alerts"), res.rows);
  } catch (e) { $("#d-alerts").innerHTML = errorBox(e); }
}

// ---------------------------------------------------------------- transaction table + drawer
function txTable(rows, { compact = false, sortable = false, sort, order } = {}) {
  if (!rows.length) return `<div class="empty">No transactions match these filters.</div>`;
  const th = (key, label, cls = "") => {
    if (!sortable || !key) return `<th class="${cls}">${label}</th>`;
    const arrow = sort === key ? (order === "desc" ? " ↓" : " ↑") : "";
    return `<th class="sortable ${cls}" data-sort="${key}">${label}${arrow}</th>`;
  };
  return `<div class="table-wrap"><table><thead><tr>
    ${th("row_id", "Txn ID")}${compact ? "" : th("step", "Time")}${th("type", "Type")}${th("amount", "Amount", "num")}
    <th>Sender</th><th>Receiver</th>${th("risk", "Risk", "num")}<th>Band</th><th>Label</th>${compact ? "" : "<th>PaySim flag</th>"}
  </tr></thead><tbody>
  ${rows.map((r, i) => `<tr class="clickable${r.band === "High" || r.isFlaggedFraud ? " flagged" : ""}" data-i="${i}" tabindex="0">
    <td class="mono">${esc(r.txn_id)}</td>${compact ? "" : `<td>${stepLabel(r.step)}</td>`}<td>${esc(r.type)}</td>
    <td class="num">${fmtAmt(r.amount)}</td><td class="mono">${esc(r.nameOrig)}</td><td class="mono">${esc(r.nameDest)}</td>
    <td class="num score">${r.risk.toFixed(1)}</td><td>${bandPill(r.band)}</td><td>${labelPill(r.isFraud)}</td>${compact ? "" : `<td>${flagPill(r.isFlaggedFraud)}</td>`}
  </tr>`).join("")}</tbody></table></div>`;
}
function bindTxRows(root, rows) {
  $$("tr[data-i]", root).forEach(tr => {
    const open = () => openTxDrawer(rows[+tr.dataset.i]);
    tr.addEventListener("click", open);
    tr.addEventListener("keydown", e => { if (e.key === "Enter") open(); });
  });
}
function openTxDrawer(r) {
  $("#drawer").innerHTML = `
    <div class="flex"><h2 style="margin:0">${esc(r.txn_id)}</h2><span class="spacer"></span>
      <button class="btn theme-toggle" id="drawer-close" aria-label="Close">${icon("close")}</button></div>
    <div class="flex mt">${bandPill(r.band)} ${labelPill(r.isFraud)} ${r.isFlaggedFraud ? flagPill(1) : ""}</div>
    <dl class="kv mt">
      <dt>Time</dt><dd>${stepLabel(r.step)} (step ${r.step})</dd>
      <dt>Type</dt><dd>${esc(r.type)}</dd>
      <dt>Amount</dt><dd><b>${fmtAmt(r.amount)}</b></dd>
      <dt>Sender</dt><dd class="mono">${esc(r.nameOrig)}</dd>
      <dt>Sender balance</dt><dd>${fmtAmt(r.oldbalanceOrg)} → ${fmtAmt(r.newbalanceOrig)}</dd>
      <dt>Receiver</dt><dd class="mono">${esc(r.nameDest)}</dd>
      <dt>Receiver balance</dt><dd>${fmtAmt(r.oldbalanceDest)} → ${fmtAmt(r.newbalanceDest)}</dd>
      <dt>FinTrace risk</dt><dd><b>${r.risk.toFixed(1)}</b> = max(sender ${r.risk_orig.toFixed(1)}, receiver ${r.risk_dest.toFixed(1)})</dd>
      <dt>Ground truth</dt><dd>isFraud = ${r.isFraud}, isFlaggedFraud = ${r.isFlaggedFraud}</dd>
    </dl>
    <hr class="sep">
    <div class="flex">
      <a class="btn primary" href="#/engine?txn=${r.row_id}">${icon("engine")}Run detection engine</a>
      <a class="btn" href="#/risk?account=${encodeURIComponent(r.nameOrig)}">Analyze sender</a>
      <a class="btn" href="#/risk?account=${encodeURIComponent(r.nameDest)}">Analyze receiver</a>
    </div>
    <p class="small muted mt">Risk is the FinTrace behavioral score (notebook rules without the fraud-label signal), taken over each party's full history in the dataset.</p>`;
  $("#drawer").classList.add("open"); $("#drawer-bg").classList.add("open");
  $("#drawer-close").addEventListener("click", closeDrawer);
}
function closeDrawer() { $("#drawer")?.classList.remove("open"); $("#drawer-bg")?.classList.remove("open"); }

function pager(total, page, pageSize, onPage) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const div = document.createElement("div");
  div.className = "pager";
  const from = total ? (page - 1) * pageSize + 1 : 0, to = Math.min(total, page * pageSize);
  div.innerHTML = `<span>${fmtInt(from)}–${fmtInt(to)} of <b>${fmtInt(total)}</b> transactions</span>
    <span class="flex"><button class="btn" data-p="prev" ${page <= 1 ? "disabled" : ""}>Previous</button>
    <span>Page ${fmtInt(page)} / ${fmtInt(pages)}</span>
    <button class="btn" data-p="next" ${page >= pages ? "disabled" : ""}>Next</button></span>`;
  div.querySelector('[data-p="prev"]').onclick = () => onPage(page - 1);
  div.querySelector('[data-p="next"]').onclick = () => onPage(page + 1);
  return div;
}

// ---------------------------------------------------------------- 2. Explorer
const TYPES = ["CASH_OUT", "PAYMENT", "CASH_IN", "TRANSFER", "DEBIT"];
const FILTER_KEYS = ["q", "type", "fraud", "flagged", "band", "min_amount", "max_amount", "min_day", "max_day", "sort", "order", "page"];

function filtersToApi(p) {
  const a = new URLSearchParams();
  const q = (p.get("q") || "").trim();
  if (q) { if (/^(txn)?\d+$/i.test(q)) a.set("txn", q); else a.set("account", q); }
  for (const k of ["type", "fraud", "flagged", "band", "min_amount", "max_amount", "sort", "order"]) if (p.get(k)) a.set(k, p.get(k));
  if (p.get("min_day")) a.set("min_step", (+p.get("min_day") - 1) * 24);
  if (p.get("max_day")) a.set("max_step", +p.get("max_day") * 24 - 1);
  if (p.get("suspicious")) a.set("suspicious", "true");
  return a;
}

async function renderExplorer(view, params) {
  const p = params, sel = (k, v) => p.get(k) === v ? "selected" : "";
  const sort = p.get("sort") || "row_id", order = p.get("order") || "asc", page = +(p.get("page") || 1);
  view.innerHTML = `
    ${pageHead("Transaction Explorer", "Search and filter all 6.36 million transactions. Click a row to inspect it.", [CHIP.real(), CHIP.rule()])}
    <form class="card filters" id="ex-form">
      <div class="field" style="flex:1 1 220px"><label for="f-q">Search Txn ID or account</label>
        <input type="text" id="f-q" name="q" placeholder="e.g. TXN00000002 or C1231006815" value="${esc(p.get("q") || "")}"></div>
      <div class="field"><label for="f-type">Type</label><select id="f-type" name="type"><option value="">All types</option>
        ${TYPES.map(t => `<option ${sel("type", t)}>${t}</option>`).join("")}</select></div>
      <div class="field"><label for="f-fraud">Fraud label</label><select id="f-fraud" name="fraud">
        <option value="">All</option><option value="1" ${sel("fraud", "1")}>Fraud</option><option value="0" ${sel("fraud", "0")}>Legit</option></select></div>
      <div class="field"><label for="f-band">Risk band</label><select id="f-band" name="band"><option value="">All</option>
        ${["High", "Medium", "Low"].map(b => `<option ${sel("band", b)}>${b}</option>`).join("")}</select></div>
      <div class="field"><label for="f-flag">PaySim flag</label><select id="f-flag" name="flagged">
        <option value="">All</option><option value="1" ${sel("flagged", "1")}>Flagged</option><option value="0" ${sel("flagged", "0")}>Not flagged</option></select></div>
      <div class="field" style="width:120px"><label for="f-mina">Min amount</label><input type="number" min="0" id="f-mina" name="min_amount" value="${esc(p.get("min_amount") || "")}"></div>
      <div class="field" style="width:120px"><label for="f-maxa">Max amount</label><input type="number" min="0" id="f-maxa" name="max_amount" value="${esc(p.get("max_amount") || "")}"></div>
      <div class="field" style="width:86px"><label for="f-mind">From day</label><input type="number" min="1" max="31" id="f-mind" name="min_day" value="${esc(p.get("min_day") || "")}"></div>
      <div class="field" style="width:86px"><label for="f-maxd">To day</label><input type="number" min="1" max="31" id="f-maxd" name="max_day" value="${esc(p.get("max_day") || "")}"></div>
      <button class="btn primary" type="submit">Apply</button>
      <button class="btn" type="button" id="ex-reset">Reset</button>
      <span class="spacer"></span>
      <a class="btn gold" id="ex-export">${icon("download")}Export CSV</a>
    </form>
    <div id="ex-results">${loading("Querying 6.36M transactions…")}</div>`;

  const form = $("#ex-form");
  form.addEventListener("submit", e => {
    e.preventDefault();
    const o = Object.fromEntries(new FormData(form));
    go("explorer", { ...o, sort, order });
  });
  $("#ex-reset").onclick = () => go("explorer");
  const apiParams = filtersToApi(p);
  $("#ex-export").href = `/api/transactions/export?${apiParams}&filename=fintrace_explorer_export.csv`;
  $("#ex-export").title = "Downloads up to 50,000 matching rows";

  apiParams.set("page", page); apiParams.set("page_size", 25);
  const res = await api(`/api/transactions?${apiParams}`);
  const box = $("#ex-results");
  box.innerHTML = txTable(res.rows, { sortable: true, sort, order });
  bindTxRows(box, res.rows);
  const cur = Object.fromEntries(FILTER_KEYS.filter(k => p.get(k)).map(k => [k, p.get(k)]));
  $$("th[data-sort]", box).forEach(th => th.addEventListener("click", () => {
    const k = th.dataset.sort;
    go("explorer", { ...cur, sort: k, order: sort === k && order === "desc" ? "asc" : "desc", page: 1 });
  }));
  box.appendChild(pager(res.total, page, 25, np => go("explorer", { ...cur, page: np })));
}

// ---------------------------------------------------------------- 3. Detection engine
async function renderEngine(view, params) {
  const mode = params.get("mode") === "custom" ? "custom" : "existing";
  view.innerHTML = `
    ${pageHead("Fraud Detection Engine", "Classify a transaction as legitimate or potentially fraudulent with the project's FinTrace rules.", [CHIP.rule(), CHIP.ml(), CHIP.real()])}
    ${notice("info", `<b>What runs here:</b> the notebook's <code>score_account()</code> (section 5), executed live by the API on the sender's and receiver's full history.
      The transaction's risk is the higher of the two account scores, and a score of 50 or more is classified <i>potentially fraudulent</i>.
      The fraud-label signal is switched off here, because a classifier must not read the answer it is being tested against.
      ${S.health?.ml_model?.available ? "An ML model is connected; its probability is shown alongside." : "<b>No ML model is connected</b>, so every verdict below is rule-based."}`)}
    <div class="card mt">
      <div class="seg" role="tablist">
        <button class="${mode === "existing" ? "on" : ""}" data-mode="existing">Existing transaction</button>
        <button class="${mode === "custom" ? "on" : ""}" data-mode="custom">Hypothetical transaction</button>
      </div>
      <div id="eng-form" class="mt"></div>
    </div>
    <div id="eng-result" class="mt"></div>`;
  $$("[data-mode]").forEach(b => b.onclick = () => go("engine", { mode: b.dataset.mode }));

  const formBox = $("#eng-form");
  if (mode === "existing") {
    formBox.innerHTML = `<form class="filters" id="eng-ex" style="margin:0">
      <div class="field" style="flex:1 1 240px"><label for="e-txn">Transaction ID</label>
        <input type="text" id="e-txn" placeholder="TXN00000002 or 2" value="${esc(params.get("txn") ? "TXN" + String(params.get("txn")).padStart(8, "0") : "")}"></div>
      <button class="btn primary" type="submit">${icon("engine")}Classify</button>
      <span class="small muted">or pick a sample:</span>
      <button class="btn" type="button" data-rand="fraud=1">Random labeled fraud</button>
      <button class="btn" type="button" data-rand="fraud=0">Random legit</button>
      <button class="btn" type="button" data-rand="band=High">Random High-risk</button>
    </form>`;
    $("#eng-ex").addEventListener("submit", e => {
      e.preventDefault();
      const d = ($("#e-txn").value.match(/\d+/) || [""])[0];
      if (d) go("engine", { txn: +d });
    });
    $$("[data-rand]").forEach(b => b.onclick = async () => {
      b.disabled = true;
      try { const r = await api(`/api/transactions/random?${b.dataset.rand}`); go("engine", { txn: r.row_id }); }
      catch (e) { $("#eng-result").innerHTML = errorBox(e); b.disabled = false; }
    });
    if (params.get("txn")) await runEngine({ row_id: +params.get("txn") });
  } else {
    const f = [
      ["type", "Type", "select"], ["step", "Step (hour, 1–743)", 400], ["amount", "Amount", 250000],
      ["nameOrig", "Sender account", "C1231006815"], ["oldbalanceOrg", "Sender balance before", 250000], ["newbalanceOrig", "Sender balance after", 0],
      ["nameDest", "Receiver account", "C_NEW_RECEIVER"], ["oldbalanceDest", "Receiver balance before", 0], ["newbalanceDest", "Receiver balance after", 0],
    ];
    formBox.innerHTML = `<form id="eng-cu"><div class="grid g3">
      ${f.map(([k, l, d]) => `<div class="field"><label for="c-${k}">${l}</label>${d === "select"
        ? `<select id="c-${k}" name="${k}">${TYPES.map(t => `<option ${t === "TRANSFER" ? "selected" : ""}>${t}</option>`).join("")}</select>`
        : `<input id="c-${k}" name="${k}" type="${typeof d === "number" ? "number" : "text"}" step="any" value="${d}" required>`}</div>`).join("")}
      </div><div class="flex mt"><button class="btn primary" type="submit">${icon("engine")}Classify hypothetical transaction</button>
      <span class="small muted">The transaction is added to each party's real history (if the account exists in the dataset) and both accounts are re-scored. Nothing is saved.</span></div></form>`;
    $("#eng-cu").addEventListener("submit", e => {
      e.preventDefault();
      const o = Object.fromEntries(new FormData(e.target));
      for (const k of ["step", "amount", "oldbalanceOrg", "newbalanceOrig", "oldbalanceDest", "newbalanceDest"]) o[k] = +o[k];
      runEngine({ transaction: o });
    });
  }
}

async function runEngine(body) {
  const box = $("#eng-result");
  box.innerHTML = loading("Scoring sender and receiver with the notebook rules…");
  let r;
  try { r = await api("/api/engine/score", { method: "POST", body: JSON.stringify(body) }); }
  catch (e) { box.innerHTML = errorBox(e); return; }
  const rb = r.rule_based, tx = r.transaction, bad = rb.score >= rb.threshold;
  let truth = "";
  if (r.ground_truth) {
    const lab = r.ground_truth.isFraud === 1;
    const outcome = bad && lab ? ["ok", "True positive: the engine flagged a transaction that is labeled fraud."]
      : !bad && !lab ? ["ok", "True negative: the engine passed a transaction that is labeled legitimate."]
      : bad && !lab ? ["warn", "False positive: the engine flagged a transaction that is labeled legitimate."]
      : ["bad", "False negative: the engine missed a transaction that is labeled fraud."];
    truth = notice(outcome[0] === "ok" ? "info" : outcome[0], `<b>Compared with the dataset label</b> (isFraud = ${r.ground_truth.isFraud}${r.ground_truth.isFlaggedFraud ? ", PaySim-flagged" : ""}): ${outcome[1]}`, outcome[0]);
  }
  const party = (title, p) => `<div class="card"><div class="card-head"><div><h2>${title}</h2>
      <div class="sub mono">${esc(title === "Sender" ? tx.nameOrig : tx.nameDest)}</div></div>${bandPill(p.band)}</div>
    <div class="gauge">${gauge(p.score, title + " score")}<div class="small muted">${fmtInt(p.history_transactions)} transaction(s) on record${r.hypothetical ? " plus the hypothetical one" : ""}.<br>${esc(p.summary)}</div></div>
    ${p.signals.length ? p.signals.map(sg => `<div class="signal"><div class="top"><span>${esc(sg.feature.replace(/_/g, " "))}</span><span class="score">+${sg.weight.toFixed(1)}</span></div>
      <div class="meter"><i style="width:${Math.min(100, sg.weight / 40 * 100)}%"></i></div><div class="detail">${esc(sg.detail)}</div></div>`).join("")
      : `<div class="small muted">No anomaly signals fired.</div>`}
    <div class="flex mt"><a class="btn" href="#/risk?account=${encodeURIComponent(title === "Sender" ? tx.nameOrig : tx.nameDest)}">Full risk analysis</a></div></div>`;
  box.innerHTML = `
    <div class="verdict ${bad ? "bad" : "ok"}">${icon(bad ? "bad" : "ok", "icon")}
      <div><div class="small muted">${r.hypothetical ? "Hypothetical transaction" : esc(tx.txn_id)} · ${esc(tx.type)} · ${fmtAmt(tx.amount)} · ${stepLabel(tx.step)}</div>
      <h3>${esc(rb.verdict)}</h3>
      <div class="small">Rule-based risk score <b>${rb.score.toFixed(1)}</b> / 100 · ${bandPill(rb.band)} · threshold ${rb.threshold}</div></div>
      <span class="spacer"></span><div class="gauge">${gauge(rb.score, "transaction risk")}</div></div>
    <div class="mt">${truth}</div>
    <div class="grid g3 mt">
      ${party("Sender", rb.sender)}
      ${party("Receiver", rb.receiver)}
      <div class="card"><h2>Machine-learning model</h2><div class="sub">API slot: <code>models/model.joblib</code></div>
        ${r.ml_model.available
          ? `<div class="gauge">${gauge(r.ml_model.probability * 100, "ML probability")}<div>Fraud probability <b>${pct(r.ml_model.probability, 1)}</b><br><span class="small muted">from your connected model</span></div></div>`
          : notice("", `<b>Not connected.</b> The project notebook doesn't include a trained classifier, so no ML prediction is shown or simulated.
             Once you train and export one, the API loads it automatically and this panel shows its probability next to the rule-based score.`)}
        ${r.ml_model.status.error ? notice("bad", esc(r.ml_model.status.error)) : ""}
        <div class="small muted mt">Expected input features: <code>${r.ml_model.status.features.join(", ")}</code></div></div>
    </div>`;
}

// ---------------------------------------------------------------- 4. Risk analysis
async function renderRisk(view, params) {
  const acct = (params.get("account") || "").trim();
  const st = S.stats, rd = st.risk_distribution;
  view.innerHTML = `
    ${pageHead("Fraud Risk Analysis", "0–100 risk scores for accounts and transactions, from the notebook's explainable anomaly rules.", [CHIP.rule(), CHIP.real()])}
    <form class="card filters" id="rk-form">
      <div class="field" style="flex:1 1 260px"><label for="rk-acct">Account ID</label>
        <input type="text" id="rk-acct" placeholder="e.g. C1286084959 or M1979787155" value="${esc(acct)}"></div>
      <button class="btn primary" type="submit">Analyze account</button>
      <span class="small muted">Bands: ${bandPill("Low")} 0–24 · ${bandPill("Medium")} 25–49 · ${bandPill("High")} 50–100</span>
    </form>
    <div id="rk-account"></div>
    <div class="grid g2 mt">
      ${chartCard("rk-dist", "Transaction risk distribution", "Transactions per 5-point score bin, all vs labeled fraud (log scale)",
        { headers: ["Score bin", "Transactions", "Labeled fraud"], rows: rd.transactions.map(b => [`${b.bin}–${b.bin + 4.9}`, fmtInt(b.n), fmtInt(b.fraud)]) })}
      <div class="card"><h2>Highest-scoring accounts</h2><div class="sub">Behavioral score (no label signal). Click to analyze.</div>
        <div class="table-wrap" style="max-height:330px;overflow:auto"><table><thead><tr><th>Account</th><th class="num">Txns</th><th class="num">Score</th><th>Band</th><th class="num">Labeled fraud</th></tr></thead>
        <tbody>${st.top_accounts.slice(0, 25).map(a => `<tr class="clickable" data-acct="${esc(a.account_id)}"><td class="mono">${esc(a.account_id)}</td>
          <td class="num">${fmtInt(a.n)}</td><td class="num score">${a.behavioral_score.toFixed(1)}</td><td>${bandPill(bandOf(a.behavioral_score))}</td><td class="num">${fmtInt(a.fraud_n)}</td></tr>`).join("")}</tbody></table></div></div>
    </div>
    <div class="card mt"><h2>How the score is built</h2><div class="sub">FinTrace notebook, section 5 (explainability). Each signal adds weight; the total is capped at 100.</div>
      <div class="table-wrap"><table><thead><tr><th>Signal</th><th>What it measures</th><th class="num">Max weight</th><th>Used for classification</th></tr></thead><tbody>
        <tr><td>amount_zscore</td><td class="wrap">Share of the account's transactions more than 2.5σ from its own mean amount</td><td class="num">40</td><td>Yes</td></tr>
        <tr><td>iqr_outliers</td><td class="wrap">Share of amounts outside 1.5×IQR of the account's own amounts (accounts with 4+ transactions)</td><td class="num">25</td><td>Yes</td></tr>
        <tr><td>counterparty_novelty</td><td class="wrap">Share of the last 5 transactions with never-before-seen counterparties (if ≥ 40%)</td><td class="num">20</td><td>Yes</td></tr>
        <tr><td>labeled_fraud</td><td class="wrap">Number of transactions on the account already labeled fraud (15 each)</td><td class="num">35</td><td>No: shown only as the "investigative" score</td></tr>
      </tbody></table></div>
      <p class="small muted">The notebook names four bands (Low &lt; 25, Medium &lt; 50, High &lt; 75, Critical ≥ 75). This site uses three, folding Critical into High. A transaction's score is the higher of its sender's and receiver's account scores.</p></div>`;

  $("#rk-form").addEventListener("submit", e => { e.preventDefault(); go("risk", { account: $("#rk-acct").value.trim() }); });
  $$("tr[data-acct]").forEach(tr => tr.onclick = () => go("risk", { account: tr.dataset.acct }));
  addChart(() => Charts.bars($("#rk-dist"), {
    categories: rd.transactions.map(b => `${b.bin}`), log: true, labelMode: "none",
    series: [{ name: "All transactions", color: css("--series-1"), values: rd.transactions.map(b => b.n) },
             { name: "Labeled fraud", color: css("--critical"), values: rd.transactions.map(b => b.fraud) }],
    fmt: fmtInt, axisFmt: fmtCompact,
  }));

  if (!acct) return;
  const box = $("#rk-account");
  box.innerHTML = `<div class="card mt">${loading("Running score_account, timeline and neighbourhood for " + esc(acct) + "…")}</div>`;
  let a;
  try { a = await api(`/api/accounts/${encodeURIComponent(acct)}`); }
  catch (e) { box.innerHTML = `<div class="mt">${errorBox(e)}</div>`; return; }
  const sig = list => list.length ? list.map(sg => `<div class="signal"><div class="top"><span>${esc(sg.feature.replace(/_/g, " "))}</span><span class="score">+${sg.weight.toFixed(1)}</span></div>
      <div class="meter"><i style="width:${Math.min(100, sg.weight / 40 * 100)}%"></i></div><div class="detail">${esc(sg.detail)}</div></div>`).join("")
    : `<div class="small muted">No anomaly signals fired for this account.</div>`;
  const flaggedN = a.timeline.filter(t => t.flagged).length;
  box.innerHTML = `
    <div class="grid g-1-2 mt">
      <div class="card"><div class="card-head"><div><h2 class="mono">${esc(a.account_id)}</h2><div class="sub">${a.kind} account · ${fmtInt(a.transactions)} transactions</div></div>${bandPill(a.behavioral.band)}</div>
        <div class="gauge">${gauge(a.behavioral.score, "behavioral risk")}<div><b>Behavioral risk</b><div class="small muted">used for classification</div>
          <div class="mt small">Investigative score: <b>${a.investigative.score.toFixed(1)}</b> ${bandPill(a.investigative.band)}<br><span class="muted">notebook default, includes fraud labels</span></div></div></div>
        <dl class="kv mt">
          <dt>Sent</dt><dd>${fmtInt(a.sent_count)} txns · ${fmtAmt(a.total_sent)}</dd>
          <dt>Received</dt><dd>${fmtInt(a.received_count)} txns · ${fmtAmt(a.total_received)}</dd>
          <dt>Counterparties</dt><dd>${fmtInt(a.counterparties)}</dd>
          <dt>Labeled fraud</dt><dd>${fmtInt(a.fraud_labeled)} transaction(s)</dd>
        </dl>
        <div class="flex mt">
          <a class="btn primary" href="/api/accounts/${encodeURIComponent(a.account_id)}/report" target="_blank" rel="noopener">${icon("doc")}Open case report</a>
          <a class="btn" href="/api/accounts/${encodeURIComponent(a.account_id)}/report?download=true">${icon("download")}Download</a>
          <a class="btn" href="#/explorer?q=${encodeURIComponent(a.account_id)}">View transactions</a>
        </div></div>
      <div class="card"><h2>Why this score</h2><div class="sub">${esc(a.behavioral.summary)}</div>${sig(a.behavioral.signals)}
        ${a.investigative.signals.some(s => s.feature === "labeled_fraud") ? `<hr class="sep"><div class="small muted">Investigative-only signal:</div>${sig(a.investigative.signals.filter(s => s.feature === "labeled_fraud"))}` : ""}</div>
    </div>
    <div class="card mt"><h2>Activity timeline</h2><div class="sub">Notebook section 4: z-scores against this account's own history. ${flaggedN} moment(s) of interest are highlighted.</div>
      <div class="table-wrap" style="max-height:420px;overflow:auto"><table><thead><tr><th>Txn</th><th>Time</th><th>Type</th><th>Direction</th><th>Counterparty</th><th class="num">Amount</th><th class="num">Balance after</th><th class="num">Z-score</th><th>Label</th><th>Notes</th></tr></thead>
      <tbody>${a.timeline.map(t => `<tr class="${t.flagged ? "flagged" : ""}"><td class="mono">${esc(t.txn_id)}</td><td>${stepLabel(t.step)}</td><td>${esc(t.type)}</td>
        <td><span class="pill ${t.direction === "outgoing" ? "info" : "legit"}">${t.direction}</span></td>
        <td class="mono"><a href="#/risk?account=${encodeURIComponent(t.counterparty)}">${esc(t.counterparty)}</a></td>
        <td class="num">${fmtAmt(t.amount)}</td><td class="num">${fmtAmt(t.balance_after)}</td><td class="num">${t.z_score.toFixed(2)}</td>
        <td>${labelPill(t.is_fraud)}</td><td class="wrap small">${esc(t.reasons.join(" "))}</td></tr>`).join("")}</tbody></table></div></div>
    <div class="card mt"><h2>Network neighbourhood</h2><div class="sub">Directly connected accounts (1 hop in the entity graph). Click one to analyze it.</div>
      <div class="neighbors">${a.neighbors.map(n => `<span data-acct="${esc(n)}">${esc(n)}</span>`).join("") || '<span class="muted">none</span>'}</div></div>`;
  $$(".neighbors [data-acct]", box).forEach(s => s.onclick = () => go("risk", { account: s.dataset.acct }));
}

// ---------------------------------------------------------------- 5. Analytics
async function renderAnalytics(view) {
  const st = S.stats;
  const byType = [...st.by_type].sort((a, b) => b.n - a.n);
  const fraudTypes = st.by_type.filter(t => t.fraud > 0).map(t => t.type);
  const peakHour = [...st.by_hour].sort((a, b) => b.fraud_rate - a.fraud_rate)[0];
  const quietHours = st.by_hour.filter(h => h.hour >= 0 && h.hour <= 6);
  const qRate = quietHours.reduce((s, h) => s + h.fraud, 0) / quietHours.reduce((s, h) => s + h.n, 0);
  const restRate = (st.summary.labeled_fraud - quietHours.reduce((s, h) => s + h.fraud, 0)) / (st.summary.total_transactions - quietHours.reduce((s, h) => s + h.n, 0));
  const drain = st.features.find(f => f.key === "amount_eq_balance");
  view.innerHTML = `
    ${pageHead("Fraud Analytics", "Fraud patterns in the full dataset by type, time, amount and balance behaviour. Descriptive statistics, not model output.", [CHIP.real(), CHIP.label()])}
    <div class="grid g3">
      ${notice("info", `<b>Type.</b> Fraud occurs only in <b>${fraudTypes.join(" and ")}</b>. The other types have zero labeled fraud.`)}
      ${notice("info", `<b>Time.</b> Between 00:00 and 06:59 the fraud rate is <b>${pctSmart(qRate)}</b>, against ${pctSmart(restRate)} for the rest of the day. The peak is at ${String(peakHour.hour).padStart(2, "0")}:00 (${pctSmart(peakHour.fraud_rate)}).`)}
      ${notice("info", `<b>Balance.</b> When a TRANSFER or CASH_OUT moves the sender's <i>entire</i> balance, ${fmtInt(drain.fraud_true)} of ${fmtInt(drain.n_true)} are fraud (${pctSmart(drain.fraud_true / drain.n_true)}).`)}
    </div>
    <div class="grid g2 mt">
      ${chartCard("a-type-n", "Transactions by type", "All 6.36M transactions",
        { headers: ["Type", "Transactions", "Total amount", "Median amount"], rows: byType.map(t => [t.type, fmtInt(t.n), fmtAmt(t.amount), fmtAmt(t.median_amount)]) })}
      ${chartCard("a-type-r", "Fraud rate by type", "Share of each type labeled fraud",
        { headers: ["Type", "Fraud", "Fraud rate", "Fraud amount"], rows: byType.map(t => [t.type, fmtInt(t.fraud), pctSmart(t.fraud_rate), fmtAmt(t.fraud_amount)]) })}
      ${chartCard("a-hour-f", "Labeled fraud by hour of day", "Fraud count per hour (step mod 24), all days combined",
        { headers: ["Hour", "Fraud", "Transactions", "Fraud rate"], rows: st.by_hour.map(h => [h.hour, fmtInt(h.fraud), fmtInt(h.n), pctSmart(h.fraud_rate)]) })}
      ${chartCard("a-hour-r", "Fraud rate by hour of day", "Fraud is spread evenly, but legitimate volume collapses overnight",
        { headers: ["Hour", "Fraud rate"], rows: st.by_hour.map(h => [h.hour, pctSmart(h.fraud_rate)]) })}
    </div>
    <div class="grid mt">
      ${chartCard("a-step-n", "Transactions per hour, full 743-hour timeline", "Volume over the simulated month",
        { headers: ["Step", "Transactions", "Fraud"], rows: st.by_step.map(s => [s.step, fmtInt(s.n), fmtInt(s.fraud)]) })}
      ${chartCard("a-step-f", "Labeled fraud per hour, full timeline", "Fraud stays steady while volume swings, so the fraud rate spikes in quiet hours",
        { headers: ["Step", "Fraud", "Fraud amount"], rows: st.by_step.map(s => [s.step, fmtInt(s.fraud), fmtAmt(s.fraud_amount)]) })}
    </div>
    <div class="grid g2 mt">
      ${chartCard("a-amt", "Fraud rate by amount range", "Share of transactions labeled fraud in each amount bucket",
        { headers: ["Amount", "Transactions", "Fraud", "Fraud rate"], rows: st.by_amount.map(b => [b.label, fmtInt(b.n), fmtInt(b.fraud), pctSmart(b.fraud_rate)]) })}
      ${chartCard("a-feat", "Fraud rate by balance pattern", "TRANSFER and CASH_OUT only: fraud rate when the pattern is present vs absent",
        { headers: ["Pattern", "Present: txns", "Present: fraud", "Absent: txns", "Absent: fraud"], rows: st.features.map(f => [f.label, fmtInt(f.n_true), fmtInt(f.fraud_true), fmtInt(f.n_false), fmtInt(f.fraud_false)]) })}
    </div>
    <p class="small muted mt">Each step is one simulated hour (step 1 = Day 1 01:00, as in the notebook's timestamp). Near the end of the month legitimate volume nearly stops while fraud continues, which is a known artifact of the PaySim simulation.</p>`;

  const c1 = css("--series-1"), crit = css("--critical");
  addChart(() => Charts.bars($("#a-type-n"), { horizontal: true, categories: byType.map(t => t.type),
    series: [{ name: "Transactions", color: c1, values: byType.map(t => t.n) }], fmt: fmtInt, axisFmt: fmtCompact }));
  addChart(() => Charts.bars($("#a-type-r"), { horizontal: true, categories: byType.map(t => t.type),
    series: [{ name: "Fraud rate", color: crit, values: byType.map(t => t.fraud_rate) }], fmt: pctSmart, axisFmt: v => pct(v, 1),
    tipExtra: i => `<div>${fmtInt(byType[i].fraud)} of ${fmtInt(byType[i].n)}</div>` }));
  const hrs = st.by_hour.map(h => String(h.hour).padStart(2, "0"));
  addChart(() => Charts.bars($("#a-hour-f"), { categories: hrs, series: [{ name: "Labeled fraud", color: crit, values: st.by_hour.map(h => h.fraud) }], fmt: fmtInt }));
  addChart(() => Charts.bars($("#a-hour-r"), { categories: hrs, series: [{ name: "Fraud rate", color: crit, values: st.by_hour.map(h => h.fraud_rate) }],
    fmt: pctSmart, axisFmt: v => pct(v, 1), tipExtra: i => `<div>${fmtInt(st.by_hour[i].fraud)} fraud of ${fmtInt(st.by_hour[i].n)}</div>` }));
  const steps = st.by_step.map(s => s.step);
  addChart(() => Charts.line($("#a-step-n"), { x: steps, xFmt: stepLabel, series: [{ name: "Transactions", color: c1, values: st.by_step.map(s => s.n) }], fmt: fmtInt, axisFmt: fmtCompact, height: 200, area: true }));
  addChart(() => Charts.line($("#a-step-f"), { x: steps, xFmt: stepLabel, series: [{ name: "Labeled fraud", color: crit, values: st.by_step.map(s => s.fraud) }], fmt: fmtInt, height: 200,
    tipExtra: i => `<div>of ${fmtInt(st.by_step[i].n)} transactions</div>` }));
  addChart(() => Charts.bars($("#a-amt"), { categories: st.by_amount.map(b => b.label), xLabelRotate: true, height: 260,
    series: [{ name: "Fraud rate", color: crit, values: st.by_amount.map(b => b.fraud_rate) }], fmt: pctSmart, axisFmt: v => pct(v, 0),
    tipExtra: i => `<div>${fmtInt(st.by_amount[i].fraud)} fraud of ${fmtInt(st.by_amount[i].n)}</div>` }));
  const SHORT = { orig_drained: "Sender emptied", amount_eq_balance: "Amount = balance", dest_zero_both: "Receiver stays 0", orig_balance_mismatch: "Ledger mismatch" };
  addChart(() => Charts.bars($("#a-feat"), { horizontal: true, categories: st.features.map(f => SHORT[f.key] || f.label),
    tipExtra: (i, j) => `<div>${esc(st.features[i].label)}</div>`,
    series: [{ name: "Pattern present", color: crit, values: st.features.map(f => f.n_true ? f.fraud_true / f.n_true : 0) },
             { name: "Pattern absent", color: c1, values: st.features.map(f => f.n_false ? f.fraud_false / f.n_false : 0) }],
    fmt: pctSmart, axisFmt: v => pct(v, 0) }));
}

// ---------------------------------------------------------------- 6. Alerts & reports
async function renderAlerts(view, params) {
  const src = params.get("src") || "all", type = params.get("type") || "", page = +(params.get("page") || 1);
  const sm = S.stats.summary;
  view.innerHTML = `
    ${pageHead("Alerts & Reports", "Suspicious transactions raised by the rule engines, plus exportable reports.", [CHIP.rule(), CHIP.real()])}
    <div class="grid g-2-1">
      <div class="card"><div class="card-head"><div><h2>Alert queue</h2><div class="sub">Sorted by FinTrace risk. Click an alert to investigate it.</div></div></div>
        <div class="filters">
          <div class="seg">${[["all", `All (${fmtInt(sm.suspicious)})`], ["fintrace", `FinTrace High risk (${fmtInt(sm.fintrace_high_risk)})`], ["paysim", `PaySim-flagged (${fmtInt(sm.paysim_flagged)})`]]
            .map(([k, l]) => `<button data-src="${k}" class="${src === k ? "on" : ""}">${l}</button>`).join("")}</div>
          <select id="al-type" aria-label="Type"><option value="">All types</option>${TYPES.map(t => `<option ${type === t ? "selected" : ""}>${t}</option>`).join("")}</select>
          <span class="spacer"></span><a class="btn gold" id="al-export">${icon("download")}Export alerts CSV</a>
        </div>
        <div id="al-list">${loading()}</div></div>
      <div>
        <div class="card"><h2>Reports</h2><div class="sub">All exports are generated from the full dataset on demand.</div>
          <div class="grid" style="gap:8px">
            <a class="btn" href="/api/transactions/export?fraud=1&limit=250000&filename=labeled_fraud_transactions.csv">${icon("download")}All labeled fraud (${fmtInt(sm.labeled_fraud)} rows)</a>
            <a class="btn" href="/api/transactions/export?suspicious=true&sort=risk&order=desc&filename=suspicious_transactions.csv">${icon("download")}All suspicious transactions</a>
            <a class="btn" href="/api/transactions/export?flagged=1&filename=paysim_flagged.csv">${icon("download")}PaySim-flagged transactions</a>
            <button class="btn" id="al-accts">${icon("download")}Top 50 risky accounts (CSV)</button>
            <a class="btn primary" href="#/report">${icon("print")}Printable summary report</a>
          </div>
          <hr class="sep">
          <form id="al-case" class="filters" style="margin:0">
            <div class="field" style="flex:1"><label for="al-acct">Account case report (notebook template)</label>
              <input type="text" id="al-acct" placeholder="Account ID, e.g. C1286084959" required></div>
            <button class="btn" type="submit">${icon("doc")}Open</button>
          </form></div>
        <div class="card mt"><h2>Alert rules</h2>
          <div class="signal"><div class="top"><span>FinTrace High risk</span>${bandPill("High")}</div><div class="detail">Transaction risk ≥ 50, where risk is the higher of the sender's and receiver's behavioral score (notebook section 5, no label signal).</div></div>
          <div class="signal"><div class="top"><span>PaySim isFlaggedFraud</span>${flagPill(1)}</div><div class="detail">The simulator's built-in rule, documented as flagging attempts to transfer more than 200,000 in one transaction. It is part of the source dataset and fires on only 16 rows.</div></div>
          <p class="small muted">Labeled-fraud columns show the dataset's ground truth for comparison. They are not used to raise alerts.</p></div>
      </div>
    </div>`;
  $$("[data-src]").forEach(b => b.onclick = () => go("alerts", { src: b.dataset.src, type }));
  $("#al-type").onchange = e => go("alerts", { src, type: e.target.value });
  $("#al-case").addEventListener("submit", e => { e.preventDefault(); window.open(`/api/accounts/${encodeURIComponent($("#al-acct").value.trim())}/report`, "_blank", "noopener"); });
  $("#al-accts").onclick = () => {
    const rows = [["account_id", "transactions", "behavioral_score", "investigative_score", "labeled_fraud", "w_zscore", "w_iqr", "w_novelty", "w_labels"],
      ...S.stats.top_accounts.map(a => [a.account_id, a.n, a.behavioral_score, a.investigative_score, a.fraud_n, a.w_zscore, a.w_iqr, a.w_novelty, a.w_labels])];
    const blob = new Blob([rows.map(r => r.join(",")).join("\n")], { type: "text/csv" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "fintrace_top_risky_accounts.csv"; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  const q = new URLSearchParams({ sort: "risk", order: "desc", page, page_size: 20 });
  if (src === "all") q.set("suspicious", "true"); else if (src === "fintrace") q.set("band", "High"); else q.set("flagged", "1");
  if (type) q.set("type", type);
  const exp = new URLSearchParams(q); exp.delete("page"); exp.delete("page_size"); exp.set("filename", "fintrace_alerts.csv");
  $("#al-export").href = `/api/transactions/export?${exp}`;
  const res = await api(`/api/transactions?${q}`);
  const box = $("#al-list");
  if (!res.rows.length) { box.innerHTML = `<div class="empty">No alerts for this filter.</div>`; return; }
  box.innerHTML = `<div class="table-wrap"><table><thead><tr><th>Alert</th><th>Time</th><th>Type</th><th class="num">Amount</th><th class="num">Risk</th><th>Raised by</th><th>Label</th><th></th></tr></thead><tbody>
    ${res.rows.map((r, i) => `<tr class="clickable flagged" data-i="${i}" tabindex="0"><td class="mono">${esc(r.txn_id)}</td><td>${stepLabel(r.step)}</td><td>${esc(r.type)}</td>
      <td class="num">${fmtAmt(r.amount)}</td><td class="num score">${r.risk.toFixed(1)}</td>
      <td class="wrap small">${[r.risk >= 50 ? `FinTrace: ${r.risk_orig >= r.risk_dest ? "sender" : "receiver"} score ${Math.max(r.risk_orig, r.risk_dest).toFixed(1)}` : "", r.isFlaggedFraud ? "PaySim isFlaggedFraud" : ""].filter(Boolean).join(" · ")}</td>
      <td>${labelPill(r.isFraud)}</td><td><a class="linkbtn" href="#/engine?txn=${r.row_id}">Investigate</a></td></tr>`).join("")}
    </tbody></table></div>`;
  bindTxRows(box, res.rows);
  $$("a.linkbtn", box).forEach(a => a.addEventListener("click", e => e.stopPropagation()));
  box.appendChild(pager(res.total, page, 20, np => go("alerts", { src, type, page: np })));
}

// ---------------------------------------------------------------- 7. Model performance
function confusion(m) {
  return `<div class="cm" role="table" aria-label="Confusion matrix">
    <div></div><div class="h">Predicted fraud</div><div class="h">Predicted legit</div>
    <div class="rh">Actual fraud</div><div class="c tp"><b>${fmtInt(m.tp)}</b><small>true positive</small></div><div class="c fn"><b>${fmtInt(m.fn)}</b><small>false negative</small></div>
    <div class="rh">Actual legit</div><div class="c fp"><b>${fmtInt(m.fp)}</b><small>false positive</small></div><div class="c tn"><b>${fmtInt(m.tn)}</b><small>true negative</small></div></div>`;
}
function metricRow(m) {
  const f = v => v == null ? "—" : (v * 100).toFixed(v > 0 && v < 0.01 ? 3 : 2) + "%";
  return `<div class="metrics"><div><small>Accuracy</small><b>${f(m.accuracy)}</b></div><div><small>Precision</small><b>${f(m.precision)}</b></div>
    <div><small>Recall</small><b>${f(m.recall)}</b></div><div><small>F1-score</small><b>${f(m.f1)}</b></div></div>`;
}

async function renderModel(view) {
  const ev = S.stats.evaluation, sweep = ev.fintrace_behavioral_sweep, ml = ev.ml_model;
  const allLegitAcc = ev.negatives / (ev.positives + ev.negatives);
  const best = [...sweep].sort((a, b) => b.f1 - a.f1)[0];
  view.innerHTML = `
    ${pageHead("Model Performance", `Every detector below is scored against the dataset's isFraud labels over all ${fmtInt(ev.positives + ev.negatives)} transactions.`, [CHIP.label(), CHIP.rule(), CHIP.ml()])}
    ${ml ? "" : notice("warn", `<b>No machine-learning model is included in this project.</b> The FinTrace notebook scores accounts with explainable rules on purpose (its own design note says "explainability over accuracy").
      The metrics below therefore evaluate the two rule-based detectors that do exist. No ML accuracy figures are shown or simulated.`)}
    <div class="grid g3 mt">
      <div class="card"><h2>ML classifier</h2><div class="sub">${ml ? `Reported by <code>models/metrics.json</code>${ml.name ? " · " + esc(ml.name) : ""}` : "API slot: <code>models/model.joblib</code> + <code>models/metrics.json</code>"}</div>
        ${ml ? `${metricRow(ml)}${ml.confusion_matrix ? confusion({ tn: ml.confusion_matrix[0][0], fp: ml.confusion_matrix[0][1], fn: ml.confusion_matrix[1][0], tp: ml.confusion_matrix[1][1] }) : ""}
          <p class="small muted">${esc(ml.evaluated_on || "Evaluation set as described by your notebook.")} These numbers come from your file; this site does not recompute them.</p>`
          : `<div class="empty" style="padding:24px 8px"><b>Not available</b><br><span class="small">No trained model has been connected.</span></div>
          <p class="small muted">To connect one, train it in the notebook, save it as <code>models/model.joblib</code>, and write its held-out metrics to <code>models/metrics.json</code>. The README has a ready-made cell. After a restart, this card and the Detection Engine use it automatically.</p>`}</div>
      <div class="card"><h2>FinTrace rules (behavioral)</h2><div class="sub">Notebook <code>score_account</code> without the label signal · predicted fraud if risk ≥ threshold</div>
        <div class="field"><label for="thr">Threshold: <b id="thr-v">${ev.default_threshold}</b></label><input type="range" id="thr" min="0" max="100" step="1" value="${ev.default_threshold}"></div>
        <div id="fr-metrics"></div><div id="fr-cm"></div></div>
      <div class="card"><h2>PaySim isFlaggedFraud</h2><div class="sub">The simulator's built-in rule (documented as flagging transfers over 200,000), included in the dataset</div>
        ${metricRow(ev.paysim_isFlaggedFraud)}${confusion(ev.paysim_isFlaggedFraud)}</div>
    </div>
    <div class="grid g-2-1 mt">
      ${chartCard("m-pr", "FinTrace rules: precision and recall by threshold", "Moving the threshold trades recall for precision. The vertical line marks the selected threshold.",
        { headers: ["Threshold", "Precision", "Recall", "F1", "Flagged"], rows: sweep.filter(m => m.threshold % 5 === 0).map(m => [m.threshold, pctSmart(m.precision), pctSmart(m.recall), pctSmart(m.f1), fmtInt(m.tp + m.fp)]) })}
      <div class="card"><h2>Reading these results</h2>
        <div class="signal"><div class="top"><span>Accuracy is misleading here</span></div><div class="detail">Only ${pct(ev.positives / (ev.positives + ev.negatives), 3)} of transactions are fraud, so a detector that predicts "legit" every time scores <b>${pct(allLegitAcc, 2)}</b> accuracy. Judge detectors by precision, recall and F1 instead.</div></div>
        <div class="signal"><div class="top"><span>What the rules are for</span></div><div class="detail">The notebook's rules describe how unusual an account is compared with its <i>own</i> history. In PaySim most accounts appear only once or twice, so these signals separate fraud poorly: best in-sample F1 is ${pctSmart(best.f1)} at threshold ${best.threshold}. The rules are built to explain cases to an investigator, not to classify transactions.</div></div>
        <div class="signal"><div class="top"><span>Why the label signal is excluded</span></div><div class="detail">The notebook's fourth signal adds weight for transactions already labeled fraud. Testing that against the same labels would be circular, so the classification score leaves it out.</div></div>
        <div class="signal"><div class="top"><span>Implementation check</span></div><div class="detail">The set-based scorer used for these figures was checked against the notebook's Python <code>score_account</code> on ${ev.verification.accounts_checked} random accounts: <b>${ev.verification.mismatches} mismatches</b>.</div></div></div>
    </div>`;

  const update = t => {
    const m = sweep.find(x => x.threshold === t);
    $("#thr-v").textContent = t;
    $("#fr-metrics").innerHTML = metricRow(m) + `<div class="small muted">${fmtInt(m.tp + m.fp)} transactions flagged at this threshold.</div>`;
    $("#fr-cm").innerHTML = `<div class="mt">${confusion(m)}</div>`;
    chartRenderers = [drawPR(t)];
    chartRenderers[0]();
  };
  const drawPR = t => () => Charts.line($("#m-pr"), {
    x: sweep.map(m => m.threshold), xFmt: v => `≥ ${v}`, xTicks: 6, marker: t, yMax: 1,
    series: [{ name: "Precision", color: css("--series-1"), values: sweep.map(m => m.precision) },
             { name: "Recall", color: css("--series-2"), values: sweep.map(m => m.recall) }],
    fmt: v => pctSmart(v), axisFmt: v => pct(v, 0),
    tipExtra: i => `<div>F1: <b>${pctSmart(sweep[i].f1)}</b> · flagged ${fmtInt(sweep[i].tp + sweep[i].fp)}</div>`,
  });
  $("#thr").addEventListener("input", e => update(+e.target.value));
  update(ev.default_threshold);
}

// ---------------------------------------------------------------- printable summary report
const tw = (h, r) => `<div class="table-wrap">${simpleTable(h, r)}</div>`;
async function renderSummaryReport(view) {
  if (!S.stats) { view.innerHTML = loading(); return; }
  const st = S.stats, sm = st.summary, ev = st.evaluation;
  const m50 = ev.fintrace_behavioral_sweep.find(m => m.threshold === ev.default_threshold);
  const top = await api("/api/transactions?suspicious=true&sort=risk&order=desc&page_size=15");
  view.innerHTML = `
    <div class="flex no-print" style="margin-bottom:14px"><a class="btn" href="#/alerts">← Back</a><button class="btn primary" onclick="window.print()">${icon("print")}Print / save as PDF</button></div>
    <div class="card"><div class="small muted" style="letter-spacing:2px;text-transform:uppercase;color:var(--gold);font-weight:700">FinTrace · Monitoring summary</div>
      <h1 style="margin:4px 0">Fraud monitoring summary report</h1>
      <div class="muted small">Generated ${new Date().toLocaleString()} · Data store built ${esc(st.generated_at)} · Source: PaySim synthetic mobile-money log (${fmtInt(sm.total_transactions)} transactions)</div></div>
    <div class="card mt"><h2>Key figures</h2>
      ${tw(["Metric", "Value", "Source"], [
        ["Total transactions", fmtInt(sm.total_transactions), "Dataset"],
        ["Labeled fraud transactions", fmtInt(sm.labeled_fraud), "Ground truth (isFraud)"],
        ["Fraud rate", pct(sm.fraud_rate, 3), "Ground truth"],
        ["Labeled fraud amount", fmtAmt(sm.labeled_fraud_amount), "Ground truth"],
        ["Suspicious transactions", fmtInt(sm.suspicious), "FinTrace rules + PaySim flag"],
        ["Suspicious amount", fmtAmt(sm.suspicious_amount), "FinTrace rules + PaySim flag"],
        ["Accounts", fmtInt(sm.total_accounts), "Dataset"],
      ])}</div>
    <div class="card mt"><h2>Fraud by transaction type</h2>
      ${tw(["Type", "Transactions", "Fraud", "Fraud rate", "Fraud amount"], st.by_type.map(t => [t.type, fmtInt(t.n), fmtInt(t.fraud), pctSmart(t.fraud_rate), fmtAmt(t.fraud_amount)]))}</div>
    <div class="card mt"><h2>Detector performance (against isFraud labels)</h2>
      ${tw(["Detector", "Precision", "Recall", "F1", "TP", "FP", "FN"], [
        [`FinTrace rules (risk ≥ ${ev.default_threshold})`, pctSmart(m50.precision), pctSmart(m50.recall), pctSmart(m50.f1), fmtInt(m50.tp), fmtInt(m50.fp), fmtInt(m50.fn)],
        ["PaySim isFlaggedFraud", pctSmart(ev.paysim_isFlaggedFraud.precision), pctSmart(ev.paysim_isFlaggedFraud.recall), pctSmart(ev.paysim_isFlaggedFraud.f1), fmtInt(ev.paysim_isFlaggedFraud.tp), fmtInt(ev.paysim_isFlaggedFraud.fp), fmtInt(ev.paysim_isFlaggedFraud.fn)],
        ["ML classifier", ev.ml_model ? pctSmart(ev.ml_model.precision) : "not available", ev.ml_model ? pctSmart(ev.ml_model.recall) : "—", ev.ml_model ? pctSmart(ev.ml_model.f1) : "—", "", "", ""],
      ])}</div>
    <div class="card mt"><h2>Top 15 alerts</h2>
      ${tw(["Txn", "Time", "Type", "Amount", "Sender", "Receiver", "Risk", "Label"], top.rows.map(r => [r.txn_id, stepLabel(r.step), r.type, fmtAmt(r.amount), r.nameOrig, r.nameDest, r.risk.toFixed(1), r.isFraud ? "Fraud" : "Legit"]))}</div>
    <p class="small muted">The FinTrace scores come from the rule-based engine in FinTrace_Colab_1.ipynb. No machine-learning predictions appear in this report unless an ML model is listed above.</p>`;
}

// ---------------------------------------------------------------- boot
function buildNav() {
  $("#nav").innerHTML = Object.entries(ROUTES).filter(([, r]) => !r.hidden).map(([k, r]) =>
    `<a href="#/${k}" data-route="${k}">${icon(r.icon)}<span>${r.nav}</span></a>`).join("");
}
function renderSideFoot() {
  const h = S.health, sm = S.stats?.summary;
  $("#side-foot").innerHTML = `
    <div class="row"><span>API</span><b>${h ? "online" : "offline"}</b></div>
    <div class="row"><span>Dataset</span><b>${sm ? fmtCompact(sm.total_transactions) + " rows" : "—"}</b></div>
    <div class="row"><span>Engine</span><b>Rule-based</b></div>
    <div class="row"><span>ML model</span><b>${h?.ml_model?.available ? "connected" : "not connected"}</b></div>`;
}

const THEMES = ["auto", "light", "dark"];
function applyTheme(t) {
  if (t === "auto") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", t);
  $("#theme").innerHTML = icon(t === "auto" ? "auto" : t === "light" ? "sun" : "moon");
  $("#theme").title = `Theme: ${t}`;
  try { localStorage.setItem("fintrace-theme", t); } catch (_) { /* storage unavailable */ }
  drawCharts();
}

async function boot() {
  buildNav();
  let t = "auto";
  try { t = localStorage.getItem("fintrace-theme") || "auto"; } catch (_) { /* storage unavailable */ }
  applyTheme(THEMES.includes(t) ? t : "auto");
  $("#theme").onclick = () => {
    const cur = document.documentElement.getAttribute("data-theme") || "auto";
    applyTheme(THEMES[(THEMES.indexOf(cur) + 1) % 3]);
  };
  $("#drawer-bg").onclick = closeDrawer;
  document.addEventListener("keydown", e => { if (e.key === "Escape") closeDrawer(); });
  window.addEventListener("hashchange", router);
  router();
  try {
    [S.health, S.stats] = await Promise.all([api("/api/health"), api("/api/stats")]);
  } catch (e) {
    S.bootError = e;
  }
  renderSideFoot();
  $("#status-chips").innerHTML = S.bootError ? chips([["err", "API / data unavailable"]])
    : chips([CHIP.real(), ["rule", "Engine: rule-based"], CHIP.ml()]);
  router();
}
boot();
