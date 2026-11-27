/* evs.js - Environmental Studies (EVS) Fire Science, Smoke Plume, Forecast, Compare, Tour & Reporting */
(function () {
  "use strict";

  const DEG2RAD = Math.PI / 180;
  const RAD2DEG = 180 / Math.PI;
  const R_EARTH = 6371.0;

  const E = {
    windEnabled: true,
    smokeLayer: null,
    flashRing: null,
    lastTarget: null,      // { lat, lon, label, frp, count }
    lastWeather: null,     // weather + 72h forecast payload
    cache: new Map(),      // "lat,lon" -> weather payload
    proxResult: null,      // latest proximity result if in proximity mode
    cmpChart: null,
    tourIdx: 0,
  };

  // --- Scientific Screening Estimator (Wooster et al., 2005; Akagi et al., 2011) ---
  function estimateEmissions(totalFrpMw) {
    const frp = Math.max(0, Number(totalFrpMw) || 0);
    const freMJ = frp * 3600;
    const biomassKg = freMJ * 0.368;
    const co2Tonnes = (biomassKg * 1.60) / 1000;
    const coTonnes = (biomassKg * 0.090) / 1000;
    const pm25Tonnes = (biomassKg * 0.012) / 1000;
    const carDays = Math.round((co2Tonnes * 1000) / 12.6);
    return { biomassTonnes: biomassKg / 1000, co2Tonnes, coTonnes, pm25Tonnes, carDays };
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

  // --- Top 5 Hotspots Fly-To & Concentration Metric ---
  function renderHotspotsBox(region, isProx) {
    const EW = window.EW;
    const box = EW.$("evs-hotspots-box");
    if (!EW || !box) return;
    if (isProx) { box.innerHTML = ""; return; }

    const cells = EW.S.cells.cells;
    let filtered = cells;
    if (region) {
      const cIdx = EW.S.cells.countries.indexOf(region.iso_a3);
      const sIdx = region.level === "state" ? EW.S.cells.states.indexOf(region.id) : -1;
      filtered = cells.filter((r) => (sIdx >= 0 ? r[5] === sIdx : r[4] === cIdx));
    }
    if (!filtered.length) { box.innerHTML = ""; return; }

    const sorted = filtered.slice().sort((a, b) => b[3] - a[3]);
    const totalFrp = sorted.reduce((acc, c) => acc + c[3], 0);
    const top5PctCount = Math.max(1, Math.ceil(sorted.length * 0.05));
    const top5PctFrp = sorted.slice(0, top5PctCount).reduce((acc, c) => acc + c[3], 0);
    const concShare = totalFrp > 0 ? Math.round((top5PctFrp / totalFrp) * 100) : 0;

    const top5 = sorted.slice(0, 5);
    const countryList = EW.S.cells.countries;
    const stateList = EW.S.cells.states;

    let h = '<div class="evs-card">' +
      '<div class="evs-card-title"><span>Top Hotspots &amp; Concentration</span><span>' + concShare + '% in top 5%</span></div>' +
      '<p class="muted" style="font-size:11.5px;margin:0 0 6px">Top ' + top5PctCount + ' of ' + EW.nf.format(sorted.length) + ' active cells account for <b>' + concShare + '%</b> of FRP. Click to fly &amp; inspect:</p>' +
      '<div class="hotspot-list">';

    top5.forEach((c, i) => {
      const cName = c[4] >= 0 ? countryList[c[4]] : "Unassigned";
      const sName = c[5] >= 0 ? stateList[c[5]].replace(/^[^|]+\|/, "") : cName;
      h += '<button type="button" class="hotspot-row" data-lat="' + c[0] + '" data-lon="' + c[1] + '" data-count="' + c[2] + '" data-frp="' + c[3] + '" data-label="' + EW.esc(sName + " #" + (i + 1)) + '">' +
        '<span><b>#' + (i + 1) + '</b> ' + EW.esc(sName) + ' <span class="muted">(' + c[0].toFixed(2) + '°, ' + c[1].toFixed(2) + '°)</span></span>' +
        '<span class="hotspot-frp">' + EW.nf.format(Math.round(c[3])) + ' MW</span></button>';
    });
    h += '</div></div>';
    box.innerHTML = h;
  }

  function flyToHotspot(lat, lon, label, count, frp) {
    const EW = window.EW;
    if (!EW || !EW.map) return;
    EW.map.setView([lat, lon], Math.max(EW.map.getZoom(), 7), { animate: true });
    if (E.flashRing) E.flashRing.remove();
    E.flashRing = L.circleMarker([lat, lon], {
      radius: 18, color: "#FF6F59", weight: 3, fillColor: "#FF6F59", fillOpacity: 0.18, interactive: false,
    }).addTo(EW.map);
    setTimeout(() => { if (E.flashRing) { E.flashRing.remove(); E.flashRing = null; } }, 2800);
    EW.activateTab("tab-btn-evs");
    inspectSmokeAndWeather({ lat, lon, label, count, frp });
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
        h += '<li>Switch map to <b>Satellite</b> basemap to check forest vs. agricultural land cover at dense cells.</li>';
      } else if (proxInfo.totalFRP > 0) {
        h += '<li>Monitor detections on upcoming NOAA-20 / NOAA-21 passes for intensity escalation.</li>';
        h += '<li>Inspect the Smoke &amp; Weather tab to see if live wind pushes plumes toward populated roads.</li>';
      } else {
        h += '<li>Target buffer is clear in the current 7-day satellite screening window.</li>';
        h += '<li>Check upwind smoke advisories in the Smoke &amp; Weather tab for plumes drifting from outside the buffer.</li>';
      }
    } else if (region && region.suggested_checks) {
      h += region.suggested_checks.map((t) => "<li>" + EW.esc(t) + "</li>").join("");
    } else {
      h += '<li>Select a country, state, or click any map cell to generate tailored field screening checks.</li>';
      h += '<li>Switch to <b>Satellite</b> basemap on the map HUD to visually inspect land cover beneath hot cells.</li>';
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
  function haversineKm(lat1, lon1, lat2, lon2) {
    const dLat = (lat2 - lat1) * DEG2RAD;
    const dLon = (lon2 - lon1) * DEG2RAD;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * DEG2RAD) * Math.cos(lat2 * DEG2RAD) * Math.sin(dLon / 2) ** 2;
    return 2 * R_EARTH * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  function bearingDeg(lat1, lon1, lat2, lon2) {
    const y = Math.sin((lon2 - lon1) * DEG2RAD) * Math.cos(lat2 * DEG2RAD);
    const x = Math.cos(lat1 * DEG2RAD) * Math.sin(lat2 * DEG2RAD) -
              Math.sin(lat1 * DEG2RAD) * Math.cos(lat2 * DEG2RAD) * Math.cos((lon2 - lon1) * DEG2RAD);
    return (Math.atan2(y, x) * RAD2DEG + 360) % 360;
  }

  function destPoint(lat, lon, brgDeg, distKm) {
    const br = brgDeg * DEG2RAD;
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
      return { label: "Critical Spread", cls: "aqi-high", desc: "Hot, dry, and windy conditions favor rapid flame spread." };
    }
    if (rh < 45 && (wind >= 12 || temp >= 28)) {
      return { label: "Elevated Spread", cls: "aqi-mod", desc: "Dry air or brisk wind can sustain active surface burns." };
    }
    if (rh < 65) return { label: "Moderate Spread", cls: "aqi-mod", desc: "Standard seasonal drying conditions." };
    return { label: "Low Spread", cls: "aqi-good", desc: "Higher humidity helps dampen rapid spread." };
  }

  // Detect active fire cells outside buffer (up to 120 km) whose downwind plume blows toward the target
  function findUpwindHazards(target, wx) {
    const EW = window.EW;
    if (!EW || !target || !wx || wx.windDir == null) return [];
    const downwindBrg = (wx.windDir + 180) % 360;
    const cells = EW.S.cells.cells;
    const hazards = [];
    for (const c of cells) {
      if (c[3] < 50) continue; // focus on notable thermal sources >= 50 MW
      const d = haversineKm(c[0], c[1], target.lat, target.lon);
      if (d > 5 && d <= 120) {
        const brgToTarget = bearingDeg(c[0], c[1], target.lat, target.lon);
        const diff = Math.abs(((brgToTarget - downwindBrg + 540) % 360) - 180);
        if (diff <= 35) hazards.push({ cell: c, distKm: Math.round(d) });
      }
    }
    return hazards.sort((a, b) => b.cell[3] - a.cell[3]);
  }

  function findRegionHotspot(region) {
    const EW = window.EW;
    if (!EW || !EW.S || !EW.S.cells) return null;
    const cells = EW.S.cells.cells;
    let best = null;
    if (!region) {
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

  // --- Live Open-Meteo Fetch (Current + 72h Forecast) ---
  async function fetchLiveSmokeAndWeather(lat, lon) {
    const key = lat.toFixed(2) + "," + lon.toFixed(2);
    if (E.cache.has(key)) return E.cache.get(key);

    const aqiUrl = "https://air-quality-api.open-meteo.com/v1/air-quality?latitude=" + lat + "&longitude=" + lon +
      "&current=us_aqi,pm2_5,pm10,carbon_monoxide";
    const wxUrl = "https://api.open-meteo.com/v1/forecast?latitude=" + lat + "&longitude=" + lon +
      "&current=temperature_2m,relative_humidity_2m,wind_speed_10m,wind_direction_10m" +
      "&daily=temperature_2m_max,relative_humidity_2m_min,wind_speed_10m_max,precipitation_probability_max&forecast_days=3&timezone=UTC";

    const [aqiRes, wxRes] = await Promise.all([
      fetch(aqiUrl).then((r) => (r.ok ? r.json() : null)).catch(() => null),
      fetch(wxUrl).then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ]);

    const ac = aqiRes && aqiRes.current ? aqiRes.current : {};
    const wc = wxRes && wxRes.current ? wxRes.current : {};
    const wd = wxRes && wxRes.daily ? wxRes.daily : null;
    const forecast = [];
    if (wd && wd.time) {
      for (let i = 0; i < wd.time.length; i++) {
        forecast.push({
          date: wd.time[i],
          tMax: wd.temperature_2m_max?.[i],
          rhMin: wd.relative_humidity_2m_min?.[i],
          windMax: wd.wind_speed_10m_max?.[i],
          rainProb: wd.precipitation_probability_max?.[i],
        });
      }
    }

    const payload = {
      aqi: ac.us_aqi ?? null,
      pm25: ac.pm2_5 ?? null,
      pm10: ac.pm10 ?? null,
      co: ac.carbon_monoxide ?? null,
      temp: wc.temperature_2m ?? null,
      rh: wc.relative_humidity_2m ?? null,
      windSpeed: wc.wind_speed_10m ?? null,
      windDir: wc.wind_direction_10m ?? null,
      forecast,
      fetchedAt: new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC",
    };
    E.cache.set(key, payload);
    return payload;
  }

  function drawSmokeCone(target, wx) {
    const EW = window.EW;
    if (!EW || !EW.map) return;
    if (!E.smokeLayer) E.smokeLayer = L.featureGroup().addTo(EW.map);
    E.smokeLayer.clearLayers();

    if (!E.windEnabled || !target || !wx || wx.windDir == null || wx.windSpeed == null) return;

    const downwindBrg = (wx.windDir + 180) % 360;
    const plumeKm = Math.max(28, Math.min(95, wx.windSpeed * 3.5));
    const spreadDeg = 22;

    const pts = [[target.lat, target.lon]];
    for (let a = downwindBrg - spreadDeg; a <= downwindBrg + spreadDeg; a += 5.5) {
      pts.push(destPoint(target.lat, target.lon, a, plumeKm));
    }
    pts.push([target.lat, target.lon]);

    const cone = L.polygon(pts, {
      color: "#FF6F59", weight: 1.5, dashArray: "5, 5", fillColor: "#FF6F59", fillOpacity: 0.16,
    });
    cone.bindTooltip(
      "<strong>Live Downwind Smoke Drift Cone</strong><br>" +
      "Source: " + EW.esc(target.label) + "<br>" +
      "Wind: " + Math.round(wx.windSpeed) + " km/h blowing toward " + compassLabel(downwindBrg) + " (~" + Math.round(plumeKm) + " km)"
    );
    E.smokeLayer.addLayer(cone);

    const tipPt = destPoint(target.lat, target.lon, downwindBrg, plumeKm);
    E.smokeLayer.addLayer(L.polyline([[target.lat, target.lon], tipPt], {
      color: "#FF6F59", weight: 2, opacity: 0.75, dashArray: "3, 6", interactive: false,
    }));
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
    const isProx = EW.$("btn-mode-proximity").getAttribute("aria-pressed") === "true";

    let alertHtml = "";
    if (isProx) {
      const hazards = findUpwindHazards(target, wx);
      if (hazards.length > 0) {
        const topH = hazards[0];
        alertHtml = '<div class="smoke-alert-card">' +
          '<strong>Downwind Smoke Drift Advisory:</strong> ' + hazards.length + ' active fire cell(s) (&ge;50 MW) sit upwind within 120 km ' +
          '(strongest: ' + EW.nf.format(Math.round(topH.cell[3])) + ' MW at ' + topH.distKm + ' km). Live wind (' +
          Math.round(wx.windSpeed || 0) + ' km/h from ' + fromDir + ') may carry smoke toward this target.' +
          '</div>';
      }
    }

    let forecastHtml = "";
    if (wx.forecast && wx.forecast.length) {
      forecastHtml = '<div class="evs-card">' +
        '<div class="evs-card-title"><span>72-Hour Fire Weather Outlook</span><span>UTC</span></div>' +
        '<div class="forecast-strip">' +
        wx.forecast.map((d, idx) => {
          const fw = fireWeatherSpread(d.tMax, d.rhMin, d.windMax);
          const lbl = idx === 0 ? "Today" : d.date.slice(5);
          return '<div class="fc-day">' +
            '<div class="fc-day-title"><span>' + lbl + '</span><span class="aqi-pill ' + fw.cls + '" style="padding:1px 6px;font-size:10px">' + fw.label.split(" ")[0] + '</span></div>' +
            '<div>Max ' + (d.tMax != null ? Math.round(d.tMax) + '°C' : '—') + '</div>' +
            '<div>Min RH ' + (d.rhMin != null ? Math.round(d.rhMin) + '%' : '—') + '</div>' +
            '<div>Wind ' + (d.windMax != null ? Math.round(d.windMax) + ' km/h' : '—') + '</div>' +
            '<div>Rain ' + (d.rainProb != null ? Math.round(d.rainProb) + '%' : '—') + '</div>' +
            '</div>';
        }).join("") +
        '</div></div>';
    }

    box.innerHTML =
      alertHtml +
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
      '<p class="muted" style="font-size:12px;margin:4px 0 0">' + fwi.desc + ' <em>Live Open-Meteo (' + wx.fetchedAt + '); fire window ' + EW.S.meta.dates.all[0] + '–' + EW.S.meta.dates.all.slice(-1)[0] + '.</em></p>' +
      '</div>' +
      forecastHtml +
      '<button type="button" id="btn-go-field-log" class="btn-action secondary" style="width:100%;justify-content:center;margin-top:4px">Scan Eco-Assets / Tag Ground Truth →</button>';

    const goBtn = EW.$("btn-go-field-log");
    if (goBtn) goBtn.addEventListener("click", () => EW.activateTab("tab-btn-field"));
  }

  // --- Side-by-Side Region Comparison Mode ---
  function populateCompareSelects() {
    const EW = window.EW;
    const selA = EW.$("cmp-sel-a"), selB = EW.$("cmp-sel-b");
    if (!selA || !selB || selA.options.length > 0) return;

    const list = EW.S.regions.slice().sort((a, b) => b.fire_count - a.fire_count);
    list.forEach((r) => {
      const lbl = r.level === "state" ? (r.state + " (" + r.country + ")") : r.country;
      selA.add(new Option(lbl, r.id));
      selB.add(new Option(lbl, r.id));
    });

    const cur = EW.currentRegion();
    const topPrio = EW.S.countries.slice().sort((a, b) => b.priority_score - a.priority_score)[0];
    const secondC = EW.S.countries.slice().sort((a, b) => b.total_frp - a.total_frp)[0];
    selA.value = cur ? cur.id : (topPrio ? topPrio.id : list[0].id);
    selB.value = secondC && secondC.id !== selA.value ? secondC.id : (list[1]?.id || list[0].id);

    selA.addEventListener("change", renderCompare);
    selB.addEventListener("change", renderCompare);
  }

  function renderCompare() {
    const EW = window.EW;
    const a = EW.S.byId.get(EW.$("cmp-sel-a").value);
    const b = EW.S.byId.get(EW.$("cmp-sel-b").value);
    if (!a || !b) return;
    const name = (r) => (r.level === "state" ? r.state + ", " + r.country : r.country);
    const estA = estimateEmissions(a.total_frp), estB = estimateEmissions(b.total_frp);
    const peakDay = (r) => r.series.slice().sort((x, y) => y.frp - x.frp)[0]?.date || "—";

    EW.$("compare-body").innerHTML =
      '<table class="cmp-table"><thead><tr><th>Metric</th><th>' + EW.esc(name(a)) + '</th><th>' + EW.esc(name(b)) + '</th></tr></thead><tbody>' +
      '<tr><td>Detections (7d)</td><td><b>' + EW.nf.format(a.fire_count) + '</b></td><td><b>' + EW.nf.format(b.fire_count) + '</b></td></tr>' +
      '<tr><td>Total FRP (MW)</td><td><b>' + EW.nf.format(Math.round(a.total_frp)) + ' MW</b></td><td><b>' + EW.nf.format(Math.round(b.total_frp)) + ' MW</b></td></tr>' +
      '<tr><td>Priority Score &amp; Tier</td><td>' + a.priority_score.toFixed(1) + ' (' + a.tier + ' · #' + a.rank + ')</td><td>' + b.priority_score.toFixed(1) + ' (' + b.tier + ' · #' + b.rank + ')</td></tr>' +
      '<tr><td>Short-Term Signal</td><td>' + EW.esc(a.trend_flag) + (a.trend_pct != null ? ' (' + Math.round(a.trend_pct) + '%)' : '') + '</td><td>' + EW.esc(b.trend_flag) + (b.trend_pct != null ? ' (' + Math.round(b.trend_pct) + '%)' : '') + '</td></tr>' +
      '<tr><td>Est. CO₂e Screening</td><td>' + EW.compact.format(Math.round(estA.co2Tonnes)) + ' t CO₂</td><td>' + EW.compact.format(Math.round(estB.co2Tonnes)) + ' t CO₂</td></tr>' +
      '<tr><td>Peak FRP UTC Day</td><td>' + peakDay(a) + '</td><td>' + peakDay(b) + '</td></tr>' +
      '</tbody></table>';

    if (typeof Chart !== "undefined") {
      if (E.cmpChart) E.cmpChart.destroy();
      E.cmpChart = new Chart(EW.$("cmp-chart"), {
        type: "line",
        data: {
          labels: a.series.map((p) => p.date.slice(5)),
          datasets: [
            { label: name(a) + " (Detections)", data: a.series.map((p) => p.count), borderColor: "#FF6F59", backgroundColor: "#FF6F59", borderWidth: 2.5, tension: 0.2 },
            { label: name(b) + " (Detections)", data: b.series.map((p) => p.count), borderColor: "#217A79", backgroundColor: "#217A79", borderWidth: 2.5, tension: 0.2 },
          ],
        },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: "bottom" } } },
      });
    }
  }

  // --- Interactive Guided EVS Presentation Tour ---
  function buildTourSteps() {
    const EW = window.EW;
    const topPrio = EW.S.countries.slice().sort((a, b) => b.priority_score - a.priority_score)[0];
    const topFrp = EW.S.countries.slice().sort((a, b) => b.total_frp - a.total_frp)[0];
    const indStates = EW.S.statesByIso.get("IND") || [];
    const topInd = indStates.slice().sort((a, b) => b.total_frp - a.total_frp)[0];

    return [
      {
        title: "1. Priority Escalation (" + (topPrio ? topPrio.country : "Global") + ")",
        desc: topPrio
          ? topPrio.country + " ranks #1 globally (" + topPrio.priority_score.toFixed(1) + "/100, " + topPrio.trend_flag + "). Because Priority blends total heat with short-term momentum, accelerating fires surface ahead of larger, declining regions."
          : "Explore global fire priorities.",
        run: () => {
          if (EW.$("btn-mode-proximity").getAttribute("aria-pressed") === "true") EW.$("btn-mode-region").click();
          EW.setBasemap("vector");
          if (topPrio) EW.pickRegion(topPrio.id);
        },
      },
      {
        title: "2. Peak Thermal Power (" + (topFrp ? topFrp.country : "High FRP") + ")",
        desc: topFrp
          ? topFrp.country + " has the highest cumulative FRP (" + EW.compact.format(Math.round(topFrp.total_frp)) + " MW), driving the largest CO₂e screening estimate (SDG 13), even when its short-term signal is " + topFrp.trend_flag + "."
          : "Explore cumulative Fire Radiative Power.",
        run: () => {
          if (EW.$("btn-mode-proximity").getAttribute("aria-pressed") === "true") EW.$("btn-mode-region").click();
          if (topFrp) EW.pickRegion(topFrp.id);
        },
      },
      {
        title: "3. Satellite Land-Cover Check (" + (topInd ? topInd.state : "State View") + ")",
        desc: "Switching to Satellite imagery lets analysts check whether intense heat cells lie over agricultural cropland (stubble burning) or protected forest (SDG 15) — without guessing causes from satellites alone.",
        run: () => {
          if (EW.$("btn-mode-proximity").getAttribute("aria-pressed") === "true") EW.$("btn-mode-region").click();
          if (topInd) EW.pickRegion(topInd.id);
          EW.setBasemap("satellite");
        },
      },
      {
        title: "4. Smoke Drift & Corridor Screening (SDG 11)",
        desc: "Switch to Proximity mode to screen highways or cities (10–50 km), inspect live PM2.5/AQI, and view the Downwind Smoke Drift Cone showing where live wind pushes plumes.",
        run: () => {
          EW.setBasemap("vector");
          if (EW.$("btn-mode-proximity").getAttribute("aria-pressed") !== "true") EW.$("btn-mode-proximity").click();
          EW.activateTab("tab-btn-evs");
        },
      },
    ];
  }

  function showTourStep(idx) {
    const EW = window.EW;
    const steps = buildTourSteps();
    E.tourIdx = Math.max(0, Math.min(steps.length - 1, idx));
    const step = steps[E.tourIdx];
    EW.$("tour-float").hidden = false;
    EW.$("tour-step-badge").textContent = "Step " + (E.tourIdx + 1) + " / " + steps.length;
    EW.$("tour-title").textContent = step.title;
    EW.$("tour-desc").textContent = step.desc;
    EW.$("btn-tour-prev").disabled = (E.tourIdx === 0);
    EW.$("btn-tour-next").textContent = (E.tourIdx === steps.length - 1) ? "Finish" : "Next";
    step.run();
  }

  // --- Modals: Methodology & Export Report ---
  function openModal(id) { const el = document.getElementById(id); if (el) el.hidden = false; }
  function closeModal(id) { const el = document.getElementById(id); if (el) el.hidden = true; }

  function renderMethodologyModal() {
    const EW = window.EW;
    if (!EW) return;
    const m = EW.S.meta;
    EW.$("methodology-content").innerHTML =
      '<p><b>EmberWatch</b> is an Environmental Studies (EVS) fire-detection decision-support dashboard built on <b>' + EW.esc(m.source) + '</b>. It focuses on <b>SDG 15 (Life on Land)</b>, <b>SDG 13 (Climate Action)</b>, and <b>SDG 11 (Sustainable Cities)</b>.</p>' +
      '<h3>1. Priority Score Formula</h3>' +
      '<div class="formula-box">Priority = 0.50 × pct_rank(Total FRP) + 0.20 × pct_rank(Count) + 0.30 × pct_rank(Short-term % change)</div>' +
      '<p>Regions with fewer than ' + m.trend.min_detections + ' detections are marked <b>Insufficient data</b>. Tiers: <b>High &ge; 75</b>, <b>Medium &ge; 40</b>, <b>Low &lt; 40</b>.</p>' +
      '<h3>2. CO₂e &amp; Smoke Screening Estimator</h3>' +
      '<div class="formula-box">Dry Biomass (kg) = FRP (MW) × 3,600 s × 0.368 kg/MJ (Wooster et al., 2005)<br>CO₂ = Biomass × 1.60 kg/kg · PM2.5 = Biomass × 0.012 kg/kg (Akagi et al., 2011)</div>' +
      '<h3>3. Live Air Quality, 72h Forecast &amp; Smoke Plume Drift</h3>' +
      '<p>Queries Open-Meteo current PM2.5, PM10, CO, US AQI, 10m wind vectors, and 3-day weather forecasts. Draws a downwind dispersion cone (wind direction + 180°) and checks upwind hazards within 120 km in Proximity mode.</p>' +
      '<h3>4. NASA GIBS Space Imagery, Safe Routes, Assets &amp; Field Log</h3>' +
      '<p>NASA GIBS overlays NOAA-20 VIIRS TrueColor &amp; MODIS Aerosol Optical Depth synced to the timeline date. OSRM route alternatives score highway paths by fire exposure; OSM viewbox scans identify parks, hospitals, schools &amp; substations near fire/smoke; and the Field Ground-Truth Log records verified causes locally with GeoJSON/CSV export.</p>' +
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
      const lines = [cols.join(",")].concat(E.proxResult.matches.map((m) => [m.cell[0], m.cell[1], m.distKm, m.cell[2], Math.round(m.cell[3])].join(",")));
      downloadFile("emberwatch-proximity-cells.csv", "\uFEFF" + lines.join("\n"), "text/csv;charset=utf-8;");
      return;
    }
    const rows = EW.tableRows();
    const cols = ["Rank", "Region", "Country", "Detections", "Total_FRP_MW", "Priority_Score", "Tier", "Short_Term_Signal", "Signal_Pct"];
    const lines = [cols.join(",")].concat(rows.map((r, i) => [
      i + 1, '"' + String(r.level === "state" ? r.state : r.country).replace(/"/g, '""') + '"',
      '"' + String(r.country).replace(/"/g, '""') + '"', r.fire_count, Math.round(r.total_frp),
      r.priority_score.toFixed(1), r.tier, '"' + r.trend_flag + '"', r.trend_pct == null ? "" : r.trend_pct.toFixed(1),
    ].join(",")));
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

    function handleRegionChange(region) {
      E.proxResult = null;
      const dayIdx = EW.S.dayIdx;
      let frp;
      if (dayIdx >= 0) {
        frp = region ? (region.series[dayIdx]?.frp || 0) : EW.S.countries.reduce((a, c) => a + (c.series[dayIdx]?.frp || 0), 0);
      } else {
        frp = region ? region.total_frp : EW.S.countries.reduce((a, c) => a + c.total_frp, 0);
      }
      const label = region ? (region.level === "state" ? region.state : region.country) : "World";
      updateCarbonAndKPIs(frp, label);
      renderHotspotsBox(region, false);
      renderChecksTab(region, null);
      inspectSmokeAndWeather(findRegionHotspot(region));
    }

    document.addEventListener("selectionchange", (e) => {
      handleRegionChange(e.detail ? e.detail.region : EW.currentRegion());
    });

    document.addEventListener("ew-day-change", () => {
      if (EW.$("btn-mode-proximity").getAttribute("aria-pressed") === "true") return;
      const region = EW.currentRegion();
      const dayIdx = EW.S.dayIdx;
      const frp = dayIdx >= 0
        ? (region ? (region.series[dayIdx]?.frp || 0) : EW.S.countries.reduce((a, c) => a + (c.series[dayIdx]?.frp || 0), 0))
        : (region ? region.total_frp : EW.S.countries.reduce((a, c) => a + c.total_frp, 0));
      const lbl = dayIdx >= 0 ? EW.S.meta.dates.all[dayIdx] : (region ? (region.level === "state" ? region.state : region.country) : "World");
      updateCarbonAndKPIs(frp, lbl);
    });

    document.addEventListener("ew-cell-inspect", (e) => {
      const d = e.detail;
      if (!d) return;
      EW.activateTab("tab-btn-evs");
      inspectSmokeAndWeather(d);
    });

    EW.$("evs-hotspots-box").addEventListener("click", (e) => {
      const btn = e.target.closest(".hotspot-row");
      if (!btn) return;
      flyToHotspot(parseFloat(btn.dataset.lat), parseFloat(btn.dataset.lon), btn.dataset.label, parseInt(btn.dataset.count, 10), parseFloat(btn.dataset.frp));
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
      renderHotspotsBox(null, true);
      renderChecksTab(null, res);
      inspectSmokeAndWeather(d.target || null);
    });

    EW.$("btn-toggle-wind").addEventListener("click", (e) => {
      E.windEnabled = !E.windEnabled;
      e.currentTarget.setAttribute("aria-pressed", E.windEnabled ? "true" : "false");
      drawSmokeCone(E.lastTarget, E.lastWeather);
    });

    // Compare Modal
    EW.$("btn-compare").addEventListener("click", () => {
      populateCompareSelects();
      renderCompare();
      openModal("modal-compare");
    });

    // Guided Tour
    EW.$("btn-evs-tour").addEventListener("click", () => showTourStep(0));
    EW.$("btn-tour-exit").addEventListener("click", () => { EW.$("tour-float").hidden = true; });
    EW.$("btn-tour-prev").addEventListener("click", () => showTourStep(E.tourIdx - 1));
    EW.$("btn-tour-next").addEventListener("click", () => {
      if (E.tourIdx >= 3) { EW.$("tour-float").hidden = true; return; }
      showTourStep(E.tourIdx + 1);
    });

    // Science & Export Modals
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
        closeModal("modal-compare");
      }
    });

    window.EW_EVS = {
      get lastTarget() { return E.lastTarget; },
      get lastWeather() { return E.lastWeather; },
      haversineKm,
      bearingDeg,
      downloadFile,
    };
    handleRegionChange(EW.currentRegion());
  }

  if (typeof window !== "undefined" && window.EW && window.EW.map) {
    initEVS();
  } else if (typeof document !== "undefined") {
    document.addEventListener("ew-ready", initEVS);
  }
})();
