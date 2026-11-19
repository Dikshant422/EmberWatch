/* EmberWatch frontend. Reads data/meta.json, regions.json, cells.json only. */
(function () {
  "use strict";

  // ---------- app state ----------
  const S = {
    meta: null, regions: null, cells: null,
    byId: new Map(),            // region id -> region
    countries: [],              // country regions, A-Z
    statesByIso: new Map(),     // iso_a3 -> state regions, A-Z
    sel: { iso: null, stateId: null },
    loadMs: null,
  };
  const $ = (id) => document.getElementById(id);
  const nf = new Intl.NumberFormat("en-US");
  const byName = (a, b) => a.localeCompare(b, "en");

  // ---------- piece 1: load ----------
  async function getJSON(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(url + " returned HTTP " + r.status);
    return r.json();
  }

  async function load() {
    const t0 = performance.now();
    const [meta, regions, cells, countryGeo] = await Promise.all([
      getJSON("data/meta.json"), getJSON("data/regions.json"), getJSON("data/cells.json"),
      getJSON("data/borders/countries.json").catch(() => null),   // optional: run make_borders.py once
    ]);
    S.meta = meta; S.regions = regions; S.cells = cells; S.countryGeo = countryGeo;
    for (const r of regions) {
      S.byId.set(r.id, r);
      if (r.level === "country") S.countries.push(r);
      else {
        if (!S.statesByIso.has(r.iso_a3)) S.statesByIso.set(r.iso_a3, []);
        S.statesByIso.get(r.iso_a3).push(r);
      }
    }
    S.countries.sort((a, b) => byName(a.country, b.country));
    for (const list of S.statesByIso.values()) list.sort((a, b) => byName(a.state, b.state));
    S.loadMs = Math.round(performance.now() - t0);
  }

  // ---------- dropdowns ----------
  function option(value, text) {
    const o = document.createElement("option");
    o.value = value; o.textContent = text; return o;
  }

  function fillCountries() {
    const sel = $("sel-country");
    sel.replaceChildren(option("", "All countries (world)"));
    for (const c of S.countries) sel.append(option(c.iso_a3, c.country));
    sel.disabled = false;
  }

  function fillStates(iso) {
    const sel = $("sel-state");
    if (!iso) {
      sel.replaceChildren(option("", "Choose a country first"));
      sel.disabled = true; return;
    }
    const list = S.statesByIso.get(iso) || [];
    const first = list.length ? "All states or provinces" : "No state-level data for this country";
    sel.replaceChildren(option("", first));
    for (const s of list) sel.append(option(s.id, s.state));
    sel.disabled = list.length === 0;
  }

  function onCountry() {
    const iso = $("sel-country").value || null;
    S.sel = { iso, stateId: null };
    fillStates(iso);
    renderSelection();
  }
  function onState() {
    S.sel.stateId = $("sel-state").value || null;
    renderSelection();
  }

  // Current selection as a region record (or null = world).
  function currentRegion() {
    if (S.sel.stateId) return S.byId.get(S.sel.stateId);
    if (S.sel.iso) return S.byId.get(S.sel.iso);
    return null;
  }

  function renderSelection() {
    const r = currentRegion();
    $("selection-readout").textContent = r
      ? (r.level === "state" ? r.state + ", " + r.country : r.country) +
        ": " + nf.format(r.fire_count) + " fire detections"
      : "World: " + nf.format(S.meta.rows.kept) + " fire detections";
    if (map) { drawBorders(); drawCells(); }
    renderTable();
    renderChart();
    renderSummary();
    document.dispatchEvent(new CustomEvent("selectionchange", { detail: { region: r, sel: S.sel } }));
  }

  function showWarn(msg) {
    const el = $("status");
    el.hidden = false; el.textContent = msg;
  }

  function showError(err) {
    const el = $("status");
    el.hidden = false;
    el.textContent = "Could not load the data. " + err.message +
      " If you opened index.html directly, serve the folder instead: python -m http.server, then open http://localhost:8000";
  }


  // ---------- piece 2: map ----------
  // PERFORMANCE: cells.json has ~35k rows. One DOM marker per cell would freeze the page, so
  // every circle is drawn on a single <canvas> (L.canvas), and only the selection is drawn.
  const EMBER = ["#B8800B", "#E7AB20", "#F08A2B", "#E2503C", "#FFF1C9"];  // extension, not in Helix
  let map, canvas, layer, tip, frpBreaks = [];
  const WORLD = [[-52, -140], [72, 160]];

  function quantile(sorted, q) { return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]; }

  function initMap() {
    map = L.map("map", { worldCopyJump: true, minZoom: 1, maxZoom: 10, zoomSnap: 0.25, preferCanvas: true })
      .fitBounds(WORLD);
    // No tile server (CARTO's free tiles now need an API key). Land and borders come from
    // Natural Earth, simplified by make_borders.py, and are drawn on their own canvas panes.
    map.attributionControl.addAttribution("Boundaries: Natural Earth");
    [["land", 210], ["regions", 220], ["outline", 450]].forEach(([n, z]) => {
      const p = map.createPane(n); p.style.zIndex = z; p.style.pointerEvents = "none";
    });
    if (S.countryGeo) {
      L.geoJSON(S.countryGeo, {
        pane: "land", renderer: L.canvas({ pane: "land" }), interactive: false,
        style: { color: "#2F4A59", weight: 0.7, fillColor: "#132C3A", fillOpacity: 1 },
      }).addTo(map);
    }
    canvas = L.canvas({ padding: 0.5 });
    tip = L.tooltip({ direction: "top", offset: [0, -6], className: "ew-tip" });

    // Colour classes come from the WORLD cell FRP distribution, so colours mean the same in every view.
    const f = S.cells.cells.map((c) => c[3]).sort((a, b) => a - b);
    frpBreaks = [0.2, 0.5, 0.8, 0.95].map((q) => quantile(f, q));
    renderLegend();
  }

  const frpColour = (v) => EMBER[frpBreaks.filter((b) => v >= b).length];

  function renderLegend() {
    const r = (v) => (v < 10 ? v.toFixed(1) : Math.round(v));
    const labels = [
      "under " + r(frpBreaks[0]),
      r(frpBreaks[0]) + " to " + r(frpBreaks[1]),
      r(frpBreaks[1]) + " to " + r(frpBreaks[2]),
      r(frpBreaks[2]) + " to " + r(frpBreaks[3]),
      r(frpBreaks[3]) + "+",
    ];
    $("map-legend").innerHTML =
      '<div class="lg-title">Cell colour: total FRP (MW)</div>' +
      '<div class="lg-row">' +
      EMBER.map((c, i) => '<span class="lg-item"><i style="background:' + c + '"></i>' + labels[i] + "</span>").join("") +
      "</div>" +
      '<div class="lg-note">Each circle is one 0.25&deg; grid cell (about 28 km). Bigger circle = more detections.</div>';
  }

  // Indices into cells.json for the current selection (-1 means "no filter").
  function selectionIdx() {
    const { iso, stateId } = S.sel;
    return {
      c: iso ? S.cells.countries.indexOf(iso) : -1,
      s: stateId ? S.cells.states.indexOf(stateId) : -1,
    };
  }


  // ---------- borders for the selection ----------
  // Selected country: its states/provinces are outlined. Selected state: filled amber outline.
  const a1Cache = new Map();
  let borderLayers = [], borderToken = 0;
  async function getAdmin1(iso) {
    if (!a1Cache.has(iso)) a1Cache.set(iso, getJSON("data/borders/admin1/" + iso + ".json").catch(() => null));
    return a1Cache.get(iso);
  }
  async function drawBorders() {
    const token = ++borderToken;
    borderLayers.forEach((l) => l.remove());
    borderLayers = [];
    const { iso, stateId } = S.sel;
    if (!iso || !S.countryGeo) return;
    const a1 = await getAdmin1(iso);
    if (token !== borderToken) return;                 // selection changed while loading
    const add = (data, pane, style) => borderLayers.push(
      L.geoJSON(data, { pane, renderer: L.canvas({ pane }), interactive: false, style }).addTo(map));
    if (a1) add(a1, "regions", { color: "#7FA3B3", weight: 0.9, fillColor: "#1D4152", fillOpacity: 1 });
    add(S.countryGeo.features.filter((f) => f.properties.id === iso), "outline",
      { color: "#EDF4F7", weight: 1.5, opacity: 0.85, fill: false });
    const st = stateId && a1 && a1.features.find((f) => f.properties.id === stateId);
    if (st) add(st, "outline", { color: "#E7AB20", weight: 2.5, fillColor: "#E7AB20", fillOpacity: 0.08 });
  }

  function drawCells() {
    const t0 = performance.now();
    const { c, s } = selectionIdx();
    const rows = S.cells.cells.filter((r) => (s >= 0 ? r[5] === s : c >= 0 ? r[4] === c : true));
    rows.sort((a, b) => a[3] - b[3]);                     // hottest drawn last = on top
    const scale = s >= 0 ? 1.4 : c >= 0 ? 1.0 : 0.42;     // fewer cells -> bigger circles
    if (layer) layer.remove();
    layer = L.featureGroup();
    for (const r of rows) {
      const m = L.circleMarker([r[0], r[1]], {
        renderer: canvas, stroke: false, fillOpacity: 0.78, fillColor: frpColour(r[3]),
        radius: Math.min(11, (2 + 1.1 * Math.sqrt(r[2])) * scale),
      });
      m.cell = r;
      layer.addLayer(m);
    }
    layer.on("mouseover", (e) => {
      const r = e.layer.cell;
      tip.setLatLng(e.latlng).setContent(
        "<strong>" + nf.format(r[2]) + " fire detections</strong><br>" + nf.format(Math.round(r[3])) + " MW total FRP");
      tip.addTo(map);
    });
    layer.on("mouseout", () => tip.remove());
    layer.addTo(map);

    if (rows.length) {
      let [la0, la1, lo0, lo1] = [90, -90, 180, -180];
      for (const r of rows) { la0 = Math.min(la0, r[0]); la1 = Math.max(la1, r[0]); lo0 = Math.min(lo0, r[1]); lo1 = Math.max(lo1, r[1]); }
      if (c < 0 && s < 0) map.fitBounds(WORLD, { animate: false });
      else map.fitBounds([[la0 - 0.3, lo0 - 0.3], [la1 + 0.3, lo1 + 0.3]], { padding: [24, 24], maxZoom: 8, animate: false });
    }
    S.lastDraw = { cells: rows.length, ms: Math.round(performance.now() - t0) };
    console.log("map: drew " + rows.length + " cells in " + S.lastDraw.ms + " ms");
  }


  // ---------- piece 3: priority table ----------
  S.sortKey = "priority_score";   // or "total_frp"
  const esc = (t) => String(t).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
  const SIGNAL = {                // word + arrow + colour, never colour alone
    "Rising": { arrow: "↑", cls: "up" },
    "Stable": { arrow: "→", cls: "flat" },
    "Falling": { arrow: "↓", cls: "down" },
    "Insufficient data": { arrow: "–", cls: "na" },
  };

  function signalCell(r) {
    const g = SIGNAL[r.trend_flag] || SIGNAL["Insufficient data"];
    let pct = "";
    if (r.trend_pct !== null) pct = " " + (r.trend_pct > 0 ? "+" : "") + Math.round(r.trend_pct) + "%";
    else if (r.trend_flag === "Rising") pct = " (no baseline)";
    return '<span class="sig ' + g.cls + '"><b aria-hidden="true">' + g.arrow + "</b> " + esc(r.trend_flag) + pct + "</span>";
  }

  // Rows shown: all countries worldwide, or the states of the selected country.
  function tableRows() {
    const rows = (S.sel.iso ? S.statesByIso.get(S.sel.iso) || [] : S.countries).slice();
    const k = S.sortKey, other = k === "total_frp" ? "priority_score" : "total_frp";
    // last tie-break = pipeline rank, so the table order matches the "Ranks #N" text in each summary
    rows.sort((a, b) => b[k] - a[k] || b[other] - a[other] || a.rank - b.rank);
    return rows;
  }

  function renderTable() {
    const rows = tableRows();
    const iso = S.sel.iso, country = iso ? S.byId.get(iso) : null;
    $("table-title").textContent = country
      ? "States and provinces in " + country.country + " with fire detections"
      : "Countries ranked worldwide";
    const th = (key, label, cls) => '<th scope="col" class="' + cls + (S.sortKey === key ? " sorted" : "") + '"' +
      (S.sortKey === key ? ' aria-sort="descending"' : "") + ">" + label + "</th>";
    let h = '<div class="table-tools"><div class="seg" role="group" aria-label="Sort the table by">' +
      '<span class="seg-label">Sort by</span>' +
      ["priority_score", "total_frp"].map((k) =>
        '<button type="button" data-sort="' + k + '" aria-pressed="' + (S.sortKey === k) + '">' +
        (k === "priority_score" ? "Priority score" : "Total FRP") + "</button>").join("") +
      '</div><span class="count">' + rows.length + (iso ? " states or provinces" : " countries") + "</span></div>";
    if (!rows.length) {
      h += '<p class="muted">No state-level detections for this country. Detections here count at country level only.</p>';
    } else {
      h += '<p class="scrollhint">Swipe the table sideways to see Priority score and Short-term signal.</p><div class="tscroll" id="tscroll" tabindex="0" role="region" aria-label="Priority table, scrollable"><table class="ptable"><thead><tr>' +
        '<th scope="col" class="num rk">Rank</th><th scope="col">Region</th>' +
        '<th scope="col" class="num det">Detections</th>' +
        th("total_frp", "Total FRP (MW)", "num") + th("priority_score", "Priority score", "num") +
        '<th scope="col">Short-term signal</th></tr></thead><tbody>';
      rows.forEach((r, i) => {
        const on = r.id === S.sel.stateId || (!iso && r.id === S.sel.iso);
        h += '<tr data-id="' + esc(r.id) + '"' + (on ? ' class="on" aria-selected="true"' : "") + ">" +
          '<td class="num rk">' + (i + 1) + "</td>" +
          '<td><button type="button" class="rname" data-id="' + esc(r.id) + '">' + esc(r.level === "state" ? r.state : r.country) + "</button></td>" +
          '<td class="num det">' + nf.format(r.fire_count) + "</td>" +
          '<td class="num' + (S.sortKey === "total_frp" ? " sorted" : "") + '">' + nf.format(Math.round(r.total_frp)) + "</td>" +
          '<td class="num' + (S.sortKey === "priority_score" ? " sorted" : "") + '">' + r.priority_score.toFixed(1) +
          ' <span class="tier t-' + r.tier.toLowerCase() + '">' + r.tier + "</span></td>" +
          "<td>" + signalCell(r) + "</td></tr>";
      });
      h += "</tbody></table></div>";
    }
    $("table-body").innerHTML = h;

    // keep the selected row visible inside the scroll box (without scrolling the page)
    const box = $("tscroll"), on = box && box.querySelector("tr.on");
    if (on) box.scrollTop = Math.max(0, on.offsetTop - box.clientHeight / 2);
  }

  function pickRegion(id) {
    const r = S.byId.get(id);
    if (!r) return;
    if (r.level === "country") {
      $("sel-country").value = r.iso_a3; onCountry();
    } else {
      $("sel-state").value = r.id; onState();
    }
  }

  function wireTable() {
    const body = $("table-body");
    body.addEventListener("click", (e) => {
      const sortBtn = e.target.closest("button[data-sort]");
      if (sortBtn) { S.sortKey = sortBtn.dataset.sort; renderTable(); return; }
      const row = e.target.closest("tr[data-id]");
      if (row) pickRegion(row.dataset.id);
    });
  }


  // ---------- piece 4: daily chart ----------
  let chart;
  const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
  const MON = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const dayLabel = (d) => MON[+d.slice(5, 7) - 1] + " " + d.slice(8, 10);

  // Series for the selection. World = sum of all country series (Unassigned is not in regions.json).
  function currentSeries() {
    const r = currentRegion();
    if (r) return r.series;
    const dates = S.meta.dates.all;
    return dates.map((d, i) => ({
      date: d,
      count: S.countries.reduce((a, c) => a + c.series[i].count, 0),
      frp: S.countries.reduce((a, c) => a + c.series[i].frp, 0),
    }));
  }

  function renderChart() {
    const body = $("chart-body");
    if (typeof Chart === "undefined") { body.innerHTML = '<p class="muted">Chart.js did not load (check your internet connection).</p>'; return; }
    const r = currentRegion();
    const name = r ? (r.level === "state" ? r.state + ", " + r.country : r.country) : "World (detections assigned to a country)";
    const series = currentSeries();
    const partial = new Set(S.meta.dates.partial);
    const isPart = (i) => partial.has(series[i].date);

    if (!chart) {
      body.innerHTML = '<p class="chart-sub" id="chart-sub"></p><div class="chart-box"><canvas id="chart" role="img"></canvas></div>';
      Chart.defaults.color = "#AAC0CD";
      Chart.defaults.font.family = '"Satoshi", system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif';
    }
    $("chart-sub").textContent = name;
    $("chart").setAttribute("aria-label", "Daily fire detections and total FRP for " + name);

    const dash = (ctx) => (isPart(ctx.p1DataIndex) ? [6, 5] : undefined);
    const mk = (label, key, colour, axis, shape) => ({
      label, data: series.map((p) => p[key]), yAxisID: axis,
      borderColor: colour, backgroundColor: colour, borderWidth: 2.5, tension: 0,
      pointStyle: shape, pointRadius: 5, pointHoverRadius: 7,
      pointBackgroundColor: (c) => (isPart(c.dataIndex) ? "#142F3D" : colour),   // hollow = partial
      pointBorderColor: colour, pointBorderWidth: 2,
      segment: { borderDash: dash },
    });
    const data = {
      labels: series.map((p, i) => (isPart(i) ? [p.date.slice(8), MON[+p.date.slice(5, 7) - 1], "partial"] : [p.date.slice(8), MON[+p.date.slice(5, 7) - 1]])),
      datasets: [
        mk("Fire detections", "count", "#E7AB20", "yCount", "circle"),
        mk("Total FRP (MW)", "frp", "#94C4E0", "yFrp", "rectRot"),
      ],
    };
    const options = {
      responsive: true, maintainAspectRatio: false, interaction: { mode: "index", intersect: false },
      animation: matchMedia("(prefers-reduced-motion: reduce)").matches ? false : { duration: 250 },
      plugins: {
        legend: { position: "bottom", labels: { usePointStyle: true, boxWidth: 10, padding: 16 } },
        tooltip: {
          backgroundColor: "#0D202B", borderColor: "#6D8998", borderWidth: 1, titleColor: "#EDF4F7", bodyColor: "#EDF4F7",
          callbacks: {
            title: (it) => series[it[0].dataIndex].date + (isPart(it[0].dataIndex) ? " (partial day, UTC)" : " (UTC)"),
            label: (c) => " " + c.dataset.label + ": " + nf.format(Math.round(c.parsed.y)),
          },
        },
      },
      scales: {
        x: { grid: { color: "rgba(54,83,98,.5)" }, ticks: { maxRotation: 0, autoSkip: false, font: { size: 11 } } },
        yCount: { position: "left", beginAtZero: true, grid: { color: "rgba(54,83,98,.5)" }, ticks: { color: "#F5CF65", callback: (v) => compact.format(v) },
                  title: { display: true, text: "Detections", color: "#F5CF65" } },
        yFrp: { position: "right", beginAtZero: true, grid: { drawOnChartArea: false }, ticks: { color: "#94C4E0", callback: (v) => compact.format(v) },
                title: { display: true, text: "FRP (MW)", color: "#94C4E0" } },
      },
    };
    if (chart) chart.destroy();
    chart = new Chart($("chart"), { type: "line", data, options });
  }


  // ---------- piece 5: summary box (bullets) ----------
  const rng = (a) => (a.length ? dayLabel(a[0]) + (a.length > 1 ? " to " + dayLabel(a[a.length - 1]) : "") : "n/a");
  const li = (label, text) => "<li><b>" + label + ":</b> " + text + "</li>";

  function signalText(r, m) {
    const win = " (" + rng(m.dates.trend_recent) + " vs " + rng(m.dates.trend_prior) + ")";
    if (r.trend_flag === "Insufficient data") return "Insufficient data (too few detections)";
    if (r.trend_pct === null) return "Rising (no detections in the prior days)" + win;
    return r.trend_flag + ", " + (r.trend_pct > 0 ? "+" : "") + Math.round(r.trend_pct) + "% average daily detections and FRP" + win;
  }

  function renderSummary() {
    const r = currentRegion(), m = S.meta, d = m.dates.all;
    const period = d[0] + " to " + d[d.length - 1] + " (UTC)";
    let h;
    if (r) {
      const where = r.level === "country" ? "countries" : "states or provinces in " + esc(r.country);
      h = '<p class="sum-name">' + esc(r.level === "state" ? r.state + ", " + r.country : r.country) + "</p>" +
        '<ul class="facts">' +
        li("Fire detections", nf.format(r.fire_count)) +
        li("Total FRP", nf.format(Math.round(r.total_frp)) + " MW") +
        li("Short-term signal", esc(signalText(r, m))) +
        li("Priority", "#" + r.rank + " of " + r.rank_of + " " + where + " (score " + r.priority_score.toFixed(1) +
          ' of 100, <span class="tier t-' + r.tier.toLowerCase() + '">' + r.tier + "</span>)") +
        li("Period", period) + "</ul>" +
        '<h3>Suggested checks</h3><ul class="checks">' + r.suggested_checks.map((t) => "<li>" + esc(t) + "</li>").join("") + "</ul>";
    } else {
      const n = { Rising: 0, Stable: 0, Falling: 0, "Insufficient data": 0 };
      S.countries.forEach((c) => { n[c.trend_flag]++; });
      const top = (k) => S.countries.slice().sort((a, b) => b[k] - a[k] || a.rank - b.rank).slice(0, 3).map((c) => c.country).join(", ");
      const assigned = S.countries.reduce((a, c) => a + c.fire_count, 0);
      h = '<p class="sum-name">World</p><ul class="facts">' +
        li("Fire detections", nf.format(assigned) + " assigned to a country") +
        li("Not assigned to any region", nf.format(m.unassigned.country_count) + " (" + m.unassigned.country_share_pct + "%)") +
        li("Short-term signal", n.Rising + " Rising, " + n.Stable + " Stable, " + n.Falling + " Falling, " + n["Insufficient data"] + " Insufficient data (" + S.countries.length + " countries)") +
        li("Highest priority score", esc(top("priority_score"))) +
        li("Highest total FRP", esc(top("total_frp"))) +
        li("Period", period) + "</ul>" +
        '<p class="muted">Choose a country, then a state or province, to see its summary and suggested checks.</p>';
    }
    $("summary-body").innerHTML = h;
  }

  // ---------- boot ----------
  async function init() {
    try {
      await load();
    } catch (e) { showError(e); console.error(e); return; }
    fillCountries();
    fillStates(null);
    if (!S.countryGeo) {
      showWarn("Map borders not found (data/borders/countries.json). Copy the data/borders folder from the zip into your project's data folder, " +
        "or run: python make_borders.py. Then hard-refresh the page (Ctrl+Shift+R).");
    }
    initMap();
    $("sel-country").addEventListener("change", onCountry);
    $("sel-state").addEventListener("change", onState);
    wireTable();
    renderSelection();
    window.EW = { S, nf, $, currentRegion, get map() { return map; } };   // shared with later pieces + tests
    document.dispatchEvent(new Event("ew-ready"));
  }
  init();
})();
