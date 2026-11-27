/* EmberWatch frontend. Reads data/meta.json, regions.json, cells.json only. */
(function () {
  "use strict";

  // ---------- app state ----------
  const S = {
    meta: null, regions: null, cells: null, countryGeo: null,
    byId: new Map(),            // region id -> region
    countries: [],              // country regions, A-Z
    statesByIso: new Map(),     // iso_a3 -> state regions, A-Z
    sel: { iso: null, stateId: null },
    frpBucketFilter: -1,        // -1 = all, 0..4 = specific FRP class
    basemap: "vector",          // "vector" | "satellite" | "terrain" | "nasa"
    aerosolEnabled: false,      // NASA GIBS Aerosol / Smoke Optical Depth overlay
    dayIdx: -1,                 // -1 = All days, 0..N-1 = single UTC day
    tableQuery: "",
    tableTier: "all",
    sortKey: "priority_score",  // or "total_frp"
    loadMs: null,
  };
  const $ = (id) => document.getElementById(id);
  const nf = new Intl.NumberFormat("en-US");
  const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
  const byName = (a, b) => a.localeCompare(b, "en");
  const esc = (t) => String(t == null ? "" : t).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));

  const isDarkTheme = () => document.documentElement.getAttribute("data-theme") === "dark";

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
      getJSON("data/borders/countries.json").catch(() => null),
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

  // ---------- dropdowns & URL hash sync ----------
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

  function syncUrlHash() {
    const params = new URLSearchParams();
    if (S.sel.iso) params.set("country", S.sel.iso);
    if (S.sel.stateId) params.set("state", S.sel.stateId);
    const hash = params.toString();
    const target = hash ? "#" + hash : window.location.pathname + window.location.search;
    history.replaceState(null, "", target);
  }

  function applyHashOnBoot() {
    if (!window.location.hash) return;
    const params = new URLSearchParams(window.location.hash.slice(1));
    const iso = params.get("country");
    const stateId = params.get("state");
    if (iso && S.byId.has(iso)) {
      $("sel-country").value = iso;
      S.sel.iso = iso;
      fillStates(iso);
      if (stateId && S.byId.has(stateId)) {
        $("sel-state").value = stateId;
        S.sel.stateId = stateId;
      }
    }
  }

  function onCountry() {
    const iso = $("sel-country").value || null;
    S.sel = { iso, stateId: null };
    fillStates(iso);
    syncUrlHash();
    renderSelection();
  }

  function onState() {
    S.sel.stateId = $("sel-state").value || null;
    syncUrlHash();
    renderSelection();
  }

  function currentRegion() {
    if (S.sel.stateId) return S.byId.get(S.sel.stateId);
    if (S.sel.iso) return S.byId.get(S.sel.iso);
    return null;
  }

  function renderSelection() {
    const r = currentRegion();
    $("selection-readout").textContent = r
      ? (r.level === "state" ? r.state + ", " + r.country : r.country) +
        " · " + nf.format(r.fire_count) + " fire detections"
      : "World · " + nf.format(S.meta.rows.kept) + " fire detections";
    if (map) { drawBorders(); drawCells(); }
    renderKPIs();
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

  // ---------- KPI Hero Strip ----------
  function buildSparklineSVG(series) {
    if (!series || !series.length) return "";
    const vals = series.map((d) => d.count);
    const max = Math.max(1, ...vals);
    const w = 96, h = 34, pad = 3;
    const pts = vals.map((v, i) => {
      const x = pad + (i / Math.max(1, vals.length - 1)) * (w - pad * 2);
      const y = h - pad - (v / max) * (h - pad * 2);
      return x.toFixed(1) + "," + y.toFixed(1);
    }).join(" ");
    return '<svg width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '">' +
      '<polyline fill="none" stroke="var(--peach)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" points="' + pts + '"/>' +
      '</svg>';
  }

  function renderKPIs() {
    const r = currentRegion();
    const series = currentSeries();
    const detEl = $("kpi-detections-val");
    const frpEl = $("kpi-frp-val");
    const sigEl = $("kpi-signal-val");
    [detEl, frpEl, sigEl].forEach((el) => el.classList.remove("skeleton-text"));

    if (r) {
      if (S.dayIdx >= 0 && r.series[S.dayIdx]) {
        const pt = r.series[S.dayIdx];
        detEl.textContent = nf.format(pt.count);
        $("kpi-detections-sub").textContent = (r.level === "state" ? r.state : r.country) + " on " + pt.date + " (UTC)";
        frpEl.textContent = compact.format(Math.round(pt.frp)) + " MW";
        $("kpi-frp-sub").textContent = pt.count ? ("Avg " + (pt.frp / pt.count).toFixed(1) + " MW/det (single day)") : "No detections this UTC day";
      } else {
        detEl.textContent = nf.format(r.fire_count);
        $("kpi-detections-sub").textContent = (r.level === "state" ? r.state : r.country) + " (" + S.meta.dates.all.length + "d window)";
        frpEl.textContent = compact.format(Math.round(r.total_frp)) + " MW";
        const avgFrp = r.fire_count ? (r.total_frp / r.fire_count).toFixed(1) : "0";
        $("kpi-frp-sub").textContent = "Avg " + avgFrp + " MW per detection";
      }

      $("kpi-signal-lbl").textContent = "Priority & Signal";
      const pct = r.trend_pct !== null ? " (" + (r.trend_pct > 0 ? "+" : "") + Math.round(r.trend_pct) + "%)" : "";
      sigEl.textContent = r.trend_flag + pct;
      $("kpi-signal-sub").textContent = "Rank #" + r.rank + " of " + r.rank_of + " · Score " + r.priority_score.toFixed(1) + " (" + r.tier + ")";
    } else {
      const assignedCount = S.dayIdx >= 0
        ? S.countries.reduce((a, c) => a + (c.series[S.dayIdx]?.count || 0), 0)
        : S.countries.reduce((a, c) => a + c.fire_count, 0);
      const worldFrp = S.dayIdx >= 0
        ? S.countries.reduce((a, c) => a + (c.series[S.dayIdx]?.frp || 0), 0)
        : S.countries.reduce((a, c) => a + c.total_frp, 0);
      const rising = S.countries.filter((c) => c.trend_flag === "Rising").length;
      const topC = S.countries.slice().sort((a, b) => b.priority_score - a.priority_score)[0];

      detEl.textContent = S.dayIdx >= 0 ? compact.format(assignedCount) : compact.format(S.meta.rows.kept);
      $("kpi-detections-sub").textContent = S.dayIdx >= 0
        ? ("Assigned detections on " + S.meta.dates.all[S.dayIdx] + " (UTC)")
        : (nf.format(assignedCount) + " assigned across " + S.countries.length + " countries");
      frpEl.textContent = compact.format(Math.round(worldFrp)) + " MW";
      $("kpi-frp-sub").textContent = "NOAA-20 + NOAA-21 VIIRS 375m";

      $("kpi-signal-lbl").textContent = "Global Escalations";
      sigEl.textContent = rising + " Rising";
      $("kpi-signal-sub").textContent = topC ? ("#1 Priority: " + topC.country + " (" + topC.priority_score.toFixed(0) + "/100)") : "World screening";
    }
    $("kpi-sparkline").innerHTML = buildSparklineSVG(series);
  }

  // ---------- piece 2: map ----------
  const EMBER_LIGHT = ["#F59E0B", "#FF7A59", "#EA4335", "#C5221F", "#7A0C22"];
  const EMBER_DARK  = ["#B8800B", "#E7AB20", "#F08A2B", "#E2503C", "#FFF1C9"];
  const currentEmber = () => (isDarkTheme() ? EMBER_DARK : EMBER_LIGHT);
  let map, canvas, layer, landLayer, tileLayer, aerosolLayer, tip, frpBreaks = [], lastBoundsRows = [];
  const WORLD = [[-52, -140], [72, 160]];

  function quantile(sorted, q) { return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]; }
  const frpBucket = (v) => frpBreaks.filter((b) => v >= b).length;
  const frpColour = (v) => currentEmber()[frpBucket(v)];

  function dayChoroplethColor(frp) {
    if (frp <= 0) return null;
    if (frp > 10000) return "#B91C1C";
    if (frp > 2500)  return "#EA4335";
    if (frp > 500)   return "#FF7A59";
    return "#F59E0B";
  }

  function activeGibsDate() {
    if (!S.meta || !S.meta.dates) return "2026-11-14";
    if (S.dayIdx >= 0 && S.meta.dates.all[S.dayIdx]) return S.meta.dates.all[S.dayIdx];
    const comp = S.meta.dates.complete;
    return (comp && comp.length ? comp[comp.length - 1] : S.meta.dates.all[0]);
  }

  function landStyle(feature) {
    const dark = isDarkTheme();
    const isVec = S.basemap === "vector";
    if (S.dayIdx >= 0 && feature && feature.properties) {
      const reg = S.byId.get(feature.properties.id);
      const frp = reg && reg.series[S.dayIdx] ? reg.series[S.dayIdx].frp : 0;
      const col = dayChoroplethColor(frp);
      if (col) {
        return {
          color: dark ? "#2F4A59" : "#D8C7B8",
          weight: 0.8,
          fillColor: col,
          fillOpacity: isVec ? 0.55 : 0.32,
        };
      }
    }
    if (!isVec) {
      const lightSpace = S.basemap === "satellite" || S.basemap === "nasa";
      return {
        color: lightSpace ? "rgba(255, 255, 255, 0.50)" : "rgba(42, 33, 29, 0.45)",
        weight: 0.9,
        fillOpacity: 0,
      };
    }
    return dark
      ? { color: "#2F4A59", weight: 0.7, fillColor: "#132C3A", fillOpacity: 1 }
      : { color: "#D8C7B8", weight: 0.8, fillColor: "#EDE4DA", fillOpacity: 1 };
  }

  function setBasemap(mode) {
    S.basemap = mode;
    document.querySelectorAll(".bm-btn").forEach((b) =>
      b.setAttribute("aria-pressed", b.dataset.basemap === mode ? "true" : "false")
    );
    if (tileLayer) { tileLayer.remove(); tileLayer = null; }
    if (mode === "satellite") {
      tileLayer = L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
        attribution: "Imagery &copy; Esri", maxZoom: 17, zIndex: 100
      }).addTo(map);
    } else if (mode === "terrain") {
      tileLayer = L.tileLayer("https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png", {
        attribution: "Terrain &copy; OpenTopoMap", maxZoom: 17, zIndex: 100
      }).addTo(map);
    } else if (mode === "nasa") {
      const d = activeGibsDate();
      tileLayer = L.tileLayer(
        "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_NOAA20_CorrectedReflectance_TrueColor/default/" +
        d + "/GoogleMapsCompatible_Level9/{z}/{y}/{x}.jpg",
        { attribution: "Imagery &copy; NASA GIBS (" + d + ")", maxNativeZoom: 9, maxZoom: 14, zIndex: 100 }
      ).addTo(map);
    }
    if (landLayer) landLayer.setStyle(landStyle);
    drawBorders();
  }

  function updateAerosolLayer() {
    if (aerosolLayer) { aerosolLayer.remove(); aerosolLayer = null; }
    if (!S.aerosolEnabled || !map) return;
    const d = activeGibsDate();
    aerosolLayer = L.tileLayer(
      "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/MODIS_Combined_Value_Added_AOD/default/" +
      d + "/GoogleMapsCompatible_Level6/{z}/{y}/{x}.png",
      { attribution: "Smoke AOD &copy; NASA GIBS (" + d + ")", maxNativeZoom: 6, maxZoom: 14, opacity: 0.65, zIndex: 350 }
    ).addTo(map);
  }

  function initMap() {
    map = L.map("map", { worldCopyJump: true, minZoom: 1, maxZoom: 10, zoomSnap: 0.25, preferCanvas: true })
      .fitBounds(WORLD);
    map.attributionControl.addAttribution("Boundaries: Natural Earth");
    [["land", 210], ["regions", 220], ["outline", 450]].forEach(([n, z]) => {
      const p = map.createPane(n); p.style.zIndex = z; p.style.pointerEvents = "none";
    });
    if (S.countryGeo) {
      landLayer = L.geoJSON(S.countryGeo, {
        pane: "land", renderer: L.canvas({ pane: "land" }), interactive: false, style: landStyle,
      }).addTo(map);
    }
    canvas = L.canvas({ padding: 0.5 });
    tip = L.tooltip({ direction: "top", offset: [0, -6], className: "ew-tip" });

    const f = S.cells.cells.map((c) => c[3]).sort((a, b) => a - b);
    frpBreaks = [0.2, 0.5, 0.8, 0.95].map((q) => quantile(f, q));
    renderLegend();
  }

  function renderLegend() {
    const r = (v) => (v < 10 ? v.toFixed(1) : Math.round(v));
    const labels = [
      "< " + r(frpBreaks[0]),
      r(frpBreaks[0]) + "–" + r(frpBreaks[1]),
      r(frpBreaks[1]) + "–" + r(frpBreaks[2]),
      r(frpBreaks[2]) + "–" + r(frpBreaks[3]),
      r(frpBreaks[3]) + "+",
    ];
    const palette = currentEmber();
    const chips = ['<button type="button" class="lg-chip" data-bucket="-1" aria-pressed="' + (S.frpBucketFilter === -1) + '">All</button>']
      .concat(palette.map((c, i) =>
        '<button type="button" class="lg-chip" data-bucket="' + i + '" aria-pressed="' + (S.frpBucketFilter === i) + '">' +
        '<i style="background:' + c + '"></i>' + labels[i] + '</button>'
      )).join("");

    $("map-legend").innerHTML =
      '<div class="lg-head"><span class="lg-title">Total FRP (MW) · Click to filter</span>' +
      '<span class="lg-hint">Click any cell to inspect smoke</span></div>' +
      '<div class="lg-row">' + chips + "</div>" +
      '<div class="lg-note">0.25&deg; grid cell (~28 km). Circle radius scales with detection count.</div>';
  }

  function wireLegend() {
    $("map-legend").addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-bucket]");
      if (!btn) return;
      const b = parseInt(btn.dataset.bucket, 10);
      S.frpBucketFilter = (S.frpBucketFilter === b && b !== -1) ? -1 : b;
      renderLegend();
      drawCells(false);
    });
  }

  function selectionIdx() {
    const { iso, stateId } = S.sel;
    return {
      c: iso ? S.cells.countries.indexOf(iso) : -1,
      s: stateId ? S.cells.states.indexOf(stateId) : -1,
    };
  }

  // ---------- borders for the selection ----------
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
    if (token !== borderToken) return;
    const add = (data, pane, style) => borderLayers.push(
      L.geoJSON(data, { pane, renderer: L.canvas({ pane }), interactive: false, style }).addTo(map));

    const dark = isDarkTheme();
    const isVec = S.basemap === "vector";
    if (a1) {
      add(a1, "regions", (feature) => {
        if (S.dayIdx >= 0 && feature && feature.properties) {
          const reg = S.byId.get(feature.properties.id);
          const frp = reg && reg.series[S.dayIdx] ? reg.series[S.dayIdx].frp : 0;
          const col = dayChoroplethColor(frp);
          if (col) return { color: dark ? "#7FA3B3" : "#CBB7A6", weight: 0.9, fillColor: col, fillOpacity: isVec ? 0.62 : 0.42 };
        }
        return dark
          ? { color: "#7FA3B3", weight: 0.9, fillColor: "#1D4152", fillOpacity: isVec ? 1 : 0 }
          : { color: "#CBB7A6", weight: 0.9, fillColor: "#E5DAD0", fillOpacity: isVec ? 1 : 0 };
      });
    }
    add(S.countryGeo.features.filter((f) => f.properties.id === iso), "outline",
      { color: (dark || S.basemap === "satellite" || S.basemap === "nasa") ? "#EDF4F7" : "#2A211D", weight: 1.6, opacity: 0.8, fill: false });
    const st = stateId && a1 && a1.features.find((f) => f.properties.id === stateId);
    if (st) add(st, "outline",
      { color: "#FF6F59", weight: 2.5, fillColor: "#FF6F59", fillOpacity: 0.14 });
  }

  function drawCells(fitView = true) {
    const t0 = performance.now();
    const { c, s } = selectionIdx();
    let rows = S.cells.cells.filter((r) => (s >= 0 ? r[5] === s : c >= 0 ? r[4] === c : true));
    if (S.frpBucketFilter >= 0) {
      rows = rows.filter((r) => frpBucket(r[3]) === S.frpBucketFilter);
    }
    rows.sort((a, b) => a[3] - b[3]);
    const scale = s >= 0 ? 1.4 : c >= 0 ? 1.0 : 0.44;
    if (layer) layer.remove();
    layer = L.featureGroup();
    for (const r of rows) {
      const m = L.circleMarker([r[0], r[1]], {
        renderer: canvas, stroke: false, fillOpacity: 0.80, fillColor: frpColour(r[3]),
        radius: Math.min(11, (2 + 1.1 * Math.sqrt(r[2])) * scale),
      });
      m.cell = r;
      layer.addLayer(m);
    }
    layer.on("mouseover", (e) => {
      const r = e.layer.cell;
      tip.setLatLng(e.latlng).setContent(
        "<strong>" + nf.format(r[2]) + " fire detections</strong><br>" +
        nf.format(Math.round(r[3])) + " MW total FRP<br>" +
        "<span style='opacity:0.75;font-size:11px'>Click cell for live smoke &amp; weather</span>"
      );
      tip.addTo(map);
    });
    layer.on("mouseout", () => tip.remove());
    layer.on("click", (e) => {
      L.DomEvent.stopPropagation(e);
      const r = e.layer.cell;
      const cName = r[4] >= 0 ? S.cells.countries[r[4]] : "Unassigned";
      const sName = r[5] >= 0 ? S.cells.states[r[5]].replace(/^[^|]+\|/, "") : cName;
      document.dispatchEvent(new CustomEvent("ew-cell-inspect", {
        detail: { lat: r[0], lon: r[1], count: r[2], frp: r[3], label: sName + " cell", cell: r }
      }));
    });
    layer.addTo(map);

    lastBoundsRows = rows;
    if (fitView && rows.length) fitCurrentBounds();
    S.lastDraw = { cells: rows.length, ms: Math.round(performance.now() - t0) };
  }

  function fitCurrentBounds() {
    const { c, s } = selectionIdx();
    if (c < 0 && s < 0) { map.fitBounds(WORLD, { animate: true }); return; }
    const rows = lastBoundsRows.length ? lastBoundsRows : S.cells.cells.filter((r) => (s >= 0 ? r[5] === s : r[4] === c));
    if (!rows.length) { map.fitBounds(WORLD, { animate: true }); return; }
    let [la0, la1, lo0, lo1] = [90, -90, 180, -180];
    for (const r of rows) { la0 = Math.min(la0, r[0]); la1 = Math.max(la1, r[0]); lo0 = Math.min(lo0, r[1]); lo1 = Math.max(lo1, r[1]); }
    map.fitBounds([[la0 - 0.3, lo0 - 0.3], [la1 + 0.3, lo1 + 0.3]], { padding: [26, 26], maxZoom: 8, animate: true });
  }

  // ---------- piece 3: priority table ----------
  const SIGNAL = {
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

  function tableRows() {
    let rows = (S.sel.iso ? S.statesByIso.get(S.sel.iso) || [] : S.countries).slice();
    const k = S.sortKey, other = k === "total_frp" ? "priority_score" : "total_frp";
    rows.sort((a, b) => b[k] - a[k] || b[other] - a[other] || a.rank - b.rank);
    if (S.tableTier !== "all") {
      rows = rows.filter((r) => r.tier === S.tableTier);
    }
    if (S.tableQuery.trim()) {
      const q = S.tableQuery.trim().toLowerCase();
      rows = rows.filter((r) => ((r.level === "state" ? r.state : r.country) || "").toLowerCase().includes(q));
    }
    return rows;
  }

  function renderTable() {
    const rows = tableRows();
    const iso = S.sel.iso, country = iso ? S.byId.get(iso) : null;
    $("table-title").textContent = country
      ? "States & provinces in " + country.country
      : "Countries ranked worldwide";
    $("table-quick-filters").hidden = false;

    const th = (key, label, cls) => '<th scope="col" class="' + cls + (S.sortKey === key ? " sorted" : "") + '"' +
      (S.sortKey === key ? ' aria-sort="descending"' : "") + ">" + label + "</th>";
    let h = '<div class="table-tools"><div class="seg" role="group" aria-label="Sort the table by">' +
      '<span class="seg-label">Sort</span>' +
      ["priority_score", "total_frp"].map((k) =>
        '<button type="button" data-sort="' + k + '" aria-pressed="' + (S.sortKey === k) + '">' +
        (k === "priority_score" ? "Priority score" : "Total FRP") + "</button>").join("") +
      '</div><span class="count">' + rows.length + (iso ? " states/provinces" : " countries") + "</span></div>";

    if (!rows.length) {
      h += '<p class="muted">No matching regions for the active filter.</p>';
    } else {
      h += '<p class="scrollhint">Swipe table sideways to see all columns.</p><div class="tscroll" id="tscroll" tabindex="0" role="region" aria-label="Priority table"><table class="ptable"><thead><tr>' +
        '<th scope="col" class="num rk">#</th><th scope="col">Region</th>' +
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

    const box = $("tscroll"), on = box && box.querySelector("tr.on");
    if (on) box.scrollTop = Math.max(0, on.offsetTop - box.clientHeight / 2);
  }

  function pickRegion(id) {
    const r = S.byId.get(id);
    if (!r) return;
    if (r.level === "country") {
      $("sel-country").value = r.iso_a3;
      S.sel = { iso: r.iso_a3, stateId: null };
      fillStates(r.iso_a3);
    } else {
      $("sel-country").value = r.iso_a3;
      S.sel = { iso: r.iso_a3, stateId: r.id };
      fillStates(r.iso_a3);
      $("sel-state").value = r.id;
    }
    syncUrlHash();
    renderSelection();
  }

  function wireTable() {
    $("table-body").addEventListener("click", (e) => {
      const sortBtn = e.target.closest("button[data-sort]");
      if (sortBtn) { S.sortKey = sortBtn.dataset.sort; renderTable(); return; }
      const row = e.target.closest("tr[data-id]");
      if (row) pickRegion(row.dataset.id);
    });

    $("table-filter-input").addEventListener("input", (e) => {
      S.tableQuery = e.target.value;
      renderTable();
    });

    $("table-quick-filters").addEventListener("click", (e) => {
      const pill = e.target.closest("button[data-tier]");
      if (!pill) return;
      S.tableTier = pill.dataset.tier;
      document.querySelectorAll(".tier-pill").forEach((b) =>
        b.setAttribute("aria-pressed", b === pill ? "true" : "false")
      );
      renderTable();
    });
  }

  // ---------- piece 4: daily chart ----------
  let chart;
  const MON = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const dayLabel = (d) => MON[+d.slice(5, 7) - 1] + " " + d.slice(8, 10);

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
    if (typeof Chart === "undefined") {
      body.innerHTML = '<p class="muted">Chart.js did not load (check internet connection).</p>'; return;
    }
    const r = currentRegion();
    const name = r ? (r.level === "state" ? r.state + ", " + r.country : r.country) : "World (detections assigned to a country)";
    const series = currentSeries();
    const partial = new Set(S.meta.dates.partial);
    const isPart = (i) => partial.has(series[i].date);
    const dark = isDarkTheme();

    if (!chart || !$("chart")) {
      body.innerHTML = '<p class="chart-sub" id="chart-sub"></p><div class="chart-box"><canvas id="chart" role="img"></canvas></div>';
    }
    Chart.defaults.color = dark ? "#9FB8C6" : "#685850";
    Chart.defaults.font.family = '"Satoshi", system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif';

    $("chart-sub").textContent = name;
    $("chart").setAttribute("aria-label", "Daily fire detections and total FRP for " + name);

    const dash = (ctx) => (isPart(ctx.p1DataIndex) ? [6, 5] : undefined);
    const hollowBg = dark ? "#122734" : "#FFFFFF";
    const mk = (label, key, colour, axis, shape) => ({
      label, data: series.map((p) => p[key]), yAxisID: axis,
      borderColor: colour, backgroundColor: colour, borderWidth: 2.5, tension: 0.15,
      pointStyle: shape,
      pointRadius: (c) => (c.dataIndex === S.dayIdx ? 8 : 5),
      pointHoverRadius: 8,
      pointBackgroundColor: (c) => (c.dataIndex === S.dayIdx ? "#FF6F59" : (isPart(c.dataIndex) ? hollowBg : colour)),
      pointBorderColor: colour, pointBorderWidth: 2,
      segment: { borderDash: dash },
    });
    const gridCol = dark ? "rgba(78, 118, 138, 0.35)" : "rgba(225, 200, 186, 0.55)";
    const countCol = dark ? "#FF8266" : "#E04B35";
    const frpCol   = dark ? "#57B8BE" : "#217A79";

    const data = {
      labels: series.map((p, i) => (isPart(i) ? [p.date.slice(8), MON[+p.date.slice(5, 7) - 1], "partial"] : [p.date.slice(8), MON[+p.date.slice(5, 7) - 1]])),
      datasets: [
        mk("Fire detections", "count", countCol, "yCount", "circle"),
        mk("Total FRP (MW)", "frp", frpCol, "yFrp", "rectRot"),
      ],
    };
    const options = {
      responsive: true, maintainAspectRatio: false, interaction: { mode: "index", intersect: false },
      animation: matchMedia("(prefers-reduced-motion: reduce)").matches ? false : { duration: 240 },
      plugins: {
        legend: { position: "bottom", labels: { usePointStyle: true, boxWidth: 10, padding: 14, color: dark ? "#9FB8C6" : "#685850" } },
        tooltip: {
          backgroundColor: dark ? "rgba(13, 30, 40, 0.96)" : "rgba(255, 252, 248, 0.96)",
          borderColor: "rgba(255, 111, 89, 0.4)", borderWidth: 1,
          titleColor: dark ? "#FFF" : "#1B1411", bodyColor: dark ? "#E9F1F5" : "#2A211D",
          padding: 10, cornerRadius: 10,
          callbacks: {
            title: (it) => series[it[0].dataIndex].date + (isPart(it[0].dataIndex) ? " (partial day, UTC)" : " (UTC)"),
            label: (c) => " " + c.dataset.label + ": " + nf.format(Math.round(c.parsed.y)),
          },
        },
      },
      scales: {
        x: { grid: { color: gridCol }, ticks: { maxRotation: 0, autoSkip: false, font: { size: 11 } } },
        yCount: { position: "left", beginAtZero: true, grid: { color: gridCol }, ticks: { color: countCol, callback: (v) => compact.format(v) },
                  title: { display: true, text: "Detections", color: countCol } },
        yFrp: { position: "right", beginAtZero: true, grid: { drawOnChartArea: false }, ticks: { color: frpCol, callback: (v) => compact.format(v) },
                title: { display: true, text: "FRP (MW)", color: frpCol } },
      },
    };
    if (chart) chart.destroy();
    chart = new Chart($("chart"), { type: "line", data, options });
  }

  // ---------- piece 5: summary box ----------
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
        li("Period", period) + "</ul>";
    } else {
      const n = { Rising: 0, Stable: 0, Falling: 0, "Insufficient data": 0 };
      S.countries.forEach((c) => { n[c.trend_flag]++; });
      const top = (k) => S.countries.slice().sort((a, b) => b[k] - a[k] || a.rank - b.rank).slice(0, 3).map((c) => c.country).join(", ");
      const assigned = S.countries.reduce((a, c) => a + c.fire_count, 0);
      h = '<p class="sum-name">World Overview</p><ul class="facts">' +
        li("Fire detections", nf.format(assigned) + " assigned to a country") +
        li("Not assigned", nf.format(m.unassigned.country_count) + " (" + m.unassigned.country_share_pct + "%)") +
        li("Short-term signal", n.Rising + " Rising, " + n.Stable + " Stable, " + n.Falling + " Falling, " + n["Insufficient data"] + " Insufficient data") +
        li("Highest priority", esc(top("priority_score"))) +
        li("Highest total FRP", esc(top("total_frp"))) +
        li("Period", period) + "</ul>" +
        '<p class="muted" style="font-size:13px">Select a country or state, or click any map circle to inspect live air quality &amp; smoke drift.</p>';
    }
    $("summary-body").innerHTML = h;
  }

  // ---------- Unified Command Search ----------
  function wireCommandSearch() {
    const input = $("cmd-search-input");
    const drop = $("cmd-search-results");
    let currentMatches = [];

    document.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        input.focus();
        input.select();
      } else if (e.key === "Escape") {
        drop.hidden = true;
      }
    });

    function renderDropdown() {
      const q = input.value.trim();
      if (!q) { drop.hidden = true; return; }
      const ql = q.toLowerCase();
      currentMatches = [];
      for (const r of S.regions) {
        const label = r.level === "state" ? (r.state + ", " + r.country) : r.country;
        if (label.toLowerCase().includes(ql)) {
          currentMatches.push({ type: "region", id: r.id, label, sub: r.level === "state" ? "State · #" + r.rank : "Country · #" + r.rank, score: r.fire_count });
        }
      }
      currentMatches.sort((a, b) => b.score - a.score);
      currentMatches = currentMatches.slice(0, 7);

      let html = currentMatches.map((m, idx) =>
        '<button type="button" class="cmd-item" data-idx="' + idx + '">' +
        '<span>' + esc(m.label) + '</span>' +
        '<span class="cmd-item-tag">' + esc(m.sub) + '</span></button>'
      ).join("");
      html += '<button type="button" class="cmd-item cmd-item-osm" data-osm="' + esc(q) + '">' +
        '<span>Screen place "' + esc(q) + '" in Proximity Check</span>' +
        '<span class="cmd-item-tag">OSM Search</span></button>';
      drop.innerHTML = html;
      drop.hidden = false;
    }

    input.addEventListener("input", renderDropdown);
    input.addEventListener("focus", () => { if (input.value.trim()) renderDropdown(); });

    drop.addEventListener("click", (e) => {
      const btn = e.target.closest(".cmd-item");
      if (!btn) return;
      if (btn.dataset.osm) {
        const query = btn.dataset.osm;
        drop.hidden = true;
        input.value = "";
        document.dispatchEvent(new CustomEvent("ew-jump-place", { detail: { query } }));
      } else if (btn.dataset.idx !== undefined) {
        const item = currentMatches[parseInt(btn.dataset.idx, 10)];
        drop.hidden = true;
        input.value = "";
        if ($("btn-mode-proximity").getAttribute("aria-pressed") === "true") {
          $("btn-mode-region").click();
        }
        pickRegion(item.id);
      }
    });

    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !drop.hidden) {
        e.preventDefault();
        const first = drop.querySelector(".cmd-item");
        if (first) first.click();
      }
    });

    document.addEventListener("click", (e) => {
      if (!e.target.closest(".cmd-search-wrap")) drop.hidden = true;
    });
  }

  // ---------- Inspector Tabs & Theme Toggle ----------
  function activateTab(tabId) {
    const mapTab = {
      "tab-btn-overview": "pane-overview",
      "tab-btn-evs": "pane-evs",
      "tab-btn-field": "pane-field",
      "tab-btn-checks": "pane-checks",
    };
    Object.entries(mapTab).forEach(([btnId, paneId]) => {
      const on = btnId === tabId;
      $(btnId).setAttribute("aria-selected", on ? "true" : "false");
      $(paneId).hidden = !on;
    });
  }

  function wireTabsAndTheme() {
    document.querySelector(".inspector-tabs").addEventListener("click", (e) => {
      const btn = e.target.closest("button[role='tab']");
      if (btn) activateTab(btn.id);
    });

    const saved = localStorage.getItem("ew-theme") || "peach";
    applyTheme(saved, false);

    $("btn-theme-toggle").addEventListener("click", () => {
      const next = isDarkTheme() ? "peach" : "dark";
      applyTheme(next, true);
    });

    $("btn-fit-world").addEventListener("click", () => fitCurrentBounds());
  }

  // ---------- Timeline Scrubber & Basemap Wiring ----------
  let tlTimer = null;
  function setTimelineDay(idx) {
    const dates = S.meta.dates.all;
    const partial = new Set(S.meta.dates.partial);
    S.dayIdx = idx;
    $("tl-slider").value = String(idx);
    $("btn-tl-reset").hidden = (idx < 0);
    if (idx < 0) {
      $("tl-label").textContent = "All Days";
    } else {
      const d = dates[idx];
      $("tl-label").textContent = dayLabel(d) + (partial.has(d) ? " (Part)" : "");
    }
    if (landLayer) landLayer.setStyle(landStyle);
    if (S.basemap === "nasa") setBasemap("nasa");
    if (S.aerosolEnabled) updateAerosolLayer();
    drawBorders();
    renderKPIs();
    renderChart();
    document.dispatchEvent(new CustomEvent("ew-day-change", { detail: { dayIdx: idx } }));
  }

  function stopTimelinePlay() {
    if (tlTimer) { clearInterval(tlTimer); tlTimer = null; }
    $("tl-icon-play").hidden = false;
    $("tl-icon-pause").hidden = true;
  }

  function wireTimelineAndBasemap() {
    const dates = S.meta.dates.all;
    const slider = $("tl-slider");
    slider.max = String(dates.length - 1);
    slider.addEventListener("input", (e) => {
      stopTimelinePlay();
      setTimelineDay(parseInt(e.target.value, 10));
    });
    $("btn-tl-reset").addEventListener("click", () => {
      stopTimelinePlay();
      setTimelineDay(-1);
    });
    $("btn-tl-play").addEventListener("click", () => {
      if (tlTimer) { stopTimelinePlay(); return; }
      $("tl-icon-play").hidden = true;
      $("tl-icon-pause").hidden = false;
      let cur = S.dayIdx < 0 ? 0 : S.dayIdx;
      setTimelineDay(cur);
      tlTimer = setInterval(() => {
        cur = (cur + 1) % dates.length;
        setTimelineDay(cur);
      }, 1200);
    });

    document.querySelector(".basemap-seg").addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-basemap]");
      if (btn) setBasemap(btn.dataset.basemap);
    });

    const aodBtn = $("btn-toggle-aerosol");
    if (aodBtn) {
      aodBtn.addEventListener("click", () => {
        S.aerosolEnabled = !S.aerosolEnabled;
        aodBtn.setAttribute("aria-pressed", S.aerosolEnabled ? "true" : "false");
        updateAerosolLayer();
      });
    }
  }

  function applyTheme(theme, redraw) {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("ew-theme", theme);
    $("icon-theme-moon").hidden = (theme === "dark");
    $("icon-theme-sun").hidden = (theme !== "dark");
    if (redraw && map) {
      if (landLayer) landLayer.setStyle(landStyle);
      drawBorders();
      renderLegend();
      if ($("btn-mode-proximity").getAttribute("aria-pressed") !== "true") drawCells(false);
      renderChart();
    }
  }

  // ---------- boot ----------
  async function init() {
    try {
      await load();
    } catch (e) { showError(e); console.error(e); return; }
    fillCountries();
    fillStates(null);
    applyHashOnBoot();
    if (!S.countryGeo) {
      showWarn("Map borders not found (data/borders/countries.json). Run python make_borders.py and refresh.");
    }
    initMap();
    wireLegend();
    wireTabsAndTheme();
    wireTimelineAndBasemap();
    wireCommandSearch();
    $("sel-country").addEventListener("change", onCountry);
    $("sel-state").addEventListener("change", onState);
    wireTable();
    renderSelection();

    window.EW = {
      S, nf, compact, esc, $, currentRegion, currentSeries, frpColour, frpBreaks,
      drawCells, drawBorders, pickRegion, tableRows, activateTab, renderSelection, setBasemap,
      get EMBER() { return currentEmber(); },
      get map() { return map; }, get canvas() { return canvas; },
      get layer() { return layer; }, set layer(l) { layer = l; },
    };
    document.dispatchEvent(new Event("ew-ready"));
  }
  init();
})();
