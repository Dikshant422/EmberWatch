/* field_intel.js - Protected Eco-Zones, Critical Assets & Field Ground-Truth Verification Log */
(function () {
  "use strict";

  const STORAGE_KEY = "ew-field-verifications-v1";

  const CAUSES = {
    wildfire:       { label: "Confirmed Wildfire", code: "W", color: "#DC2626" },
    agriculture:    { label: "Agricultural Crop Burn", code: "A", color: "#D97706" },
    industrial:     { label: "Industrial / Gas Flare", code: "I", color: "#6D28D9" },
    prescribed:     { label: "Controlled Burn", code: "C", color: "#217A79" },
    false_positive: { label: "False Positive / Cloud", code: "FP", color: "#685850" },
  };

  const ASSET_TYPES = {
    eco:      { label: "Protected Eco-Zone", color: "#1F7A4D", badge: "ECO" },
    hospital: { label: "Hospital / Clinic", color: "#DC2626", badge: "MED" },
    school:   { label: "School / Campus", color: "#D97706", badge: "EDU" },
    infra:    { label: "Power / Infra", color: "#6D28D9", badge: "PWR" },
  };

  const F = {
    assetsLayer: null,
    verifiedLayer: null,
    assetCache: new Map(), // "lat,lon" -> assets[]
    lastAssets: [],
    lastScanCenter: null,
    scanning: false,
    verifications: [],
    activeFormTarget: null,
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function loadVerifications() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      F.verifications = raw ? JSON.parse(raw) : [];
    } catch {
      F.verifications = [];
    }
  }

  function saveVerifications() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(F.verifications));
    } catch (e) {
      console.warn("Could not persist verifications:", e);
    }
  }

  // --- Feature 2: Protected Eco-Zones & Critical Infrastructure (Nominatim Viewbox) ---
  async function queryNominatimCategory(query, catKey, bbox) {
    const viewbox = bbox.west.toFixed(3) + "," + bbox.north.toFixed(3) + "," + bbox.east.toFixed(3) + "," + bbox.south.toFixed(3);
    const url = "https://nominatim.openstreetmap.org/search?format=json&limit=8&bounded=1&viewbox=" +
      viewbox + "&q=" + encodeURIComponent(query);
    try {
      const res = await fetch(url, { headers: { "Accept": "application/json" } });
      if (!res.ok) return [];
      const data = await res.json();
      if (!Array.isArray(data)) return [];
      return data.map((d) => ({
        id: d.osm_type + "_" + d.osm_id,
        name: d.name || d.display_name.split(",")[0],
        fullName: d.display_name,
        category: catKey,
        osmType: d.type,
        lat: parseFloat(d.lat),
        lon: parseFloat(d.lon),
        bbox: Array.isArray(d.boundingbox) && d.boundingbox.length === 4 ? d.boundingbox.map(Number) : null,
      }));
    } catch {
      return [];
    }
  }

  function evaluateAssetRisk(asset) {
    const EW = window.EW;
    const EVS = window.EW_EVS;
    if (!EW || !EVS || !EW.S || !EW.S.cells) return asset;

    const cells = EW.S.cells.cells;
    let minKm = Infinity;
    let nearFrp = 0;
    for (let i = 0; i < cells.length; i++) {
      const c = cells[i];
      if (Math.abs(c[0] - asset.lat) > 1.0 || Math.abs(c[1] - asset.lon) > 1.0) continue;
      const d = EVS.haversineKm(asset.lat, asset.lon, c[0], c[1]);
      if (d < minKm) { minKm = d; nearFrp = c[3]; }
    }

    let inSmokeCone = false;
    const tgt = EVS.lastTarget;
    const wx = EVS.lastWeather;
    if (tgt && wx && wx.windDir != null && wx.windSpeed != null) {
      const downwindBrg = (wx.windDir + 180) % 360;
      const plumeKm = Math.max(28, Math.min(95, wx.windSpeed * 3.5));
      const dToAsset = EVS.haversineKm(tgt.lat, tgt.lon, asset.lat, asset.lon);
      if (dToAsset <= plumeKm) {
        const brg = EVS.bearingDeg(tgt.lat, tgt.lon, asset.lat, asset.lon);
        const diff = Math.abs(((brg - downwindBrg + 540) % 360) - 180);
        if (diff <= 24) inSmokeCone = true;
      }
    }

    const nearestFireKm = minKm === Infinity ? null : Math.round(minKm * 10) / 10;
    const atRisk = (nearestFireKm !== null && nearestFireKm <= 20) || inSmokeCone;
    return { ...asset, nearestFireKm, nearFrp: Math.round(nearFrp), inSmokeCone, atRisk };
  }

  async function scanNearbyAssets() {
    const EW = window.EW;
    const EVS = window.EW_EVS;
    if (!EW || !EW.map) return;

    const tgt = (EVS && EVS.lastTarget) || (() => {
      const c = EW.map.getCenter();
      return { lat: c.lat, lon: c.lng, label: "Map Center" };
    })();

    const key = tgt.lat.toFixed(1) + "," + tgt.lon.toFixed(1);
    F.lastScanCenter = tgt;

    if (F.assetCache.has(key)) {
      F.lastAssets = F.assetCache.get(key).map(evaluateAssetRisk).sort((a, b) => (a.nearestFireKm ?? 999) - (b.nearestFireKm ?? 999));
      drawAssetsOnMap();
      renderAssetsBox();
      return;
    }

    F.scanning = true;
    renderAssetsBox();

    const spanLat = 0.45;
    const spanLon = 0.45 / Math.max(0.25, Math.cos(tgt.lat * Math.PI / 180));
    const bbox = {
      south: Math.max(-85, tgt.lat - spanLat),
      north: Math.min(85, tgt.lat + spanLat),
      west: tgt.lon - spanLon,
      east: tgt.lon + spanLon,
    };

    // Polite staggered queries to respect Nominatim limits
    const qList = [
      ["national park", "eco"],
      ["nature reserve", "eco"],
      ["hospital", "hospital"],
      ["school", "school"],
      ["substation", "infra"],
    ];

    const seen = new Set();
    const collected = [];
    for (const [q, cat] of qList) {
      const items = await queryNominatimCategory(q, cat, bbox);
      for (const it of items) {
        if (!seen.has(it.id)) {
          seen.add(it.id);
          collected.push(it);
        }
      }
      await sleep(260);
    }

    F.scanning = false;
    F.assetCache.set(key, collected);
    F.lastAssets = collected.map(evaluateAssetRisk).sort((a, b) => (a.nearestFireKm ?? 999) - (b.nearestFireKm ?? 999));
    drawAssetsOnMap();
    renderAssetsBox();
  }

  function drawAssetsOnMap() {
    const EW = window.EW;
    if (!EW || !EW.map) return;
    if (!F.assetsLayer) F.assetsLayer = L.featureGroup().addTo(EW.map);
    F.assetsLayer.clearLayers();

    for (const a of F.lastAssets) {
      const meta = ASSET_TYPES[a.category] || ASSET_TYPES.infra;
      if (a.category === "eco" && a.bbox) {
        const bounds = [[a.bbox[0], a.bbox[2]], [a.bbox[1], a.bbox[3]]];
        L.rectangle(bounds, {
          color: a.atRisk ? "#DC2626" : meta.color,
          weight: 1.8,
          dashArray: "5, 4",
          fillColor: meta.color,
          fillOpacity: 0.12,
        }).bindTooltip("<strong>" + EW.esc(a.name) + "</strong><br>Protected Eco-Zone").addTo(F.assetsLayer);
      }

      const icon = L.divIcon({
        className: "asset-pin-wrap",
        html: '<div class="asset-pin' + (a.atRisk ? ' at-risk' : '') + '" style="background:' + meta.color + '">' + meta.badge + '</div>',
        iconSize: [34, 20],
        iconAnchor: [17, 10],
      });
      const marker = L.marker([a.lat, a.lon], { icon });
      marker.bindTooltip(
        "<strong>" + EW.esc(a.name) + "</strong> (" + meta.label + ")<br>" +
        (a.nearestFireKm != null ? ("Nearest fire cell: <b>" + a.nearestFireKm + " km</b> (" + EW.nf.format(a.nearFrp) + " MW)") : "No fire cell nearby") +
        (a.inSmokeCone ? "<br><span style='color:#DC2626;font-weight:700'>Inside Live Smoke Drift Cone!</span>" : "")
      );
      F.assetsLayer.addLayer(marker);
    }
  }

  function clearAssetsFromMap() {
    F.lastAssets = [];
    if (F.assetsLayer) F.assetsLayer.clearLayers();
    renderAssetsBox();
  }

  function renderAssetsBox() {
    const EW = window.EW;
    const box = EW && EW.$("evs-assets-box");
    if (!box) return;

    const tgt = (window.EW_EVS && window.EW_EVS.lastTarget) || null;
    const tgtLbl = tgt ? tgt.label : "current map center";

    let h = '<div class="evs-card">' +
      '<div class="evs-card-title"><span>Eco-Zones &amp; Critical Assets (SDG 15/11)</span><span>~50 km</span></div>' +
      '<p class="muted" style="font-size:12px;margin:0 0 10px">Scan OSM for Protected Parks, Hospitals, Schools &amp; Power Substations near <b>' + EW.esc(tgtLbl) + '</b> and score proximity to fire &amp; live smoke.</p>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap">' +
      '<button type="button" id="btn-scan-assets" class="btn-action" style="height:36px;font-size:12.5px"' + (F.scanning ? ' disabled' : '') + '>' +
      (F.scanning ? 'Scanning OSM…' : 'Scan Nearby Parks &amp; Assets') + '</button>' +
      (F.lastAssets.length ? '<button type="button" id="btn-clear-assets" class="btn-action secondary" style="height:36px;font-size:12.5px">Clear Pins</button>' : '') +
      '</div>';

    if (F.scanning) {
      h += '<div class="skeleton-block" style="height:90px;margin-top:10px"></div>';
    } else if (F.lastAssets.length > 0) {
      const counts = { eco: 0, hospital: 0, school: 0, infra: 0 };
      let atRiskCount = 0;
      F.lastAssets.forEach((a) => { counts[a.category]++; if (a.atRisk) atRiskCount++; });

      h += '<div class="asset-summary-pills">' +
        '<span class="asset-pill eco">' + counts.eco + ' Parks</span>' +
        '<span class="asset-pill med">' + counts.hospital + ' Hospitals</span>' +
        '<span class="asset-pill edu">' + counts.school + ' Schools</span>' +
        '<span class="asset-pill pwr">' + counts.infra + ' Power</span>' +
        (atRiskCount ? '<span class="asset-pill risk">' + atRiskCount + ' At-Risk</span>' : '') +
        '</div>';

      h += '<div class="hotspot-list" style="max-height:190px;overflow-y:auto">';
      F.lastAssets.slice(0, 18).forEach((a) => {
        const meta = ASSET_TYPES[a.category];
        h += '<button type="button" class="hotspot-row asset-fly" data-lat="' + a.lat + '" data-lon="' + a.lon + '">' +
          '<span><span class="asset-dot" style="background:' + meta.color + '"></span>' + EW.esc(a.name) +
          (a.inSmokeCone ? ' <span class="tier t-high">Smoke</span>' : '') + '</span>' +
          '<span class="hotspot-frp" style="color:' + (a.atRisk ? '#DC2626' : 'var(--text-2)') + '">' +
          (a.nearestFireKm != null ? a.nearestFireKm + ' km' : 'Clear') + '</span>' +
          '</button>';
      });
      h += '</div>';
    } else if (F.lastScanCenter) {
      h += '<p class="muted" style="font-size:12px;margin:10px 0 0">No named parks or critical facilities returned in this 50 km box.</p>';
    }

    h += '</div>';
    box.innerHTML = h;

    const scanBtn = EW.$("btn-scan-assets");
    if (scanBtn) scanBtn.addEventListener("click", scanNearbyAssets);
    const clrBtn = EW.$("btn-clear-assets");
    if (clrBtn) clrBtn.addEventListener("click", clearAssetsFromMap);
    box.querySelectorAll(".asset-fly").forEach((btn) => {
      btn.addEventListener("click", () => {
        EW.map.setView([parseFloat(btn.dataset.lat), parseFloat(btn.dataset.lon)], 11, { animate: true });
      });
    });
  }

  // --- Feature 8: Field Ground-Truth Verification Log ---
  function drawVerifiedLayer() {
    const EW = window.EW;
    if (!EW || !EW.map) return;
    if (!F.verifiedLayer) F.verifiedLayer = L.featureGroup().addTo(EW.map);
    F.verifiedLayer.clearLayers();

    for (const v of F.verifications) {
      const cMeta = CAUSES[v.cause] || CAUSES.wildfire;
      const icon = L.divIcon({
        className: "verified-pin-wrap",
        html: '<div class="verified-pin" style="background:' + cMeta.color + '" title="' + EW.esc(cMeta.label) + '">' + cMeta.code + '</div>',
        iconSize: [24, 24],
        iconAnchor: [12, 12],
      });
      const m = L.marker([v.lat, v.lon], { icon });
      m.bindTooltip(
        "<strong>Verified: " + EW.esc(cMeta.label) + "</strong><br>" +
        EW.esc(v.label) + " (" + v.lat.toFixed(2) + "°, " + v.lon.toFixed(2) + "°)<br>" +
        "Source: " + EW.esc(v.source) + (v.notes ? "<br><em>" + EW.esc(v.notes) + "</em>" : "")
      );
      F.verifiedLayer.addLayer(m);
    }
  }

  function exportFieldGeoJSON() {
    const EVS = window.EW_EVS;
    if (!EVS) return;
    const fc = {
      type: "FeatureCollection",
      generated_at: new Date().toISOString(),
      features: F.verifications.map((v) => ({
        type: "Feature",
        geometry: { type: "Point", coordinates: [v.lon, v.lat] },
        properties: {
          id: v.id,
          location: v.label,
          cause_code: v.cause,
          cause_label: (CAUSES[v.cause] || CAUSES.wildfire).label,
          source: v.source,
          frp_mw: v.frp,
          detections: v.count,
          notes: v.notes,
          logged_utc: v.loggedAt,
        },
      })),
    };
    EVS.downloadFile("emberwatch-field-verifications.geojson", JSON.stringify(fc, null, 2), "application/geo+json");
  }

  function exportFieldCSV() {
    const EVS = window.EW_EVS;
    if (!EVS) return;
    const cols = ["Logged_UTC", "Location", "Lat", "Lon", "Cause", "Source", "Detections", "FRP_MW", "Notes"];
    const lines = [cols.join(",")].concat(
      F.verifications.map((v) => [
        v.loggedAt,
        '"' + String(v.label).replace(/"/g, '""') + '"',
        v.lat, v.lon,
        '"' + (CAUSES[v.cause] || CAUSES.wildfire).label + '"',
        '"' + String(v.source).replace(/"/g, '""') + '"',
        v.count || 0, Math.round(v.frp || 0),
        '"' + String(v.notes || "").replace(/"/g, '""') + '"',
      ].join(","))
    );
    EVS.downloadFile("emberwatch-field-verifications.csv", "\uFEFF" + lines.join("\n"), "text/csv;charset=utf-8;");
  }

  function renderFieldLogBox() {
    const EW = window.EW;
    const box = EW && EW.$("evs-field-log-box");
    if (!box) return;

    const tgt = F.activeFormTarget || (window.EW_EVS && window.EW_EVS.lastTarget);
    const tgtText = tgt
      ? (EW.esc(tgt.label) + " (" + tgt.lat.toFixed(2) + "°, " + tgt.lon.toFixed(2) + "°" + (tgt.frp != null ? " · " + Math.round(tgt.frp) + " MW" : "") + ")")
      : "Click any map cell or hotspot first";

    let h = '<div class="evs-card">' +
      '<div class="evs-card-title"><span>Field Ground-Truth Log</span><span>' + F.verifications.length + ' tagged</span></div>' +
      '<p class="muted" style="font-size:12px;margin:0 0 8px">Satellites detect heat, not causes. Tag ground-verified fire causes here:</p>' +
      '<div class="field-target-pill">' + tgtText + '</div>' +
      '<div class="field-form">' +
      '<label class="field"><span>Observed Cause</span><select id="fl-cause">' +
      Object.entries(CAUSES).map(([k, c]) => '<option value="' + k + '">' + c.label + '</option>').join("") +
      '</select></label>' +
      '<label class="field"><span>Verification Source</span><select id="fl-source">' +
      '<option>Satellite Imagery Check</option><option>Field Ranger Visual</option><option>Agency / News Report</option><option>Community Observation</option>' +
      '</select></label>' +
      '<label class="field"><span>Field Notes</span><input type="text" id="fl-notes" placeholder="e.g. Verified paddy stubble burn via satellite" maxlength="160"></label>' +
      '<button type="button" id="btn-save-verification" class="btn-action" style="height:38px;width:100%;justify-content:center"' + (tgt ? '' : ' disabled') + '>Save Field Verification</button>' +
      '</div>';

    if (F.verifications.length > 0) {
      const counts = {};
      F.verifications.forEach((v) => { counts[v.cause] = (counts[v.cause] || 0) + 1; });
      h += '<div class="verify-bar">' +
        Object.entries(counts).map(([k, n]) => {
          const pct = Math.round((n / F.verifications.length) * 100);
          return '<div style="width:' + pct + '%;background:' + (CAUSES[k]?.color || '#888') + '" title="' + (CAUSES[k]?.label || k) + ': ' + n + '"></div>';
        }).join("") + '</div>';

      h += '<div class="hotspot-list" style="max-height:175px;overflow-y:auto;margin-top:8px">';
      F.verifications.forEach((v) => {
        const cm = CAUSES[v.cause] || CAUSES.wildfire;
        h += '<div class="verify-item">' +
          '<div class="verify-item-main">' +
          '<span class="verify-badge" style="background:' + cm.color + '">' + cm.code + '</span>' +
          '<div><b>' + EW.esc(cm.label) + '</b><div class="muted" style="font-size:11px">' + EW.esc(v.label) + ' · ' + EW.esc(v.source) + '</div>' +
          (v.notes ? '<div style="font-size:11.5px;margin-top:2px">' + EW.esc(v.notes) + '</div>' : '') +
          '</div></div>' +
          '<div class="verify-item-btns">' +
          '<button type="button" class="v-act-btn" data-fly="' + v.id + '" title="Fly to location">Fly</button>' +
          '<button type="button" class="v-act-btn del" data-del="' + v.id + '" title="Remove entry">&times;</button>' +
          '</div></div>';
      });
      h += '</div>';

      h += '<div style="display:flex;gap:8px;margin-top:10px">' +
        '<button type="button" id="btn-dl-geojson" class="btn-action secondary" style="height:34px;font-size:12px;flex:1;justify-content:center">Export GeoJSON</button>' +
        '<button type="button" id="btn-dl-field-csv" class="btn-action secondary" style="height:34px;font-size:12px;flex:1;justify-content:center">Export CSV</button>' +
        '</div>';
    }

    h += '</div>';
    box.innerHTML = h;

    const saveBtn = EW.$("btn-save-verification");
    if (saveBtn && tgt) {
      saveBtn.addEventListener("click", () => {
        const entry = {
          id: "v_" + Date.now(),
          lat: tgt.lat,
          lon: tgt.lon,
          label: tgt.label || (tgt.lat.toFixed(2) + "°, " + tgt.lon.toFixed(2) + "°"),
          count: tgt.count || 0,
          frp: tgt.frp || 0,
          cause: EW.$("fl-cause").value,
          source: EW.$("fl-source").value,
          notes: EW.$("fl-notes").value.trim(),
          loggedAt: new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC",
        };
        F.verifications.unshift(entry);
        saveVerifications();
        drawVerifiedLayer();
        renderFieldLogBox();
      });
    }

    box.querySelectorAll("[data-fly]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const item = F.verifications.find((x) => x.id === btn.dataset.fly);
        if (item) EW.map.setView([item.lat, item.lon], 9, { animate: true });
      });
    });

    box.querySelectorAll("[data-del]").forEach((btn) => {
      btn.addEventListener("click", () => {
        F.verifications = F.verifications.filter((x) => x.id !== btn.dataset.del);
        saveVerifications();
        drawVerifiedLayer();
        renderFieldLogBox();
      });
    });

    const gjBtn = EW.$("btn-dl-geojson");
    if (gjBtn) gjBtn.addEventListener("click", exportFieldGeoJSON);
    const csvBtn = EW.$("btn-dl-field-csv");
    if (csvBtn) csvBtn.addEventListener("click", exportFieldCSV);
  }

  function initFieldIntel() {
    const EW = window.EW;
    if (!EW) return;
    loadVerifications();
    drawVerifiedLayer();
    renderAssetsBox();
    renderFieldLogBox();

    document.addEventListener("selectionchange", () => {
      F.activeFormTarget = null;
      renderAssetsBox();
      renderFieldLogBox();
    });

    document.addEventListener("ew-cell-inspect", (e) => {
      if (e.detail) {
        F.activeFormTarget = e.detail;
        renderAssetsBox();
        renderFieldLogBox();
      }
    });

    document.addEventListener("ew-proximity-result", (e) => {
      if (e.detail && e.detail.target) {
        F.activeFormTarget = e.detail.target;
      }
      renderAssetsBox();
      renderFieldLogBox();
    });
  }

  if (typeof window !== "undefined" && window.EW && window.EW.map) {
    initFieldIntel();
  } else if (typeof document !== "undefined") {
    document.addEventListener("ew-ready", initFieldIntel);
  }
})();
