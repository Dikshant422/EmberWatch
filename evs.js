/* evs.js - Environmental Studies (EVS) Fire Science, Smoke Plume & Reporting Module */
(function () {
  "use strict";

  const DEG2RAD = Math.PI / 180;
  const RAD2DEG = 180 / Math.PI;
  const R_EARTH = 6371.0;

  const E = {
    windEnabled: true,
    smokeLayer: null,
    lastTarget: null,      // { lat, lon, label, frp, count }
    lastWeather: null,     // { aqi, pm25, pm10, co, temp, rh, windSpeed, windDir, time }
    cache: new Map(),      // "lat,lon" -> weather payload
    proxResult: null,      // latest proximity result if in proximity mode
  };

  // --- Scientific Screening Estimator (Wooster et al., 2005; Akagi et al., 2011) ---
  // Conservative screening assumption: 1 hour (3,600 s) effective radiation per observation sum.
  function estimateEmissions(totalFrpMw) {
    const frp = Math.max(0, Number(totalFrpMw) || 0);
    const freMJ = frp * 3600;               // MJ
    const biomassKg = freMJ * 0.368;        // Wooster et al. (0.368 kg dry matter / MJ)
    const co2Tonnes = (biomassKg * 1.60) / 1000;
    const coTonnes = (biomassKg * 0.090) / 1000;
    const pm25Tonnes = (biomassKg * 0.012) / 1000;
    const carDays = Math.round((co2Tonnes * 1000) / 12.6); // ~12.6 kg CO2/day avg vehicle
    return {
      biomassTonnes: biomassKg / 1000,
      co2Tonnes,
      coTonnes,
      pm25Tonnes,
      carDays,
    };
  }

  function updateCarbonAndKPIs(totalFrpMw, scopeLabel) {
    const EW = window.EW;
    if (!EW) return;
    const est = estimateEmissions(totalFrpMw);

    const kpiVal = EW.$("kpi-emissions-val");
    const kpiSub = EW.$("kpi-emissions-sub");
    if (kpiVal && kpiSub) {
      kpiVal.classList.remove("skeleton-text");
      kpiVal.textContent = EW.compact.format(Math.round(est.co2Tonnes)) + " t CO₂";
      kpiSub.textContent = "~" + EW.compact.format(Math.round(est.pm25Tonnes)) + " t PM2.5 · " + scopeLabel;
    }

    const box = EW.$("evs-carbon-box");
    if (box) {
      box.innerHTML =
        '<div class="evs-card">' +
        '<div class="evs-card-title"><span>Emissions Screening (SDG 13)</span><span>Est.</span></div>' +
        '<div class="evs-stat-grid">' +
        '<div class="evs-mini"><div class="v">' + EW.compact.format(Math.round(est.co2Tonnes)) + ' t</div><div class="l">Est. CO₂</div></div>' +
        '<div class="evs-mini"><div class="v">' + EW.compact.format(Math.round(est.pm25Tonnes)) + ' t</div><div class="l">Est. PM2.5 Smoke</div></div>' +
        '<div class="evs-mini"><div class="v">' + EW.compact.format(Math.round(est.biomassTonnes)) + ' t</div><div class="l">Dry Biomass</div></div>' +
        '<div class="evs-mini"><div class="v">' + EW.compact.format(est.carDays) + '</div><div class="l">Car-Days Equiv.</div></div>' +
        '</div>' +
        '<p class="muted" style="font-size:11.5px;margin:8px 0 0;line-height:16px">' +
        'Screening approximation from FRP (Wooster 0.368 kg/MJ × 1h/obs, Akagi emission factors). Not a verified inventory.' +
        '</p></div>';
    }
  }

  // --- Checks & Limitations Tab ---
  function renderChecksTab(region, proxInfo) {
    const EW = window.EW;
    const box = EW.$("evs-checks-body");
    if (!EW || !box) return;
    const m = EW.S.meta;

    let h = '<h3>Suggested Field Checks</h3><ul class="checks">';
    if (proxInfo) {
      if (proxInfo.totalFRP > 5000) {
        h += '<li>High fire detections near target. Verify highway visibility, local advisories, and wind-blown smoke drift.</li>';
        h += '<li>Cross-check high-FRP cells against forest vs. agricultural land cover before dispatching field units.</li>';
      } else if (proxInfo.totalFRP > 0) {
        h += '<li>Monitor detections on upcoming NOAA-20 / NOAA-21 passes for intensity escalation.</li>';
        h += '<li>Inspect the Smoke &amp; Weather tab to see if live wind pushes plumes toward populated roads.</li>';
      } else {
        h += '<li>Target buffer is clear in the current 7-day satellite screening window.</li>';
        h += '<li>Keep in mind cloud cover or short-lived fires between satellite overpasses may not appear.</li>';
      }
    } else if (region && region.suggested_checks) {
      h += region.suggested_checks.map((t) => "<li>" + EW.esc(t) + "</li>").join("");
    } else {
      h += '<li>Select a country, state, or click any map cell to generate tailored field screening checks.</li>';
      h += '<li>Use Proximity mode to screen highways, protected parks, or staging bases within 10–50 km.</li>';
    }
    h += '</ul>';

    h += '<h3>Dataset Coverage &amp; Freshness</h3>';
    h += '<div class="evs-card"><div style="font-size:12.5px;line-height:19px">';
    h += '<b>Source:</b> ' + EW.esc(m.source) + '<br>';
    h += '<b>Newest UTC pass:</b> ' + EW.esc(m.data_newest_utc) + '<br>';
    h += '<b>Unassigned coastal/border:</b> ' + EW.nf.format(m.unassigned.country_count) + ' (' + m.unassigned.country_share_pct + '%)';
    h += '</div></div>';

    h += '<h3>Key Scientific Limitations</h3><ol class="limits-list">';
    h += m.limitations.map((l) => "<li>" + EW.esc(l) + "</li>").join("");
    h += '</ol>';
    box.innerHTML = h;
  }

  // --- Geospatial & Meteorological Helpers ---
  function destPoint(lat, lon, bearingDeg, distKm) {
    const br = bearingDeg * DEG2RAD;
    const d = distKm / R_EARTH;
    const lat1 = lat * DEG2RAD;
    const lon1 = lon * DEG2RAD;
    const lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(br));
    const lon2 = lon1 + Math.atan2(Math.sin(br) * Math.sin(d) * Math.cos(lat1), Math.cos(d) - Math.sin(lat1) * Math.sin(lat2));
    return [lat2 * RAD2DEG, lon2 * RAD2DEG];
  }

  function compassLabel(deg) {
    const dirs = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
    return dirs[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];
  }

  function aqiStatus(aqi) {
    if (aqi == null) return { label: "Unavailable", cls: "aqi-mod" };
    if (aqi <= 50) return { label: "Good (" + aqi + ")", cls: "aqi-good" };
    if (aqi <= 100) return { label: "Moderate (" + aqi + ")", cls: "aqi-mod" };
    return { label: "Unhealthy (" + aqi + ")", cls: "aqi-high" };
  }

  function fireWeatherSpread(temp, rh, wind) {
    if (temp == null || rh == null || wind == null) return { label: "Unknown", cls: "aqi-mod", desc: "Weather metrics unavailable." };
    if ((rh < 30 && wind >= 20) || (temp >= 35 && rh < 35)) {
      return { label: "Critical Spread Potential", cls: "aqi-high", desc: "Hot, dry, and windy conditions favor rapid flame spread." };
    }
    if (rh < 45 && (wind >= 12 || temp >= 28)) {
      return { label: "Elevated Spread Potential", cls: "aqi-mod", desc: "Dry air or brisk wind can sustain active surface burns." };
    }
    if (rh < 65) {
      return { label: "Moderate Spread Potential", cls: "aqi-mod", desc: "Standard seasonal drying conditions." };
    }
    return { label: "Low Spread Potential", cls: "aqi-good", desc: "Higher humidity helps dampen rapid spread." };
  }

  // --- Find Hotspot Cell for a Region ---
  function findRegionHotspot(region) {
    const EW = window.EW;
    if (!EW || !EW.S || !EW.S.cells) return null;
    const cells = EW.S.cells.cells;
    let best = null;
    if (!region) {
      // World #1 cell by FRP
      for (const c of cells) { if (!best || c[3] > best[3]) best = c; }
      return best ? { lat: best[0], lon: best[1], count: best[2], frp: best[3], label: "Global Peak FRP Cell" } : null;
    }
    const cIdx = EW.S.cells.countries.indexOf(region.iso_a3);
    const sIdx = region.level === "state" ? EW.S.cells.states.indexOf(region.id) : -1;
    for (const c of cells) {
      const match = sIdx >= 0 ? c[5] === sIdx : c[4] === cIdx;
      if (match && (!best || c[3] > best[3])) best = c;
    }
    if (!best) return null;
    const name = region.level === "state" ? region.state : region.country;
    return { lat: best[0], lon: best[1], count: best[2], frp: best[3], label: name + " Peak Hotspot" };
  }

  // --- Live Open-Meteo Fetch (No API key) ---
  async function fetchLiveSmokeAndWeather(lat, lon) {
    const key = lat.toFixed(2) + "," + lon.toFixed(2);
    if (E.cache.has(key)) return E.cache.get(key);

    const aqiUrl = "https://air-quality-api.open-meteo.com/v1/air-quality?latitude=" + lat + "&longitude=" + lon +
      "&current=us_aqi,pm2_5,pm10,carbon_monoxide";
    const wxUrl = "https://api.open-meteo.com/v1/forecast?latitude=" + lat + "&longitude=" + lon +
      "&current=temperature_2m,relative_humidity_2m,wind_speed_10m,wind_direction_10m";

    const [aqiRes, wxRes] = await Promise.all([
      fetch(aqiUrl).then((r) => (r.ok ? r.json() : null)).catch(() => null),
      fetch(wxUrl).then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ]);

    const ac = aqiRes && aqiRes.current ? aqiRes.current : {};
    const wc = wxRes && wxRes.current ? wxRes.current : {};
    const payload = {
      aqi: ac.us_aqi ?? null,
      pm25: ac.pm2_5 ?? null,
      pm10: ac.pm10 ?? null,
      co: ac.carbon_monoxide ?? null,
      temp: wc.temperature_2m ?? null,
      rh: wc.relative_humidity_2m ?? null,
      windSpeed: wc.wind_speed_10m ?? null,
      windDir: wc.wind_direction_10m ?? null,
      fetchedAt: new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC",
    };
    E.cache.set(key, payload);
    return payload;
  }

  // --- Draw Downwind Smoke Drift Cone on Leaflet ---
  function drawSmokeCone(target, wx) {
    const EW = window.EW;
    if (!EW || !EW.map) return;
    if (!E.smokeLayer) E.smokeLayer = L.featureGroup().addTo(EW.map);
    E.smokeLayer.clearLayers();

    if (!E.windEnabled || !target || !wx || wx.windDir == null || wx.windSpeed == null) return;

    // Meteorological windDir is direction wind comes FROM. Downwind plume travels +180 deg.
    const downwindBrg = (wx.windDir + 180) % 360;
    const plumeKm = Math.max(28, Math.min(95, wx.windSpeed * 3.5));
    const spreadDeg = 22;

    const pts = [[target.lat, target.lon]];
    for (let a = downwindBrg - spreadDeg; a <= downwindBrg + spreadDeg; a += 5.5) {
      pts.push(destPoint(target.lat, target.lon, a, plumeKm));
    }
    pts.push([target.lat, target.lon]);

    const cone = L.polygon(pts, {
      color: "#FF6F59",
      weight: 1.5,
      dashArray: "5, 5",
      fillColor: "#FF6F59",
      fillOpacity: 0.16,
    });
    cone.bindTooltip(
      "<strong>Live Downwind Smoke Drift Cone</strong><br>" +
      "Source: " + EW.esc(target.label) + "<br>" +
      "Wind: " + Math.round(wx.windSpeed) + " km/h blowing toward " + compassLabel(downwindBrg) + " (~" + Math.round(plumeKm) + " km reach)"
    );
    E.smokeLayer.addLayer(cone);

    const tipPt = destPoint(target.lat, target.lon, downwindBrg, plumeKm);
    const axis = L.polyline([[target.lat, target.lon], tipPt], {
      color: "#FF6F59", weight: 2, opacity: 0.75, dashArray: "3, 6", interactive: false,
    });
    E.smokeLayer.addLayer(axis);
  }

  async function inspectSmokeAndWeather(target) {
    const EW = window.EW;
    if (!EW) return;
    const box = EW.$("evs-live-body");
    if (!target) {
      if (E.smokeLayer) E.smokeLayer.clearLayers();
      box.innerHTML = '<p class="muted">No active hotspot coordinates to inspect.</p>';
      return;
    }
    E.lastTarget = target;
    box.innerHTML = '<div class="skeleton-block" style="height:140px"></div>';

    const wx = await fetchLiveSmokeAndWeather(target.lat, target.lon);
    E.lastWeather = wx;
    drawSmokeCone(target, wx);

    const aqi = aqiStatus(wx.aqi);
    const fwi = fireWeatherSpread(wx.temp, wx.rh, wx.windSpeed);
    const downwind = wx.windDir != null ? compassLabel((wx.windDir + 180) % 360) : "—";
    const fromDir = wx.windDir != null ? compassLabel(wx.windDir) : "—";

    box.innerHTML =
      '<div class="evs-card">' +
      '<div class="evs-card-title"><span>Inspected Hotspot</span><span>' + target.lat.toFixed(2) + '°, ' + target.lon.toFixed(2) + '°</span></div>' +
      '<div style="font-weight:700;font-size:15px;margin-bottom:4px">' + EW.esc(target.label) + '</div>' +
      (target.frp != null ? '<div class="muted" style="font-size:12.5px">' + EW.nf.format(target.count || 0) + ' detections · ' + EW.nf.format(Math.round(target.frp)) + ' MW FRP</div>' : '') +
      '</div>' +

      '<div class="evs-card">' +
      '<div class="evs-card-title"><span>Live Air Quality (SDG 11)</span><span class="aqi-pill ' + aqi.cls + '">' + aqi.label + '</span></div>' +
      '<div class="evs-stat-grid">' +
      '<div class="evs-mini"><div class="v">' + (wx.pm25 != null ? wx.pm25.toFixed(1) : "—") + ' <small>µg/m³</small></div><div class="l">PM2.5 Smoke</div></div>' +
      '<div class="evs-mini"><div class="v">' + (wx.pm10 != null ? wx.pm10.toFixed(1) : "—") + ' <small>µg/m³</small></div><div class="l">PM10 Dust/Ash</div></div>' +
      '<div class="evs-mini"><div class="v">' + (wx.co != null ? Math.round(wx.co) : "—") + ' <small>µg/m³</small></div><div class="l">Carbon Monoxide</div></div>' +
      '<div class="evs-mini"><div class="v">' + (wx.aqi != null ? wx.aqi : "—") + '</div><div class="l">US AQI</div></div>' +
      '</div></div>' +

      '<div class="evs-card">' +
      '<div class="evs-card-title"><span>Fire Weather &amp; Smoke Drift</span><span class="aqi-pill ' + fwi.cls + '">' + fwi.label + '</span></div>' +
      '<div class="wind-row">' +
      '<div class="wind-compass" title="Downwind plume direction">' + downwind + '</div>' +
      '<div style="font-size:12.5px;line-height:18px">' +
      '<b>Wind:</b> ' + (wx.windSpeed != null ? Math.round(wx.windSpeed) + ' km/h' : '—') + ' from ' + fromDir + ' (plume drifts <b>' + downwind + '</b>)<br>' +
      '<b>Temp / RH:</b> ' + (wx.temp != null ? wx.temp.toFixed(1) + '°C' : '—') + ' · ' + (wx.rh != null ? Math.round(wx.rh) + '% humidity' : '—') +
      '</div></div>' +
      '<p class="muted" style="font-size:12px;margin:4px 0 0">' + fwi.desc + ' <em>Live Open-Meteo snapshot (' + wx.fetchedAt + '); satellite fire window is ' + EW.S.meta.dates.all[0] + '–' + EW.S.meta.dates.all.slice(-1)[0] + '.</em></p>' +
      '</div>';
  }

  // --- Modals: Methodology & Export Report ---
  function openModal(id) { EW_ModalShow(id, true); }
  function closeModal(id) { EW_ModalShow(id, false); }
  function EW_ModalShow(id, show) {
    const el = document.getElementById(id);
    if (el) el.hidden = !show;
  }

  function renderMethodologyModal() {
    const EW = window.EW;
    if (!EW) return;
    const m = EW.S.meta;
    const el = EW.$("methodology-content");
    el.innerHTML =
      '<p><b>EmberWatch</b> is an Environmental Studies (EVS) fire-detection decision-support dashboard built on <b>' + EW.esc(m.source) + '</b>. It focuses on <b>SDG 15 (Life on Land)</b>, <b>SDG 13 (Climate Action)</b>, and <b>SDG 11 (Sustainable Cities)</b>.</p>' +
      '<h3>1. Priority Score Formula</h3>' +
      '<div class="formula-box">Priority = 0.50 × pct_rank(Total FRP) + 0.20 × pct_rank(Count) + 0.30 × pct_rank(Short-term % change)</div>' +
      '<p>Regions with fewer than ' + m.trend.min_detections + ' detections are marked <b>Insufficient data</b> and scored using FRP and Count only. Tiers: <b>High &ge; 75</b>, <b>Medium &ge; 40</b>, <b>Low &lt; 40</b>.</p>' +
      '<h3>2. Short-Term Signal</h3>' +
      '<p>Compares average daily detections &amp; FRP in the last 2 complete UTC days (<code>' + m.dates.trend_recent.join(", ") + '</code>) against the prior 5 complete days (<code>' + m.dates.trend_prior[0] + '–' + m.dates.trend_prior.slice(-1)[0] + '</code>). Partial edge days (<code>' + m.dates.partial.join(", ") + '</code>) are excluded from the signal and drawn dashed on the chart.</p>' +
      '<h3>3. CO₂e &amp; Smoke Screening Estimator</h3>' +
      '<div class="formula-box">Dry Biomass (kg) = FRP (MW) × 3,600 s × 0.368 kg/MJ (Wooster et al., 2005)<br>CO₂ = Biomass × 1.60 kg/kg · PM2.5 = Biomass × 0.012 kg/kg (Akagi et al., 2011)</div>' +
      '<p>Because VIIRS only samples thermal energy during discrete satellite overpasses, emissions are rough screening orders-of-magnitude rather than verified inventories.</p>' +
      '<h3>4. Live Air Quality &amp; Smoke Plume Drift</h3>' +
      '<p>Fetches current PM2.5, PM10, CO, US AQI, and 10m wind vectors from Open-Meteo and plots a downwind dispersion cone (wind direction + 180°) to screen communities or corridors downwind of fire clusters.</p>' +
      '<h3>5. Dataset Limitations</h3><ol class="limits-list">' +
      m.limitations.map((l) => '<li>' + EW.esc(l) + '</li>').join("") + '</ol>';
  }

  function downloadFile(filename, content, mime) {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function exportCSV() {
    const EW = window.EW;
    if (!EW) return;
    if (E.proxResult && E.proxResult.matches && EW.$("btn-mode-proximity").getAttribute("aria-pressed") === "true") {
      const cols = ["Lat", "Lon", "Distance_km", "Detections", "FRP_MW"];
      const lines = [cols.join(",")].concat(
        E.proxResult.matches.map((m) => [m.cell[0], m.cell[1], m.distKm, m.cell[2], Math.round(m.cell[3])].join(","))
      );
      downloadFile("emberwatch-proximity-cells.csv", "\uFEFF" + lines.join("\n"), "text/csv;charset=utf-8;");
      return;
    }
    const rows = EW.tableRows();
    const cols = ["Rank", "Region", "Country", "Detections", "Total_FRP_MW", "Priority_Score", "Tier", "Short_Term_Signal", "Signal_Pct"];
    const lines = [cols.join(",")].concat(
      rows.map((r, i) => [
        i + 1,
        '"' + String(r.level === "state" ? r.state : r.country).replace(/"/g, '""') + '"',
        '"' + String(r.country).replace(/"/g, '""') + '"',
        r.fire_count,
        Math.round(r.total_frp),
        r.priority_score.toFixed(1),
        r.tier,
        '"' + r.trend_flag + '"',
        r.trend_pct == null ? "" : r.trend_pct.toFixed(1),
      ].join(","))
    );
    downloadFile("emberwatch-priority-screening.csv", "\uFEFF" + lines.join("\n"), "text/csv;charset=utf-8;");
  }

  function exportJSON() {
    const EW = window.EW;
    if (!EW) return;
    const region = EW.currentRegion();
    const frp = E.proxResult && EW.$("btn-mode-proximity").getAttribute("aria-pressed") === "true"
      ? E.proxResult.totalFRP
      : (region ? region.total_frp : EW.S.countries.reduce((a, c) => a + c.total_frp, 0));
    const payload = {
      generated_at: new Date().toISOString(),
      mode: EW.$("btn-mode-proximity").getAttribute("aria-pressed") === "true" ? "proximity" : "region",
      region: region || "World",
      proximity: E.proxResult || null,
      emissions_screening: estimateEmissions(frp),
      live_hotspot_weather: E.lastWeather,
      data_window: EW.S.meta.dates,
    };
    downloadFile("emberwatch-evs-briefing.json", JSON.stringify(payload, null, 2), "application/json");
  }

  function renderExportModal() {
    const EW = window.EW;
    if (!EW) return;
    const isProx = EW.$("btn-mode-proximity").getAttribute("aria-pressed") === "true";
    const r = EW.currentRegion();
    const scope = isProx
      ? "Proximity Screening (" + (E.lastTarget ? E.lastTarget.label : "No target") + ")"
      : (r ? (r.level === "state" ? r.state + ", " + r.country : r.country) : "Global World Screening");
    const frp = isProx && E.proxResult ? E.proxResult.totalFRP : (r ? r.total_frp : EW.S.countries.reduce((a, c) => a + c.total_frp, 0));
    const det = isProx && E.proxResult ? E.proxResult.totalDetections : (r ? r.fire_count : EW.S.meta.rows.kept);
    const est = estimateEmissions(frp);

    EW.$("export-content").innerHTML =
      '<div class="evs-card">' +
      '<div class="evs-card-title"><span>Current Scope Snapshot</span><span>' + EW.esc(EW.S.meta.dates.all[0] + " to " + EW.S.meta.dates.all.slice(-1)[0]) + '</span></div>' +
      '<p style="margin:0 0 8px"><b>Target:</b> ' + EW.esc(scope) + '</p>' +
      '<p style="margin:0 0 8px"><b>Detections:</b> ' + EW.nf.format(det) + ' · <b>Total FRP:</b> ' + EW.nf.format(Math.round(frp)) + ' MW</p>' +
      '<p style="margin:0"><b>Est. CO₂e Screening:</b> ' + EW.nf.format(Math.round(est.co2Tonnes)) + ' tonnes CO₂ · ' + EW.nf.format(Math.round(est.pm25Tonnes)) + ' tonnes PM2.5</p>' +
      '</div>' +
      '<p class="muted">Export the current screening dataset for EVS coursework, field briefings, or offline GIS review:</p>' +
      '<div class="export-actions">' +
      '<button type="button" id="btn-dl-csv" class="btn-action">Download Table CSV</button>' +
      '<button type="button" id="btn-dl-json" class="btn-action secondary">Download Briefing JSON</button>' +
      '<button type="button" id="btn-print-pdf" class="btn-action secondary">Print / Save PDF</button>' +
      '</div>';

    EW.$("btn-dl-csv").addEventListener("click", exportCSV);
    EW.$("btn-dl-json").addEventListener("click", exportJSON);
    EW.$("btn-print-pdf").addEventListener("click", () => { closeModal("modal-export"); window.print(); });
  }

  // --- Wiring & Lifecycle ---
  function initEVS() {
    const EW = window.EW;
    if (!EW) return;

    // Initial selection update
    function handleRegionChange(region) {
      E.proxResult = null;
      const frp = region ? region.total_frp : EW.S.countries.reduce((a, c) => a + c.total_frp, 0);
      const label = region ? (region.level === "state" ? region.state : region.country) : "World";
      updateCarbonAndKPIs(frp, label);
      renderChecksTab(region, null);
      const hotspot = findRegionHotspot(region);
      inspectSmokeAndWeather(hotspot);
    }

    document.addEventListener("selectionchange", (e) => {
      handleRegionChange(e.detail ? e.detail.region : EW.currentRegion());
    });

    document.addEventListener("ew-cell-inspect", (e) => {
      const d = e.detail;
      if (!d) return;
      EW.activateTab("tab-btn-evs");
      inspectSmokeAndWeather(d);
    });

    document.addEventListener("ew-proximity-result", (e) => {
      const d = e.detail || {};
      E.proxResult = d.result || null;
      const res = d.result || { totalFRP: 0, totalDetections: 0, nearestKm: null, matches: [] };
      const kpiDet = EW.$("kpi-detections-val");
      const kpiFrp = EW.$("kpi-frp-val");
      const kpiSig = EW.$("kpi-signal-val");
      if (kpiDet) {
        kpiDet.textContent = EW.nf.format(res.totalDetections);
        EW.$("kpi-detections-sub").textContent = res.matches.length + " cells within " + d.bufferKm + " km";
      }
      if (kpiFrp) {
        kpiFrp.textContent = EW.compact.format(Math.round(res.totalFRP)) + " MW";
        EW.$("kpi-frp-sub").textContent = res.nearestKm != null ? ("Nearest cell: " + res.nearestKm + " km") : "Buffer clear";
      }
      if (kpiSig) {
        EW.$("kpi-signal-lbl").textContent = "Proximity Verdict";
        kpiSig.textContent = d.verdict ? d.verdict.label : "Ready";
        EW.$("kpi-signal-sub").textContent = d.verdict ? d.verdict.desc : "Click map or search place";
      }
      updateCarbonAndKPIs(res.totalFRP, d.label || "Proximity");
      renderChecksTab(null, res);
      inspectSmokeAndWeather(d.target || null);
    });

    // Wind Drift Toggle
    EW.$("btn-toggle-wind").addEventListener("click", (e) => {
      const btn = e.currentTarget;
      E.windEnabled = !E.windEnabled;
      btn.setAttribute("aria-pressed", E.windEnabled ? "true" : "false");
      drawSmokeCone(E.lastTarget, E.lastWeather);
    });

    // Modals
    EW.$("btn-methodology").addEventListener("click", () => { renderMethodologyModal(); openModal("modal-methodology"); });
    EW.$("btn-export-report").addEventListener("click", () => { renderExportModal(); openModal("modal-export"); });
    document.querySelectorAll("[data-close-modal]").forEach((btn) => {
      btn.addEventListener("click", () => closeModal(btn.dataset.closeModal));
    });
    document.querySelectorAll(".modal-backdrop").forEach((bd) => {
      bd.addEventListener("click", (e) => { if (e.target === bd) bd.hidden = true; });
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        closeModal("modal-methodology");
        closeModal("modal-export");
      }
    });

    // Trigger initial pass
    handleRegionChange(EW.currentRegion());
  }

  if (typeof window !== "undefined" && window.EW && window.EW.map) {
    initEVS();
  } else if (typeof document !== "undefined") {
    document.addEventListener("ew-ready", initEVS);
  }
})();
