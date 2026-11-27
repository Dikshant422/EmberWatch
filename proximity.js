/**
 * proximity.js - EmberWatch Proximity & Corridor Screening Module
 * 
 * Implements:
 * 1. Point Radius Check (pin on map / geocoding search + radius buffer)
 * 2. Route Corridor Check (waypoints / road routing via OSRM + corridor buffer)
 * 3. Proximity query over cells.json data
 * 4. Dual-mode UI integration (Region mode <-> Proximity Check mode)
 */
(function () {
  "use strict";

  // --- Math Utilities ---
  const R_EARTH = 6371.0; // km
  const DEG2RAD = Math.PI / 180;

  function haversine(lat1, lon1, lat2, lon2) {
    const dLat = (lat2 - lat1) * DEG2RAD;
    const dLon = (lon2 - lon1) * DEG2RAD;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
              Math.cos(lat1 * DEG2RAD) * Math.cos(lat2 * DEG2RAD) *
              Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * R_EARTH * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  function pointToSegmentDist(pLat, pLon, aLat, aLon, bLat, bLon) {
    if (aLat === bLat && aLon === bLon) {
      return haversine(pLat, pLon, aLat, aLon);
    }
    const midLat = ((aLat + bLat) / 2) * DEG2RAD;
    const cosLat = Math.cos(midLat);

    const bx = (bLon - aLon) * cosLat * 111.32;
    const by = (bLat - aLat) * 110.574;
    const px = (pLon - aLon) * cosLat * 111.32;
    const py = (pLat - aLat) * 110.574;

    const segLenSq = bx * bx + by * by;
    if (segLenSq === 0) return haversine(pLat, pLon, aLat, aLon);

    const t = Math.max(0, Math.min(1, (px * bx + py * by) / segLenSq));
    const projX = t * bx;
    const projY = t * by;

    const dx = px - projX;
    const dy = py - projY;
    return Math.sqrt(dx * dx + dy * dy);
  }

  function createCorridorPolygon(points, bufferKm) {
    if (!points || points.length < 2) return [];
    const leftPoints = [];
    const rightPoints = [];

    for (let i = 0; i < points.length; i++) {
      let dx = 0, dy = 0;
      const curr = points[i];

      if (i === 0) {
        const next = points[1];
        dx = next.lon - curr.lon;
        dy = next.lat - curr.lat;
      } else if (i === points.length - 1) {
        const prev = points[i - 1];
        dx = curr.lon - prev.lon;
        dy = curr.lat - prev.lat;
      } else {
        const prev = points[i - 1];
        const next = points[i + 1];
        dx = next.lon - prev.lon;
        dy = next.lat - prev.lat;
      }

      const cosLat = Math.cos(curr.lat * DEG2RAD);
      const mx = dx * cosLat;
      const my = dy;
      const len = Math.sqrt(mx * mx + my * my);

      if (len === 0) continue;

      const nx = -my / len;
      const ny = mx / len;

      const dLat = (bufferKm / 110.574) * ny;
      const dLon = (bufferKm / (111.32 * Math.max(0.1, cosLat))) * nx;

      leftPoints.push([curr.lat + dLat, curr.lon + dLon]);
      rightPoints.push([curr.lat - dLat, curr.lon - dLon]);
    }

    return leftPoints.concat(rightPoints.reverse());
  }

  function queryCells(cells, geometry, bufferKm) {
    if (!cells || !geometry) return { matches: [], totalFRP: 0, totalDetections: 0, nearestKm: null };

    let minLat = 90, maxLat = -90, minLon = 180, maxLon = -180;
    const pts = geometry.type === "point" ? [geometry.point] : geometry.points;
    if (!pts || pts.length === 0) {
      return { matches: [], totalFRP: 0, totalDetections: 0, nearestKm: null };
    }

    for (const p of pts) {
      minLat = Math.min(minLat, p.lat);
      maxLat = Math.max(maxLat, p.lat);
      minLon = Math.min(minLon, p.lon);
      maxLon = Math.max(maxLon, p.lon);
    }

    const latMargin = bufferKm / 110.0 + 0.3;
    const lonMargin = bufferKm / (111.0 * Math.max(0.1, Math.cos(((minLat + maxLat) / 2) * DEG2RAD))) + 0.3;

    const bMinLat = minLat - latMargin;
    const bMaxLat = maxLat + latMargin;
    const bMinLon = minLon - lonMargin;
    const bMaxLon = maxLon + lonMargin;

    const matches = [];
    let totalFRP = 0;
    let totalDetections = 0;
    let nearestKm = Infinity;

    for (let i = 0; i < cells.length; i++) {
      const c = cells[i];
      const clat = c[0];
      const clon = c[1];

      if (clat < bMinLat || clat > bMaxLat || clon < bMinLon || clon > bMaxLon) {
        continue;
      }

      let dMin = Infinity;
      let matchedSeg = -1;

      if (geometry.type === "point") {
        dMin = haversine(clat, clon, geometry.point.lat, geometry.point.lon);
      } else if (geometry.type === "route") {
        const segs = geometry.points;
        for (let s = 0; s < segs.length - 1; s++) {
          const d = pointToSegmentDist(clat, clon, segs[s].lat, segs[s].lon, segs[s + 1].lat, segs[s + 1].lon);
          if (d < dMin) {
            dMin = d;
            matchedSeg = s;
          }
        }
      }

      if (dMin <= bufferKm) {
        matches.push({
          cell: c,
          distKm: Math.round(dMin * 10) / 10,
          segIdx: matchedSeg
        });
        totalFRP += c[3];
        totalDetections += c[2];
        if (dMin < nearestKm) nearestKm = dMin;
      }
    }

    matches.sort((a, b) => a.distKm - b.distKm);

    return {
      matches,
      totalFRP: Math.round(totalFRP),
      totalDetections,
      nearestKm: nearestKm === Infinity ? null : Math.round(nearestKm * 10) / 10
    };
  }

  // --- Proximity Module State ---
  const P = {
    active: false,
    submode: "point", // "point" | "route"
    bufferKm: 25,
    point: null,      // { lat, lon, label }
    waypoints: [],    // [{ lat, lon, label }, ...]
    roadPoints: null, // [{ lat, lon }, ...] active snapped route
    roadDistanceKm: null,
    routes: [],       // OSRM alternative routes [{ idx, rawPoints, points, distanceKm, durationMin, result, isSafest }]
    selectedRouteIdx: 0,
    isSnapping: false,
    lastResult: null,

    // Leaflet Layers
    geomGroup: null,
    cellGroup: null
  };

  function downsamplePoints(pts, maxPts = 120) {
    if (!pts || pts.length <= maxPts) return pts;
    const step = (pts.length - 1) / (maxPts - 1);
    const out = [];
    for (let i = 0; i < maxPts - 1; i++) out.push(pts[Math.round(i * step)]);
    out.push(pts[pts.length - 1]);
    return out;
  }

  const esc = (t) => String(t || "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
  const nf = new Intl.NumberFormat("en-US");

  function getVerdict(totalFRP) {
    if (totalFRP === 0) return { label: "Clear", cls: "verdict-clear", desc: "No fire detections within buffer zone" };
    if (totalFRP <= 500) return { label: "Low Activity", cls: "verdict-low", desc: "Few fire detections nearby" };
    if (totalFRP <= 5000) return { label: "Moderate Activity", cls: "verdict-mod", desc: "Notable fire detections within buffer" };
    return { label: "High Activity", cls: "verdict-high", desc: "Significant fire detections along corridor / radius" };
  }

  // --- External APIs (Nominatim & OSRM) ---
  async function searchPlace(query) {
    if (!query || !query.trim()) return null;
    const url = "https://nominatim.openstreetmap.org/search?format=json&limit=1&q=" + encodeURIComponent(query.trim());
    try {
      const res = await fetch(url, { headers: { "Accept": "application/json" } });
      if (!res.ok) throw new Error("Search service returned status " + res.status);
      const data = await res.json();
      if (!data || data.length === 0) return null;
      return {
        lat: parseFloat(data[0].lat),
        lon: parseFloat(data[0].lon),
        name: data[0].display_name.split(",")[0]
      };
    } catch (err) {
      console.warn("Nominatim geocoding error:", err);
      return null;
    }
  }

  async function fetchOSRMRoute(waypoints) {
    if (!waypoints || waypoints.length < 2) return null;
    const coordsStr = waypoints.map((w) => w.lon + "," + w.lat).join(";");
    const url = "https://router.project-osrm.org/route/v1/driving/" + coordsStr + "?overview=full&geometries=geojson&alternatives=true";
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error("OSRM routing returned status " + res.status);
      const data = await res.json();
      if (data.code !== "Ok" || !data.routes || !data.routes.length) return null;
      const routes = data.routes.slice(0, 3).map((route, idx) => {
        const rawPoints = route.geometry.coordinates.map((c) => ({ lon: c[0], lat: c[1] }));
        return {
          idx,
          rawPoints,
          points: downsamplePoints(rawPoints, 120),
          distanceKm: Math.round(route.distance / 100) / 10,
          durationMin: Math.round((route.duration || 0) / 60),
          result: null,
          isSafest: false,
        };
      });
      return {
        routes,
        points: routes[0].points,
        distanceKm: routes[0].distanceKm
      };
    } catch (err) {
      console.warn("OSRM routing failed, falling back to straight line:", err);
      return null;
    }
  }

  function scoreRoutes(cells) {
    if (!P.routes || !P.routes.length || !cells) return;
    let safestIdx = 0;
    for (let i = 0; i < P.routes.length; i++) {
      const rt = P.routes[i];
      rt.result = queryCells(cells, { type: "route", points: rt.points }, P.bufferKm);
      rt.isSafest = false;
      const best = P.routes[safestIdx];
      if (
        rt.result.totalFRP < best.result.totalFRP ||
        (rt.result.totalFRP === best.result.totalFRP && rt.result.totalDetections < best.result.totalDetections) ||
        (rt.result.totalFRP === best.result.totalFRP && rt.result.totalDetections === best.result.totalDetections && rt.distanceKm < best.distanceKm)
      ) {
        safestIdx = i;
      }
    }
    P.routes[safestIdx].isSafest = true;
    return safestIdx;
  }

  // --- Map Visualization in Proximity Mode ---
  function clearProximityGraphics() {
    if (P.geomGroup) P.geomGroup.clearLayers();
    if (P.cellGroup) P.cellGroup.clearLayers();
  }

  function renderProximityMap() {
    const EW = window.EW;
    if (!EW || !EW.map) return;
    const map = EW.map;

    if (!P.geomGroup) {
      P.geomGroup = L.featureGroup().addTo(map);
    }
    if (!P.cellGroup) {
      P.cellGroup = L.featureGroup().addTo(map);
    }

    clearProximityGraphics();

    // 1. Draw Geometry (Pin/Circle or Route/Buffer)
    let activeGeometry = null;

    if (P.submode === "point" && P.point) {
      activeGeometry = { type: "point", point: P.point };

      // Circle buffer
      const circle = L.circle([P.point.lat, P.point.lon], {
        radius: P.bufferKm * 1000,
        color: "#FF6F59",
        weight: 2,
        fillColor: "#FF8E75",
        fillOpacity: 0.12
      });
      P.geomGroup.addLayer(circle);

      // Pin marker
      const pinIcon = L.divIcon({
        className: "prox-pin-icon",
        html: '<div class="prox-pin" title="' + esc(P.point.label || "Point") + '"></div>',
        iconSize: [24, 24],
        iconAnchor: [12, 24]
      });
      const marker = L.marker([P.point.lat, P.point.lon], { icon: pinIcon });
      marker.bindTooltip("<strong>" + esc(P.point.label || "Selected point") + "</strong><br>" +
                         P.point.lat.toFixed(2) + "°N, " + P.point.lon.toFixed(2) + "°E");
      P.geomGroup.addLayer(marker);

    } else if (P.submode === "route" && P.waypoints.length > 0) {
      // Draw waypoints
      P.waypoints.forEach((wp, idx) => {
        const wpIcon = L.divIcon({
          className: "prox-wp-icon",
          html: '<div class="prox-waypoint">' + (idx + 1) + '</div>',
          iconSize: [22, 22],
          iconAnchor: [11, 11]
        });
        const m = L.marker([wp.lat, wp.lon], { icon: wpIcon });
        m.bindTooltip("<strong>Waypoint " + (idx + 1) + "</strong>: " + esc(wp.label || (wp.lat.toFixed(2) + ", " + wp.lon.toFixed(2))));
        P.geomGroup.addLayer(m);
      });

      if (P.waypoints.length >= 2) {
        let pts = P.roadPoints || P.waypoints;
        let rawPts = pts;

        if (P.routes && P.routes.length > 0 && EW.S && EW.S.cells && EW.S.cells.cells) {
          scoreRoutes(EW.S.cells.cells);
          const sel = P.routes[P.selectedRouteIdx] || P.routes[0];
          pts = sel.points;
          rawPts = sel.rawPoints;
          P.roadPoints = sel.points;
          P.roadDistanceKm = sel.distanceKm;

          // Draw unselected alternative routes as clickable dashed lines
          P.routes.forEach((rt, idx) => {
            if (idx === P.selectedRouteIdx) return;
            const altLine = L.polyline(rt.rawPoints.map((p) => [p.lat, p.lon]), {
              color: "#685850",
              weight: 3.5,
              opacity: 0.65,
              dashArray: "7, 7",
            });
            altLine.bindTooltip(
              "<strong>Route " + (idx + 1) + (rt.isSafest ? " (Lowest Exposure)" : "") + "</strong><br>" +
              rt.distanceKm + " km · " + nf.format(rt.result ? rt.result.totalFRP : 0) + " MW exposure<br><em>Click to switch</em>"
            );
            altLine.on("click", (ev) => {
              L.DomEvent.stopPropagation(ev);
              P.selectedRouteIdx = idx;
              renderProximityMap();
            });
            P.geomGroup.addLayer(altLine);
          });
        }

        activeGeometry = { type: "route", points: pts };

        // Corridor buffer polygon
        const corridorCoords = createCorridorPolygon(pts, P.bufferKm);
        if (corridorCoords.length > 0) {
          const poly = L.polygon(corridorCoords, {
            color: "#FF6F59",
            weight: 1.8,
            dashArray: "4, 4",
            fillColor: "#FF8E75",
            fillOpacity: 0.1
          });
          P.geomGroup.addLayer(poly);
        }

        // Active route line
        const selRoute = P.routes && P.routes[P.selectedRouteIdx];
        const isClean = selRoute && selRoute.result && selRoute.result.totalFRP === 0;
        const line = L.polyline(rawPts.map((p) => [p.lat, p.lon]), {
          color: P.roadPoints ? (isClean ? "#1F7A4D" : "#2A8382") : "#FF6F59",
          weight: 4,
          opacity: 0.95
        });
        P.geomGroup.addLayer(line);
      }
    }

    // 2. Query Cells and Highlight
    if (activeGeometry && EW.S && EW.S.cells && EW.S.cells.cells) {
      const res = queryCells(EW.S.cells.cells, activeGeometry, P.bufferKm);
      P.lastResult = res;

      // Draw matched cells on cellGroup
      for (const m of res.matches) {
        const r = m.cell; // [lat, lon, count, frp, cidx, sidx]
        const col = EW.frpColour(r[3]);
        const circle = L.circleMarker([r[0], r[1]], {
          renderer: EW.canvas,
          radius: Math.min(14, 3 + 1.2 * Math.sqrt(r[2])),
          fillColor: col,
          fillOpacity: 0.9,
          color: "#FFFFFF",
          weight: 1.5
        });

        circle.bindTooltip(
          "<strong>" + nf.format(r[2]) + " fire detections</strong><br>" +
          nf.format(Math.round(r[3])) + " MW total FRP<br>" +
          "<em>" + m.distKm + " km from " + (P.submode === "point" ? "pin" : "corridor") + "</em>"
        );
        P.cellGroup.addLayer(circle);
      }

      // Zoom to geometry + cells
      if (P.geomGroup.getLayers().length > 0) {
        map.fitBounds(P.geomGroup.getBounds().pad(0.18), { animate: true });
      }
    } else {
      P.lastResult = null;
    }

    renderProximitySummary();
    renderProximityTable();
  }

  // --- Render Results in Panels ---
  function renderProximitySummary() {
    const EW = window.EW;
    const box = EW.$("summary-body");
    const readout = EW.$("selection-readout");
    if (!box) return;

    if (!P.point && P.waypoints.length === 0) {
      readout.textContent = P.submode === "point"
        ? "Proximity Check · Click map or search place to screen"
        : "Corridor Check · Add waypoints or search places along route";

      box.innerHTML =
        '<p class="sum-name">Proximity Screening</p>' +
        '<p class="muted">' +
        (P.submode === "point"
          ? "Click on the map or type a place name above to inspect fire detections within your chosen radius."
          : "Click 2 or more points on the map to define your transit corridor, or enter cities above.") +
        '</p>';

      document.dispatchEvent(new CustomEvent("ew-proximity-result", {
        detail: {
          result: { matches: [], totalFRP: 0, totalDetections: 0, nearestKm: null },
          verdict: { label: "Ready", cls: "verdict-low", desc: "Select a location or route to screen" },
          bufferKm: P.bufferKm,
          label: "Proximity",
          target: null,
        }
      }));
      return;
    }

    const res = P.lastResult || { matches: [], totalFRP: 0, totalDetections: 0, nearestKm: null };
    const verdict = getVerdict(res.totalFRP);

    let titleText = "";
    let inspectTarget = null;
    if (P.submode === "point") {
      titleText = "Point Radius (" + P.bufferKm + " km)";
      readout.textContent = "Point: " + (P.point.label || (P.point.lat.toFixed(2) + "°, " + P.point.lon.toFixed(2) + "°")) +
        " · " + nf.format(res.totalDetections) + " fire detections within " + P.bufferKm + " km";
      inspectTarget = {
        lat: P.point.lat, lon: P.point.lon,
        label: P.point.label || "Selected Pin",
        count: res.totalDetections, frp: res.totalFRP
      };
    } else {
      const distInfo = P.roadDistanceKm ? " (~" + P.roadDistanceKm + " km road)" : " (" + P.waypoints.length + " waypoints)";
      titleText = "Corridor" + distInfo;
      readout.textContent = "Corridor (" + P.bufferKm + " km buffer): " + nf.format(res.totalDetections) +
        " fire detections · " + nf.format(res.totalFRP) + " MW FRP";
      const pts = P.roadPoints || P.waypoints;
      const mid = pts[Math.floor(pts.length / 2)];
      if (mid) {
        inspectTarget = {
          lat: mid.lat, lon: mid.lon,
          label: "Route Midpoint",
          count: res.totalDetections, frp: res.totalFRP
        };
      }
    }

    let h = '<p class="sum-name">' + esc(titleText) + '</p>';
    h += '<div class="prox-verdict ' + verdict.cls + '">' + esc(verdict.label) + '</div>';
    h += '<p class="muted" style="margin: 0 0 10px; font-size: 13px;">' + esc(verdict.desc) + '</p>';

    h += '<div class="prox-metric-row">';
    h += '<div class="prox-card"><div class="val">' + nf.format(res.totalDetections) + '</div><div class="lbl">Detections</div></div>';
    h += '<div class="prox-card"><div class="val">' + nf.format(res.totalFRP) + ' MW</div><div class="lbl">Total FRP</div></div>';
    h += '<div class="prox-card"><div class="val">' + (res.nearestKm !== null ? res.nearestKm + ' km' : 'None') + '</div><div class="lbl">Nearest Cell</div></div>';
    h += '<div class="prox-card"><div class="val">' + res.matches.length + '</div><div class="lbl">Active Cells</div></div>';
    h += '</div>';

    // Fire-Aware Safe Route Alternatives Comparison
    if (P.submode === "route" && P.routes && P.routes.length > 0) {
      h += '<h3>Safe Route Alternatives (' + P.routes.length + ')</h3>';
      h += '<div class="route-alt-list">';
      P.routes.forEach((rt, idx) => {
        const active = idx === P.selectedRouteIdx;
        const rRes = rt.result || { totalDetections: 0, totalFRP: 0 };
        h += '<button type="button" class="route-alt-card' + (active ? ' active' : '') + '" data-route-idx="' + idx + '">' +
          '<div class="route-alt-top"><span><b>Route ' + (idx + 1) + '</b> · ' + rt.distanceKm + ' km (' + rt.durationMin + ' min)</span>' +
          (rt.isSafest ? '<span class="tier t-safe">Safest</span>' : '') + '</div>' +
          '<div class="route-alt-sub">' + nf.format(rRes.totalDetections) + ' detections · ' + nf.format(rRes.totalFRP) + ' MW FRP</div>' +
          '</button>';
      });
      h += '</div>';
    } else if (P.submode === "route" && P.waypoints.length >= 2 && res.matches.length > 0) {
      h += '<h3>Segment Breakdown</h3>';
      h += '<table class="prox-legs-table"><thead><tr><th>Leg</th><th>Detections</th><th>FRP (MW)</th></tr></thead><tbody>';
      for (let s = 0; s < P.waypoints.length - 1; s++) {
        const segMatches = res.matches.filter((m) => m.segIdx === s);
        const legDets = segMatches.reduce((acc, m) => acc + m.cell[2], 0);
        const legFRP = Math.round(segMatches.reduce((acc, m) => acc + m.cell[3], 0));
        const fromLabel = P.waypoints[s].label || ("Pt " + (s + 1));
        const toLabel = P.waypoints[s + 1].label || ("Pt " + (s + 2));
        h += '<tr><td>' + esc(fromLabel) + ' → ' + esc(toLabel) + '</td><td>' + nf.format(legDets) + '</td><td>' + nf.format(legFRP) + '</td></tr>';
      }
      h += '</tbody></table>';
    }

    box.innerHTML = h;

    box.querySelectorAll(".route-alt-card").forEach((btn) => {
      btn.addEventListener("click", () => {
        P.selectedRouteIdx = parseInt(btn.dataset.routeIdx, 10);
        renderProximityMap();
      });
    });

    document.dispatchEvent(new CustomEvent("ew-proximity-result", {
      detail: { result: res, verdict, bufferKm: P.bufferKm, label: titleText, target: inspectTarget }
    }));
  }

  function renderProximityTable() {
    const EW = window.EW;
    const body = EW.$("table-body");
    const title = EW.$("table-title");
    if (!body || !title) return;

    const qf = EW.$("table-quick-filters");
    if (qf) qf.hidden = true;

    title.textContent = P.submode === "point"
      ? "Fire detection cells near selected location"
      : "Fire detection cells along route corridor";

    const res = P.lastResult;
    if (!res || !res.matches || res.matches.length === 0) {
      body.innerHTML = '<p class="muted">No fire detection cells found within ' + P.bufferKm + ' km of the selected target.</p>';
      return;
    }

    const stateList = EW.S && EW.S.cells ? EW.S.cells.states : [];
    const countryList = EW.S && EW.S.cells ? EW.S.cells.countries : [];

    let h = '<div class="tscroll" tabindex="0"><table class="ptable"><thead><tr>' +
      '<th scope="col" class="num rk">#</th>' +
      '<th scope="col">Region</th>' +
      '<th scope="col" class="num">Distance</th>' +
      '<th scope="col" class="num">Detections</th>' +
      '<th scope="col" class="num">FRP (MW)</th>' +
      '<th scope="col">Coordinates</th>' +
      '</tr></thead><tbody>';

    res.matches.forEach((m, idx) => {
      const c = m.cell;
      const cName = c[4] >= 0 && countryList[c[4]] ? countryList[c[4]] : "Unassigned";
      const sName = c[5] >= 0 && stateList[c[5]] ? stateList[c[5]].replace(/^[^|]+\|/, "") : cName;
      h += '<tr>' +
        '<td class="num rk">' + (idx + 1) + '</td>' +
        '<td>' + esc(sName) + '</td>' +
        '<td class="num">' + m.distKm + ' km</td>' +
        '<td class="num">' + nf.format(c[2]) + '</td>' +
        '<td class="num">' + nf.format(Math.round(c[3])) + '</td>' +
        '<td>' + c[0].toFixed(2) + '°, ' + c[1].toFixed(2) + '°</td>' +
        '</tr>';
    });

    h += '</tbody></table></div>';
    body.innerHTML = h;
  }

  // --- Mode Switching & Interactions ---
  function activateProximityMode() {
    const EW = window.EW;
    if (!EW || !EW.map) return;
    P.active = true;

    document.body.classList.add("proximity-active");
    EW.$("btn-mode-region").setAttribute("aria-pressed", "false");
    EW.$("btn-mode-proximity").setAttribute("aria-pressed", "true");
    EW.$("region-controls").hidden = true;
    EW.$("proximity-controls").hidden = false;
    if (EW.$("timeline-dock")) EW.$("timeline-dock").hidden = true;

    // Hide normal cell layer
    if (EW.layer) {
      EW.layer.remove();
    }

    renderProximityMap();
  }

  function deactivateProximityMode() {
    const EW = window.EW;
    if (!EW || !EW.map) return;
    P.active = false;

    document.body.classList.remove("proximity-active");
    EW.$("btn-mode-region").setAttribute("aria-pressed", "true");
    EW.$("btn-mode-proximity").setAttribute("aria-pressed", "false");
    EW.$("region-controls").hidden = false;
    EW.$("proximity-controls").hidden = true;
    if (EW.$("timeline-dock")) EW.$("timeline-dock").hidden = false;

    clearProximityGraphics();

    // Restore normal map cells, KPIs, priority table & selection panels
    EW.renderSelection();
  }

  function setSubmode(mode) {
    P.submode = mode;
    const EW = window.EW;
    EW.$("btn-submode-point").setAttribute("aria-pressed", mode === "point" ? "true" : "false");
    EW.$("btn-submode-route").setAttribute("aria-pressed", mode === "route" ? "true" : "false");
    EW.$("label-buffer").textContent = mode === "point" ? "Radius" : "Buffer (each side)";
    EW.$("btn-snap-road").hidden = (mode !== "route");

    renderProximityMap();
  }

  function handleMapClick(e) {
    if (!P.active) return;
    const lat = Math.round(e.latlng.lat * 1000) / 1000;
    const lon = Math.round(e.latlng.lng * 1000) / 1000;

    if (P.submode === "point") {
      P.point = { lat, lon, label: lat + "°N, " + lon + "°E" };
      renderProximityMap();
    } else if (P.submode === "route") {
      if (P.waypoints.length >= 20) {
        alert("Maximum 20 waypoints per route corridor.");
        return;
      }
      P.waypoints.push({ lat, lon, label: lat + "°, " + lon + "°" });
      P.roadPoints = null; // reset snapped road geometry on manual waypoint edit
      P.roadDistanceKm = null;
      P.routes = [];
      P.selectedRouteIdx = 0;
      renderProximityMap();
    }
  }

  async function handleSearch() {
    const input = window.EW.$("input-place-search");
    const val = input.value;
    if (!val || !val.trim()) return;

    const btn = window.EW.$("btn-place-search");
    btn.disabled = true;
    btn.textContent = "...";

    const place = await searchPlace(val);
    btn.disabled = false;
    btn.textContent = "Search";

    if (!place) {
      alert("Place not found on OpenStreetMap. You can click directly on the map to place your target.");
      return;
    }

    if (P.submode === "point") {
      P.point = { lat: place.lat, lon: place.lon, label: place.name };
      renderProximityMap();
    } else if (P.submode === "route") {
      if (P.waypoints.length >= 20) {
        alert("Maximum 20 waypoints per route corridor.");
        return;
      }
      P.waypoints.push({ lat: place.lat, lon: place.lon, label: place.name });
      P.roadPoints = null;
      P.roadDistanceKm = null;
      P.routes = [];
      P.selectedRouteIdx = 0;
      renderProximityMap();
    }
    input.value = "";
  }

  async function handleSnapRoad() {
    if (P.waypoints.length < 2) {
      alert("Add at least 2 waypoints before finding safe highway routes.");
      return;
    }

    const btn = window.EW.$("btn-snap-road");
    btn.disabled = true;
    btn.textContent = "Routing...";

    const res = await fetchOSRMRoute(P.waypoints);
    btn.disabled = false;
    btn.textContent = "Find Safe Routes";

    if (!res) {
      alert("Could not fetch road route from OSRM. Using direct straight-line corridor.");
      P.roadPoints = null;
      P.roadDistanceKm = null;
      P.routes = [];
      P.selectedRouteIdx = 0;
    } else {
      P.routes = res.routes || [];
      const EW = window.EW;
      const bestIdx = (EW && EW.S && EW.S.cells) ? scoreRoutes(EW.S.cells.cells) : 0;
      P.selectedRouteIdx = bestIdx || 0;
      const sel = P.routes[P.selectedRouteIdx] || P.routes[0];
      P.roadPoints = sel ? sel.points : res.points;
      P.roadDistanceKm = sel ? sel.distanceKm : res.distanceKm;
    }
    renderProximityMap();
  }

  function handleClear() {
    P.point = null;
    P.waypoints = [];
    P.roadPoints = null;
    P.roadDistanceKm = null;
    P.routes = [];
    P.selectedRouteIdx = 0;
    P.lastResult = null;
    renderProximityMap();
  }

  // --- Initialize when app.js signals ready ---
  function init() {
    const EW = window.EW;
    if (!EW || !EW.map) {
      console.warn("EW not ready for proximity init");
      return;
    }

    // Attach map click handler
    EW.map.on("click", handleMapClick);

    // Mode Toggle Buttons
    EW.$("btn-mode-region").addEventListener("click", deactivateProximityMode);
    EW.$("btn-mode-proximity").addEventListener("click", activateProximityMode);

    // Sub-mode Buttons
    EW.$("btn-submode-point").addEventListener("click", () => setSubmode("point"));
    EW.$("btn-submode-route").addEventListener("click", () => setSubmode("route"));

    // Buffer dropdown
    EW.$("sel-buffer").addEventListener("change", (e) => {
      P.bufferKm = parseInt(e.target.value, 10) || 25;
      renderProximityMap();
    });

    // Place Search
    EW.$("btn-place-search").addEventListener("click", handleSearch);
    EW.$("input-place-search").addEventListener("keydown", (e) => {
      if (e.key === "Enter") handleSearch();
    });

    // Snap to road & Clear
    EW.$("btn-snap-road").addEventListener("click", handleSnapRoad);
    EW.$("btn-clear-proximity").addEventListener("click", handleClear);

    // Unified command search OSM jump
    document.addEventListener("ew-jump-place", (e) => {
      const q = e.detail && e.detail.query;
      if (!q) return;
      if (!P.active) activateProximityMode();
      setSubmode("point");
      EW.$("input-place-search").value = q;
      handleSearch();
    });

    console.log("proximity.js initialized successfully.");
  }

  if (typeof window !== "undefined" && window.EW && window.EW.map) {
    init();
  } else if (typeof document !== "undefined") {
    document.addEventListener("ew-ready", init);
  }

  // Export for testing
  window.EW_Proximity = {
    haversine,
    pointToSegmentDist,
    createCorridorPolygon,
    queryCells,
    get state() { return P; }
  };

})();
