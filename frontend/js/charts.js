/* Minimal SVG chart kit (no external libraries, works offline).
 * Bars: <=24px thick, 4px rounded data-end, square at the baseline, 2px gap
 * between grouped bars. Lines: 2px with crosshair + tooltip. Gridlines are
 * solid hairlines. Text always uses ink tokens, never the series color. */
const Charts = (() => {
  const NS = "http://www.w3.org/2000/svg";
  const s = (tag, attrs = {}, parent) => {
    const n = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    if (parent) parent.appendChild(n);
    return n;
  };

  let tipEl;
  function tip() {
    if (!tipEl) {
      tipEl = document.createElement("div");
      tipEl.className = "viz-tip";
      tipEl.setAttribute("role", "status");
      document.body.appendChild(tipEl);
    }
    return tipEl;
  }
  function showTip(html, evt) {
    const t = tip();
    t.innerHTML = html;
    t.style.display = "block";
    const pad = 14, w = t.offsetWidth, h = t.offsetHeight;
    let x = evt.clientX + pad, y = evt.clientY + pad;
    if (x + w > window.innerWidth - 8) x = evt.clientX - w - pad;
    if (y + h > window.innerHeight - 8) y = evt.clientY - h - pad;
    t.style.left = x + "px"; t.style.top = y + "px";
  }
  function hideTip() { if (tipEl) tipEl.style.display = "none"; }

  function niceStep(range, count) {
    const raw = range / Math.max(1, count);
    const mag = Math.pow(10, Math.floor(Math.log10(raw || 1)));
    const norm = raw / mag;
    return (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag;
  }
  function linearTicks(max, count = 4) {
    if (max <= 0) return [0, 1];
    const step = niceStep(max, count);
    const ticks = [];
    for (let v = 0; v <= max + step * 0.001; v += step) ticks.push(+v.toFixed(10));
    if (ticks[ticks.length - 1] < max) ticks.push(+(ticks[ticks.length - 1] + step).toFixed(10));
    return ticks;
  }
  function logTicks(max) {
    const ticks = [1];
    while (ticks[ticks.length - 1] < max) ticks.push(ticks[ticks.length - 1] * 10);
    return ticks;
  }

  function legend(container, series) {
    if (series.length < 2) return;
    const lg = document.createElement("div");
    lg.className = "viz-legend";
    lg.innerHTML = series.map(sr =>
      `<span><i class="${sr.kind === "line" ? "key-line" : "key-swatch"}" style="background:${sr.color}"></i>${sr.name}</span>`).join("");
    container.appendChild(lg);
  }

  // Path for a bar with a 4px rounded data-end and square baseline.
  function barPath(x, y, w, h, horizontal) {
    const r = Math.min(4, horizontal ? h / 2 : w / 2, horizontal ? w : h);
    if (w <= 0 || h <= 0) return "";
    if (!horizontal) // rounded top
      return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
    return `M${x},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h - r}Q${x + w},${y + h} ${x + w - r},${y + h}H${x}Z`;
  }

  /* bars(container, {categories, series:[{name,color,values}], horizontal,
   *   fmt, axisFmt, log, height, labelMode: 'max'|'all'|'none', tipExtra}) */
  function bars(container, o) {
    container.innerHTML = "";
    const series = o.series, cats = o.categories;
    legend(container, series);
    const fmt = o.fmt || (v => v.toLocaleString());
    const axisFmt = o.axisFmt || fmt;
    const width = Math.max(280, container.clientWidth || 600);
    const horizontal = !!o.horizontal;
    const groupN = series.length;
    const allVals = series.flatMap(sr => sr.values);
    const max = Math.max(...allVals, 0);
    const ticks = o.log ? logTicks(max) : linearTicks(max);
    const top = ticks[ticks.length - 1];
    const scale = v => o.log ? (v <= 0 ? 0 : Math.log10(Math.max(1, v)) / Math.log10(top)) : v / top;

    if (horizontal) {
      const labelW = Math.min(o.labelWidth || Math.max(...cats.map(c => String(c).length)) * 7.2 + 12, width * 0.42);
      const band = Math.max(26, groupN * 18 + 12);
      const height = cats.length * band + 30;
      const m = { l: labelW, r: 64, t: 4, b: 26 };
      const W = Math.max(40, width - m.l - m.r);
      const svg = s("svg", { viewBox: `0 0 ${width} ${height}`, width: "100%", height, role: "img", "aria-label": o.ariaLabel || "bar chart" }, container);
      ticks.forEach(t => {
        const x = m.l + scale(t) * W;
        s("line", { x1: x, x2: x, y1: m.t, y2: height - m.b, class: "grid" }, svg);
        const tx = s("text", { x, y: height - 8, class: "axis", "text-anchor": "middle" }, svg); tx.textContent = axisFmt(t);
      });
      s("line", { x1: m.l, x2: m.l, y1: m.t, y2: height - m.b, class: "baseline" }, svg);
      const thick = Math.min(24, (band - 12 - (groupN - 1) * 2) / groupN);
      cats.forEach((c, i) => {
        const y0 = m.t + i * band + (band - (thick * groupN + 2 * (groupN - 1))) / 2;
        const lab = s("text", { x: m.l - 8, y: m.t + i * band + band / 2 + 4, class: "label", "text-anchor": "end" }, svg);
        lab.textContent = c;
        series.forEach((sr, j) => {
          const v = sr.values[i];
          const w = scale(v) * W;
          const y = y0 + j * (thick + 2);
          const p = s("path", { d: barPath(m.l, y, Math.max(w, v > 0 ? 1.5 : 0), thick, true), fill: sr.color, class: "mark" }, svg);
          const hit = s("rect", { x: m.l, y: y - 1, width: W, height: thick + 2, fill: "transparent" }, svg);
          const html = `<b>${c}</b><div><i class="key-swatch" style="background:${sr.color}"></i>${sr.name}: <b>${fmt(v)}</b></div>${o.tipExtra ? o.tipExtra(i, j) : ""}`;
          hit.addEventListener("mousemove", e => { p.classList.add("hover"); showTip(html, e); });
          hit.addEventListener("mouseleave", () => { p.classList.remove("hover"); hideTip(); });
          if (o.labelMode !== "none") {
            const vt = s("text", { x: m.l + w + 6, y: y + thick / 2 + 4, class: "value" }, svg);
            vt.textContent = fmt(v);
          }
        });
      });
      return;
    }

    const height = o.height || 240;
    const m = { l: 56, r: 12, t: 16, b: o.xLabelRotate ? 52 : 30 };
    const W = width - m.l - m.r, H = height - m.t - m.b;
    const svg = s("svg", { viewBox: `0 0 ${width} ${height}`, width: "100%", height, role: "img", "aria-label": o.ariaLabel || "column chart" }, container);
    ticks.forEach(t => {
      const y = m.t + H - scale(t) * H;
      s("line", { x1: m.l, x2: width - m.r, y1: y, y2: y, class: "grid" }, svg);
      const ty = s("text", { x: m.l - 8, y: y + 4, class: "axis", "text-anchor": "end" }, svg); ty.textContent = axisFmt(t);
    });
    s("line", { x1: m.l, x2: width - m.r, y1: m.t + H, y2: m.t + H, class: "baseline" }, svg);
    const band = W / cats.length;
    const thick = Math.max(2, Math.min(24, (band * 0.7 - (groupN - 1) * 2) / groupN));
    let maxIdx = { i: -1, j: -1, v: -Infinity };
    series.forEach((sr, j) => sr.values.forEach((v, i) => { if (v > maxIdx.v) maxIdx = { i, j, v }; }));
    const everyN = Math.ceil(cats.length / Math.max(1, Math.floor(W / 46)));
    cats.forEach((c, i) => {
      const gx = m.l + i * band + (band - (thick * groupN + 2 * (groupN - 1))) / 2;
      if (i % everyN === 0) {
        const cx = m.l + i * band + band / 2;
        const lab = s("text", { x: cx, y: m.t + H + 16, class: "axis", "text-anchor": o.xLabelRotate ? "end" : "middle",
          transform: o.xLabelRotate ? `rotate(-35 ${cx} ${m.t + H + 16})` : "" }, svg);
        lab.textContent = c;
      }
      const hit = s("rect", { x: m.l + i * band, y: m.t, width: band, height: H, fill: "transparent" }, svg);
      const marks = [];
      series.forEach((sr, j) => {
        const v = sr.values[i];
        const h = scale(v) * H;
        const x = gx + j * (thick + 2);
        marks.push(s("path", { d: barPath(x, m.t + H - h, thick, Math.max(h, v > 0 ? 1.5 : 0), false), fill: sr.color, class: "mark" }, svg));
        if (o.labelMode === "all" || (o.labelMode !== "none" && i === maxIdx.i && j === maxIdx.j)) {
          const vt = s("text", { x: x + thick / 2, y: m.t + H - h - 6, class: "value", "text-anchor": "middle" }, svg);
          vt.textContent = fmt(v);
        }
      });
      svg.appendChild(hit);
      const html = `<b>${c}</b>` + series.map((sr, j) =>
        `<div><i class="key-swatch" style="background:${sr.color}"></i>${sr.name}: <b>${fmt(sr.values[i])}</b></div>`).join("") +
        (o.tipExtra ? o.tipExtra(i) : "");
      hit.addEventListener("mousemove", e => { marks.forEach(mk => mk.classList.add("hover")); showTip(html, e); });
      hit.addEventListener("mouseleave", () => { marks.forEach(mk => mk.classList.remove("hover")); hideTip(); });
    });
    if (o.log) {
      const lt = s("text", { x: m.l, y: 10, class: "axis" }, svg); lt.textContent = "log scale";
    }
  }

  /* line(container, {x, series:[{name,color,values}], xFmt, fmt, height, yMax, area}) */
  function line(container, o) {
    container.innerHTML = "";
    legend(container, o.series.map(sr => ({ ...sr, kind: "line" })));
    const fmt = o.fmt || (v => v.toLocaleString());
    const xFmt = o.xFmt || (v => v);
    const width = Math.max(280, container.clientWidth || 600);
    const height = o.height || 240;
    const m = { l: 56, r: 16, t: 14, b: 30 };
    const W = width - m.l - m.r, H = height - m.t - m.b;
    const max = o.yMax ?? Math.max(...o.series.flatMap(sr => sr.values), 0);
    const ticks = linearTicks(max);
    const top = o.yMax ?? ticks[ticks.length - 1];
    const n = o.x.length;
    const X = i => m.l + (n === 1 ? W / 2 : (i / (n - 1)) * W);
    const Y = v => m.t + H - (v / top) * H;
    const svg = s("svg", { viewBox: `0 0 ${width} ${height}`, width: "100%", height, role: "img", "aria-label": o.ariaLabel || "line chart" }, container);
    ticks.filter(t => t <= top + 1e-9).forEach(t => {
      s("line", { x1: m.l, x2: width - m.r, y1: Y(t), y2: Y(t), class: "grid" }, svg);
      const ty = s("text", { x: m.l - 8, y: Y(t) + 4, class: "axis", "text-anchor": "end" }, svg); ty.textContent = (o.axisFmt || fmt)(t);
    });
    s("line", { x1: m.l, x2: width - m.r, y1: m.t + H, y2: m.t + H, class: "baseline" }, svg);
    // x labels: evenly spaced, dropping any that would collide with a neighbour
    const labW = Math.max(...o.x.map(v => String(xFmt(v)).length)) * 6.4 + 12;
    const xticks = Math.max(2, Math.min(o.xTicks || 8, n, Math.floor(W / labW)));
    const idx = [...new Set(Array.from({ length: xticks }, (_, k) => Math.round((k / (xticks - 1)) * (n - 1))))];
    idx.forEach((i, k) => {
      const last = k === idx.length - 1;
      if (!last && k > 0 && X(idx[idx.length - 1]) - X(i) < labW) return;
      const tx = s("text", { x: X(i), y: height - 8, class: "axis", "text-anchor": k === 0 ? "start" : last ? "end" : "middle" }, svg);
      tx.textContent = xFmt(o.x[i]);
    });
    o.series.forEach(sr => {
      const d = sr.values.map((v, i) => `${i ? "L" : "M"}${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join("");
      if (o.area) s("path", { d: `${d}L${X(n - 1)},${m.t + H}L${X(0)},${m.t + H}Z`, fill: sr.color, opacity: 0.1 }, svg);
      s("path", { d, fill: "none", stroke: sr.color, "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round" }, svg);
      const li = sr.values.length - 1;
      s("circle", { cx: X(li), cy: Y(sr.values[li]), r: 4, fill: sr.color, class: "dot" }, svg);
    });
    if (o.marker != null) {
      const mx = X(o.marker);
      s("line", { x1: mx, x2: mx, y1: m.t, y2: m.t + H, class: "marker-line" }, svg);
    }
    const cross = s("line", { x1: 0, x2: 0, y1: m.t, y2: m.t + H, class: "crosshair", visibility: "hidden" }, svg);
    const dots = o.series.map(sr => s("circle", { r: 4, fill: sr.color, class: "dot", visibility: "hidden" }, svg));
    const hit = s("rect", { x: m.l, y: m.t, width: W, height: H, fill: "transparent" }, svg);
    hit.addEventListener("mousemove", e => {
      const box = svg.getBoundingClientRect();
      const px = (e.clientX - box.left) * (width / box.width);
      const i = Math.max(0, Math.min(n - 1, Math.round(((px - m.l) / W) * (n - 1))));
      cross.setAttribute("x1", X(i)); cross.setAttribute("x2", X(i)); cross.setAttribute("visibility", "visible");
      o.series.forEach((sr, j) => {
        dots[j].setAttribute("cx", X(i)); dots[j].setAttribute("cy", Y(sr.values[i])); dots[j].setAttribute("visibility", "visible");
      });
      showTip(`<b>${xFmt(o.x[i])}</b>` + o.series.map(sr =>
        `<div><i class="key-line" style="background:${sr.color}"></i>${sr.name}: <b>${fmt(sr.values[i])}</b></div>`).join("") +
        (o.tipExtra ? o.tipExtra(i) : ""), e);
    });
    hit.addEventListener("mouseleave", () => {
      cross.setAttribute("visibility", "hidden"); dots.forEach(d => d.setAttribute("visibility", "hidden")); hideTip();
    });
  }

  return { bars, line, hideTip };
})();
