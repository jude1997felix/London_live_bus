/* London Live — Bus tracker
 * Data: TfL Unified API (https://api.tfl.gov.uk)
 *
 * Design goals (keep the site light):
 *  - Fetch nothing until the user picks a route.
 *  - Cache route geometry + stop lists in localStorage (they rarely change).
 *  - Poll ONLY the selected stop's arrivals, every 30s.
 *  - Pause polling when the tab is hidden.
 */

(function () {
  "use strict";

  const API = "https://api.tfl.gov.uk";
  const appKey = (window.TFL_CONFIG && window.TFL_CONFIG.appKey) || "";
  const ROUTE_CACHE_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days
  const ARRIVALS_INTERVAL = 30000; // 30s

  // ---- DOM ----
  const els = {
    form: document.getElementById("search-form"),
    input: document.getElementById("route-input"),
    searchBtn: document.getElementById("search-btn"),
    status: document.getElementById("status"),
    routeMeta: document.getElementById("route-meta"),
    routeTitle: document.getElementById("route-title"),
    stopList: document.getElementById("stop-list"),
    dirBtns: Array.from(document.querySelectorAll(".dir-btn")),
    panel: document.getElementById("arrivals-panel"),
    apName: document.getElementById("ap-stop-name"),
    apBody: document.getElementById("ap-body"),
    apClose: document.getElementById("ap-close"),
    apRefreshNote: document.getElementById("ap-refresh-note"),
    nearmeBtn: document.getElementById("nearme-btn"),
    nearbyMeta: document.getElementById("nearby-meta"),
    nearbyList: document.getElementById("nearby-list"),
    nearbyTitle: document.getElementById("nearby-title"),
    busPanel: document.getElementById("bus-panel"),
    bpTitle: document.getElementById("bp-title"),
    bpBody: document.getElementById("bp-body"),
    bpClose: document.getElementById("bp-close"),
    bpNote: document.getElementById("bp-note"),
    // Mode switch + journey planner
    modeTrack: document.getElementById("mode-track"),
    modePlan: document.getElementById("mode-plan"),
    trackMode: document.getElementById("track-mode"),
    planMode: document.getElementById("plan-mode"),
    planForm: document.getElementById("plan-form"),
    fromInput: document.getElementById("from-input"),
    toInput: document.getElementById("to-input"),
    planBtn: document.getElementById("plan-btn"),
    planStatus: document.getElementById("plan-status"),
    locBtns: Array.from(document.querySelectorAll(".loc-btn")),
    journeyResults: document.getElementById("journey-results"),
    journeyList: document.getElementById("journey-list"),
    journeyTitle: document.getElementById("journey-title"),
  };

  // ---- State ----
  let map, routeLayer, markerLayer, busLayer, meLayer, journeyLayer;
  let journeys = []; // last planned journey options
  let selectedJourneyIdx = -1;
  let journeyEndpoints = { from: "", to: "" }; // resolved start/end labels
  let current = {
    lineId: null,
    direction: "outbound",
    data: { outbound: null, inbound: null }, // parsed sequences
  };
  let arrivalsTimer = null;
  let activeStop = null; // { id, name }
  let activeStopAllLines = false; // near-me stops show every line, not one route
  let lastRouteBounds = null; // extent of the currently drawn route

  // Live-bus tracking state
  const VEHICLE_POLL_INTERVAL = 30000; // refresh predictions every 30s
  const DEFAULT_SEGMENT_SECS = 90; // fallback inter-stop travel time
  let vehiclePollTimer = null;
  let busTickTimer = null;
  let vehicles = new Map(); // vehicleId -> { marker, prev, next, tts, segSecs, dest, upcoming }
  let selectedVehicleId = null; // vehicle whose upcoming-stops panel is open
  let busPanelTimer = null;

  // Greater London bounding box — the default map view frames roughly this.
  const LONDON_BOUNDS = L.latLngBounds([51.28, -0.52], [51.70, 0.33]);

  // ---------- Map ----------
  function initMap() {
    map = L.map("map", { zoomControl: true, attributionControl: true });
    // Default: show Greater London until the user picks a route.
    map.fitBounds(LONDON_BOUNDS);

    L.tileLayer(
      "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png",
      {
        attribution:
          '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/">CARTO</a> · Data: <a href="https://tfl.gov.uk">TfL</a>',
        subdomains: "abcd",
        maxZoom: 19,
      }
    ).addTo(map);
    routeLayer = L.layerGroup().addTo(map);
    markerLayer = L.layerGroup().addTo(map);
    busLayer = L.layerGroup().addTo(map);
    meLayer = L.layerGroup().addTo(map);
    journeyLayer = L.layerGroup().addTo(map);
    // Whenever the map container changes size (mobile layout shifts, the
    // sidebar growing, scroll settling), recompute Leaflet's size so tiles
    // fill the whole viewport instead of leaving blank gaps.
    if (window.ResizeObserver) {
      let raf;
      const ro = new ResizeObserver(() => {
        cancelAnimationFrame(raf);
        raf = requestAnimationFrame(() => map.invalidateSize());
      });
      ro.observe(document.getElementById("map"));
    }
  }

  // ---------- Fetch helpers ----------
  function withKey(url) {
    if (!appKey) return url;
    return url + (url.includes("?") ? "&" : "?") + "app_key=" + encodeURIComponent(appKey);
  }

  async function getJSON(url) {
    const res = await fetch(withKey(url));
    if (!res.ok) {
      const err = new Error("HTTP " + res.status);
      err.status = res.status;
      throw err;
    }
    return res.json();
  }

  // Recursively pull [lon,lat] pairs out of TfL's variably-nested lineString
  // arrays and push them as [lat,lon] (Leaflet order).
  function extractCoords(node, out) {
    if (!Array.isArray(node)) return;
    if (node.length === 2 && typeof node[0] === "number" && typeof node[1] === "number") {
      out.push([node[1], node[0]]);
    } else {
      node.forEach((child) => extractCoords(child, out));
    }
  }

  // ---------- Cache ----------
  // Bump the version suffix whenever the parse/shape of cached data changes,
  // so old (bad) entries are ignored instead of reused.
  const CACHE_VERSION = "v2";
  function cacheKey(lineId, dir) {
    return `route:${CACHE_VERSION}:${lineId}:${dir}`;
  }
  function readCache(lineId, dir) {
    try {
      const raw = localStorage.getItem(cacheKey(lineId, dir));
      if (!raw) return null;
      const obj = JSON.parse(raw);
      if (Date.now() - obj.t > ROUTE_CACHE_TTL) return null;
      return obj.v;
    } catch {
      return null;
    }
  }
  function writeCache(lineId, dir, value) {
    try {
      localStorage.setItem(cacheKey(lineId, dir), JSON.stringify({ t: Date.now(), v: value }));
    } catch {
      /* storage full / disabled — ignore */
    }
  }

  // ---------- Route loading ----------
  // Returns { name, stops: [{id,name,lat,lon}], lineStrings: [[ [lat,lon], ... ]] }
  async function loadRoute(lineId, dir) {
    const cached = readCache(lineId, dir);
    if (cached) return cached;

    const url = `${API}/Line/${encodeURIComponent(lineId)}/Route/Sequence/${dir}?serviceTypes=Regular`;
    const raw = await getJSON(url);

    const seq = (raw.stopPointSequences || [])[0] || {};
    const stops = (seq.stopPoint || []).map((s) => ({
      id: s.id,
      name: s.name,
      lat: s.lat,
      lon: s.lon,
    }));

    // TfL encodes each lineString as a JSON string, but the nesting depth
    // varies (sometimes [[lon,lat],...], sometimes [[[lon,lat],...]]). Walk it
    // recursively, pull out every [lon,lat] pair, and flip to [lat,lon].
    const lineStrings = (raw.lineStrings || []).map((s) => {
      const out = [];
      extractCoords(JSON.parse(s), out);
      return out;
    });

    const result = { name: raw.lineName || lineId, stops, lineStrings };
    writeCache(lineId, dir, result);
    return result;
  }

  // ---------- Rendering ----------
  function drawRoute(route) {
    routeLayer.clearLayers();
    markerLayer.clearLayers();

    const allLatLngs = [];

    route.lineStrings.forEach((latlngs) => {
      // Shadow underlay for contrast, then the red route line.
      L.polyline(latlngs, { color: "#000", weight: 7, opacity: 0.35 }).addTo(routeLayer);
      L.polyline(latlngs, { color: "#e01e2b", weight: 4, opacity: 0.95 }).addTo(routeLayer);
      latlngs.forEach((p) => allLatLngs.push(p));
    });

    route.stops.forEach((stop, i) => {
      if (stop.lat == null || stop.lon == null) return;
      const isTerminus = i === 0 || i === route.stops.length - 1;
      const marker = L.marker([stop.lat, stop.lon], {
        icon: L.divIcon({
          className: "",
          html: `<div class="stop-marker${isTerminus ? " terminus" : ""}"></div>`,
          iconSize: isTerminus ? [16, 16] : [12, 12],
          iconAnchor: isTerminus ? [8, 8] : [6, 6],
        }),
      });
      marker.on("click", () => selectStop(stop));
      marker.addTo(markerLayer);
      allLatLngs.push([stop.lat, stop.lon]);
    });

    if (allLatLngs.length) {
      // Remember the route's extent so we can (re-)fit it after any layout
      // change, then zoom to frame the whole route now.
      lastRouteBounds = L.latLngBounds(allLatLngs);
      map.fitBounds(lastRouteBounds, { padding: [30, 30] });
    }
  }

  function renderStopList(route) {
    els.stopList.innerHTML = "";
    route.stops.forEach((stop) => {
      const li = document.createElement("li");
      li.textContent = stop.name;
      li.dataset.id = stop.id;
      li.addEventListener("click", () => {
        selectStop(stop);
        if (stop.lat != null) map.panTo([stop.lat, stop.lon]);
      });
      els.stopList.appendChild(li);
    });
  }

  function highlightStopInList(stopId) {
    Array.from(els.stopList.children).forEach((li) => {
      li.classList.toggle("active", li.dataset.id === stopId);
    });
  }

  // ---------- Arrivals (live, polled) ----------
  // allLines=true (near-me stops) shows every route calling at the stop;
  // otherwise it's filtered to the selected route.
  async function selectStop(stop, allLines) {
    closeBusPanel(); // don't show stop + bus panels at once
    activeStop = stop;
    activeStopAllLines = !!allLines;
    highlightStopInList(stop.id);
    els.panel.classList.remove("hidden");
    els.apName.textContent = stop.name;
    els.apBody.innerHTML = '<div class="ap-empty">Loading live arrivals…</div>';
    stopArrivalsPolling();
    await refreshArrivals();
    startArrivalsPolling();
  }

  async function refreshArrivals() {
    if (!activeStop) return;
    try {
      const url = `${API}/StopPoint/${encodeURIComponent(activeStop.id)}/Arrivals`;
      let arrivals = await getJSON(url);
      if (!activeStopAllLines) {
        // TfL's lineIds filter is unreliable at hub stops — enforce it
        // client-side so the panel only shows the selected route.
        arrivals = arrivals.filter(
          (a) => String(a.lineId).toLowerCase() === current.lineId
        );
      }
      arrivals.sort((a, b) => a.timeToStation - b.timeToStation);
      arrivals = arrivals.slice(0, 8);
      renderArrivals(arrivals);
    } catch (e) {
      els.apBody.innerHTML = `<div class="ap-empty">Couldn't load arrivals (${e.status || "network"}). Retrying…</div>`;
    }
  }

  function renderArrivals(arrivals) {
    if (!arrivals.length) {
      els.apBody.innerHTML = '<div class="ap-empty">No predicted arrivals right now.</div>';
    } else {
      els.apBody.innerHTML = arrivals
        .map((a) => {
          const mins = Math.round(a.timeToStation / 60);
          const label = mins <= 0 ? "Due" : mins + " min";
          return `
            <div class="arrival">
              <span class="arr-line">${escapeHtml(a.lineName)}</span>
              <span class="arr-dest">${escapeHtml(a.destinationName || a.towards || "")}</span>
              <span class="arr-time${mins <= 0 ? " due" : ""}">${label}</span>
            </div>`;
        })
        .join("");
    }
    els.apRefreshNote.textContent = "Live · updates every 30s · " + new Date().toLocaleTimeString();
  }

  function startArrivalsPolling() {
    stopArrivalsPolling();
    if (document.hidden) return;
    arrivalsTimer = setInterval(refreshArrivals, ARRIVALS_INTERVAL);
  }
  function stopArrivalsPolling() {
    if (arrivalsTimer) {
      clearInterval(arrivalsTimer);
      arrivalsTimer = null;
    }
  }

  // Pause all polling/animation when the tab is hidden; resume when visible.
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      stopArrivalsPolling();
      stopVehicleTracking();
    } else {
      if (activeStop && !els.panel.classList.contains("hidden")) {
        refreshArrivals();
        startArrivalsPolling();
      }
      // Resume live buses if a route is currently displayed.
      if (current.lineId && current.data[current.direction]) startVehicleTracking();
    }
  });

  // ---------- Live bus positions ----------
  // TfL doesn't expose raw bus GPS, but Line/{id}/Arrivals gives every
  // vehicle's countdown to each upcoming stop. We place each bus on the
  // segment before the stop it's approaching and glide it as the countdown
  // ticks down — a faithful approximation of where the bus actually is.
  const BUS_TICK_MS = 250;

  function busDivIcon() {
    return L.divIcon({
      className: "bus-marker",
      html: '<div class="bus-icon">🚌</div>',
      iconSize: [24, 24],
      iconAnchor: [12, 12],
    });
  }

  function positionBus(v) {
    const f = Math.max(0, Math.min(1, 1 - v.tts / v.segSecs));
    const lat = v.prev.lat + (v.next.lat - v.prev.lat) * f;
    const lon = v.prev.lon + (v.next.lon - v.prev.lon) * f;
    v.marker.setLatLng([lat, lon]);
  }

  async function refreshVehicles() {
    const route = current.data[current.direction];
    if (!route || !route.stops.length) return;

    const idx = new Map();
    route.stops.forEach((s, i) => idx.set(s.id, i));

    let preds;
    try {
      preds = await getJSON(`${API}/Line/${encodeURIComponent(current.lineId)}/Arrivals`);
    } catch {
      return; // keep last-known positions on a transient error
    }
    // Only this direction, and only stops that are on the drawn route.
    preds = preds.filter((p) => p.direction === current.direction && idx.has(p.naptanId));

    const byVehicle = new Map();
    preds.forEach((p) => {
      if (!byVehicle.has(p.vehicleId)) byVehicle.set(p.vehicleId, []);
      byVehicle.get(p.vehicleId).push(p);
    });

    const seen = new Set();
    byVehicle.forEach((list, vehId) => {
      list.sort((a, b) => a.timeToStation - b.timeToStation);
      const nextP = list[0];
      const nextIdx = idx.get(nextP.naptanId);
      if (nextIdx == null) return;

      const prev = route.stops[Math.max(0, nextIdx - 1)];
      const next = route.stops[nextIdx];

      // Estimate this segment's travel time from the gap between the bus's
      // next two stops; fall back to a sensible default.
      let segSecs = DEFAULT_SEGMENT_SECS;
      if (list[1]) {
        const d = list[1].timeToStation - nextP.timeToStation;
        if (d > 5 && d < 600) segSecs = d;
      }

      seen.add(vehId);
      let v = vehicles.get(vehId);
      if (!v) {
        const marker = L.marker([prev.lat, prev.lon], {
          icon: busDivIcon(),
          zIndexOffset: 1000,
        }).bindTooltip("", { direction: "top", offset: [0, -10] });
        marker.addTo(busLayer);
        marker.on("click", () => openBusPanel(vehId));
        v = { marker };
        vehicles.set(vehId, v);
      }
      v.prev = prev;
      v.next = next;
      v.tts = nextP.timeToStation;
      v.segSecs = segSecs;
      v.dest = nextP.destinationName || nextP.towards || "";
      // Full ordered list of upcoming stops, with an absolute arrival time so
      // the panel can show an accurate live countdown without drift.
      v.upcoming = list.map((p) => ({
        name: (route.stops[idx.get(p.naptanId)] || {}).name || p.stationName,
        expected: Date.parse(p.expectedArrival),
      }));
      v.marker.setTooltipContent(
        `Route ${current.lineId.toUpperCase()} → ${escapeHtml(v.dest)}<br>Next stop: ${escapeHtml(next.name)}<br><em>Click for upcoming stops</em>`
      );
      positionBus(v);
    });

    // Drop vehicles that have left the line.
    vehicles.forEach((v, id) => {
      if (!seen.has(id)) {
        busLayer.removeLayer(v.marker);
        vehicles.delete(id);
      }
    });

    // Keep an open bus panel in sync with the freshly fetched predictions.
    if (selectedVehicleId) renderBusPanel();
  }

  // ---------- Bus upcoming-stops panel ----------
  function openBusPanel(vehId) {
    selectedVehicleId = vehId;
    closePanel(); // close the stop-arrivals panel to avoid clutter
    els.busPanel.classList.remove("hidden");
    renderBusPanel();
    if (busPanelTimer) clearInterval(busPanelTimer);
    busPanelTimer = setInterval(renderBusPanel, 1000); // live countdown
  }

  function renderBusPanel() {
    const v = selectedVehicleId && vehicles.get(selectedVehicleId);
    if (!v) {
      els.bpTitle.textContent = "🚌 Bus";
      els.bpBody.innerHTML = '<div class="ap-empty">This bus has left the line.</div>';
      els.bpNote.textContent = "";
      return;
    }
    els.bpTitle.innerHTML = `🚌 Route ${escapeHtml(current.lineId.toUpperCase())} → ${escapeHtml(v.dest)}`;
    const now = Date.now();
    els.bpBody.innerHTML = (v.upcoming || [])
      .map((s, i) => {
        const mins = Math.round((s.expected - now) / 60000);
        const due = mins <= 0;
        return `
          <div class="bp-stop${i === 0 ? " next" : ""}">
            <span class="bp-name">${escapeHtml(s.name)}</span>
            <span class="bp-time${due ? " due" : ""}">${due ? "Due" : mins + " min"}</span>
          </div>`;
      })
      .join("");
    els.bpNote.textContent =
      (v.upcoming ? v.upcoming.length : 0) + " stops ahead · live · " + new Date().toLocaleTimeString();
  }

  function closeBusPanel() {
    els.busPanel.classList.add("hidden");
    selectedVehicleId = null;
    if (busPanelTimer) {
      clearInterval(busPanelTimer);
      busPanelTimer = null;
    }
  }

  function tickVehicles() {
    if (document.hidden) return;
    vehicles.forEach((v) => {
      if (v.tts > 0) {
        v.tts = Math.max(0, v.tts - BUS_TICK_MS / 1000);
        positionBus(v);
      }
    });
  }

  function startVehicleTracking() {
    stopVehicleTracking();
    if (document.hidden) return;
    refreshVehicles();
    vehiclePollTimer = setInterval(refreshVehicles, VEHICLE_POLL_INTERVAL);
    busTickTimer = setInterval(tickVehicles, BUS_TICK_MS);
  }

  function stopVehicleTracking() {
    if (vehiclePollTimer) clearInterval(vehiclePollTimer);
    if (busTickTimer) clearInterval(busTickTimer);
    vehiclePollTimer = busTickTimer = null;
    vehicles.clear();
    if (busLayer) busLayer.clearLayers();
    closeBusPanel();
  }

  // ---------- Stops near me (geolocation) ----------
  function findNearMe() {
    if (!navigator.geolocation) {
      setStatus("Geolocation isn't supported by this browser.", "error");
      return;
    }
    setStatus("Locating you…", "loading");
    els.nearmeBtn.disabled = true;
    navigator.geolocation.getCurrentPosition(onPosition, onGeoError, {
      enableHighAccuracy: true,
      timeout: 10000,
      maximumAge: 60000,
    });
  }

  function onGeoError(err) {
    els.nearmeBtn.disabled = false;
    setStatus(
      err.code === err.PERMISSION_DENIED
        ? "Location permission denied — allow it to find nearby stops."
        : "Couldn't get your location. Try again.",
      "error"
    );
  }

  // Search radii (metres) tried in order — start modest to keep the response
  // small, widen only if nothing is found nearby.
  const NEARBY_RADII = [1500, 3000];

  async function fetchStopsWithin(lat, lon, radius) {
    const url =
      `${API}/StopPoint?stopTypes=NaptanPublicBusCoachTram&modes=bus` +
      `&radius=${radius}&useStopPointHierarchy=false&lat=${lat}&lon=${lon}`;
    const data = await getJSON(url);
    return (data.stopPoints || []).map((s) => ({
      id: s.naptanId || s.id,
      name: s.commonName,
      lat: s.lat,
      lon: s.lon,
      stopLetter: s.stopLetter,
      lines: (s.lines || []).map((l) => l.name),
      dist: haversine(lat, lon, s.lat, s.lon),
    }));
  }

  async function onPosition(pos) {
    const lat = pos.coords.latitude;
    const lon = pos.coords.longitude;
    try {
      let stops = [];
      let usedRadius = NEARBY_RADII[0];
      for (const radius of NEARBY_RADII) {
        usedRadius = radius;
        stops = await fetchStopsWithin(lat, lon, radius);
        if (stops.length) break; // widen only when the closer search is empty
      }

      if (!stops.length) {
        // Nothing found even at the widest radius — clear any stale near-me
        // view, then say why.
        els.nearbyMeta.classList.add("hidden");
        meLayer.clearLayers();
        if (!LONDON_BOUNDS.contains([lat, lon])) {
          setStatus(
            "You appear to be outside London — this app only covers London (TfL) buses.",
            "error"
          );
        } else {
          setStatus(
            `No bus stops found within ${(usedRadius / 1000).toFixed(1)} km of you.`,
            "error"
          );
        }
        return;
      }

      stops.sort((a, b) => a.dist - b.dist);
      stops = stops.slice(0, 15);
      showNearby(lat, lon, stops);
      setStatus("", "");
    } catch (e) {
      setStatus("Couldn't load nearby stops (" + (e.status || "network") + ").", "error");
    } finally {
      els.nearmeBtn.disabled = false;
    }
  }

  function showNearby(lat, lon, stops) {
    // Entering near-me mode — clear any route view and live buses.
    stopVehicleTracking();
    routeLayer.clearLayers();
    markerLayer.clearLayers();
    meLayer.clearLayers();
    els.routeMeta.classList.add("hidden");
    current.lineId = null;
    closePanel();

    els.nearbyMeta.classList.remove("hidden");
    els.nearbyTitle.textContent = stops.length + " stops near you";

    L.marker([lat, lon], {
      icon: L.divIcon({ className: "", html: '<div class="me-marker"></div>', iconSize: [16, 16], iconAnchor: [8, 8] }),
      zIndexOffset: 500,
    })
      .addTo(meLayer)
      .bindTooltip("You are here");

    const pts = [[lat, lon]];
    els.nearbyList.innerHTML = "";
    stops.forEach((s) => {
      pts.push([s.lat, s.lon]);
      L.marker([s.lat, s.lon], {
        icon: L.divIcon({ className: "", html: '<div class="nearby-marker"></div>', iconSize: [12, 12], iconAnchor: [6, 6] }),
      })
        .addTo(meLayer)
        .bindTooltip(s.name)
        .on("click", () => selectStop(s, true));

      const lines = s.lines.slice(0, 10).join(", ");
      const li = document.createElement("li");
      li.innerHTML =
        `<div class="nb-name">${escapeHtml(s.name)}` +
        (s.stopLetter ? ` <span class="nb-sub">(Stop ${escapeHtml(s.stopLetter)})</span>` : "") +
        `</div><div class="nb-sub">${Math.round(s.dist)} m away${lines ? " · " + escapeHtml(lines) : ""}</div>`;
      li.addEventListener("click", () => {
        selectStop(s, true);
        map.panTo([s.lat, s.lon]);
      });
      els.nearbyList.appendChild(li);
    });

    map.fitBounds(L.latLngBounds(pts).pad(0.25));
    document.getElementById("map").scrollIntoView({ behavior: "smooth", block: "nearest" });
    setTimeout(() => map.invalidateSize(), 350);
  }

  function haversine(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  }

  // ---------- Mode switch (Track / Plan) ----------
  function setMode(mode) {
    const plan = mode === "plan";
    els.modePlan.classList.toggle("active", plan);
    els.modeTrack.classList.toggle("active", !plan);
    els.planMode.classList.toggle("hidden", !plan);
    els.trackMode.classList.toggle("hidden", plan);

    if (plan) {
      // Hide the live-tracking overlays and any drawn route while planning,
      // so the map is clean for the journey.
      stopVehicleTracking();
      closePanel();
      routeLayer.clearLayers();
      markerLayer.clearLayers();
      meLayer.clearLayers();
      els.routeMeta.classList.add("hidden");
      els.nearbyMeta.classList.add("hidden");
    } else {
      // Leaving plan mode — clear journey drawing.
      clearJourney();
    }
    setTimeout(() => map.invalidateSize(), 200);
  }

  function clearJourney() {
    journeyLayer.clearLayers();
    journeys = [];
    selectedJourneyIdx = -1;
    els.journeyResults.classList.add("hidden");
  }

  // ---------- Journey planning ----------
  // Colours per transport mode for drawing legs + chips.
  const MODE_STYLE = {
    walking: { color: "#9aa4b2", label: "Walk", dash: "2 8" },
    bus: { color: "#e01e2b", label: "Bus" },
    tube: { color: "#2563eb", label: "Tube" },
    "national-rail": { color: "#16a34a", label: "Rail" },
    overground: { color: "#ee7c0e", label: "Overground" },
    "elizabeth-line": { color: "#6950a1", label: "Elizabeth" },
    dlr: { color: "#00a4a7", label: "DLR" },
    tram: { color: "#5fb526", label: "Tram" },
    "river-bus": { color: "#0099cc", label: "River" },
    default: { color: "#6b7280", label: "Transit" },
  };
  function modeStyle(m) {
    return MODE_STYLE[m] || MODE_STYLE.default;
  }

  function setPlanStatus(msg, cls) {
    els.planStatus.textContent = msg;
    els.planStatus.className = "status" + (cls ? " " + cls : "");
  }

  // Resolve a free-text place to "lat,lon". Returns the raw value for
  // coordinates/postcodes (TfL handles them directly) and only disambiguates
  // place names when needed.
  function looksLikeLatLon(v) {
    return /^-?\d+(\.\d+)?\s*,\s*-?\d+(\.\d+)?$/.test(v.trim());
  }

  // Fill a From/To field with the user's current coordinates.
  function useMyLocationFor(target) {
    const input = target === "to" ? els.toInput : els.fromInput;
    if (!navigator.geolocation) {
      setPlanStatus("Geolocation isn't supported by this browser.", "error");
      return;
    }
    setPlanStatus("Locating you…", "loading");
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        input.value = pos.coords.latitude.toFixed(5) + "," + pos.coords.longitude.toFixed(5);
        setPlanStatus("", "");
      },
      (err) =>
        setPlanStatus(
          err.code === err.PERMISSION_DENIED
            ? "Location permission denied."
            : "Couldn't get your location.",
          "error"
        ),
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
    );
  }

  async function planJourney() {
    const from = els.fromInput.value.trim();
    const to = els.toInput.value.trim();
    if (!from || !to) {
      setPlanStatus("Enter both a start and a destination.", "error");
      return;
    }
    setPlanStatus("Planning your journey…", "loading");
    els.planBtn.disabled = true;
    // Default labels (used when the input was already precise, e.g. coords).
    journeyEndpoints = { from: from, to: to };
    try {
      let result = await fetchJourney(from, to);

      // Place names come back as HTTP 300 with disambiguation options —
      // pick the best transit match for each side and retry with coordinates.
      if (result.disambiguation) {
        const f = pickDisambig(result.data, "fromLocationDisambiguation", from);
        const t = pickDisambig(result.data, "toLocationDisambiguation", to);
        if (!f || !t) {
          setPlanStatus("Couldn't find that place. Try a postcode or station name.", "error");
          return;
        }
        journeyEndpoints = { from: f.name, to: t.name };
        result = await fetchJourney(f.latLon, t.latLon);
        if (result.disambiguation) {
          setPlanStatus("Couldn't pin down those locations. Try more specific names.", "error");
          return;
        }
      }

      journeys = (result.data.journeys || []).slice(0, 4);
      if (!journeys.length) {
        setPlanStatus("No journeys found between those points.", "error");
        return;
      }
      setPlanStatus("", "");
      renderJourneyList();
      selectJourney(0); // show the first (recommended) option
    } catch (e) {
      setPlanStatus("Couldn't plan that journey (" + (e.status || "network") + ").", "error");
    } finally {
      els.planBtn.disabled = false;
    }
  }

  // Returns { disambiguation: bool, data }. A 300 isn't an error here.
  // Restricted to bus (+ walking) for now; other modes come later.
  async function fetchJourney(from, to) {
    const url =
      `${API}/Journey/JourneyResults/${encodeURIComponent(from)}/to/${encodeURIComponent(to)}?mode=bus`;
    const res = await fetch(withKey(url));
    if (res.status === 300) return { disambiguation: true, data: await res.json() };
    if (!res.ok) throw Object.assign(new Error("HTTP " + res.status), { status: res.status });
    return { disambiguation: false, data: await res.json() };
  }

  function pickDisambig(data, key, fallbackLabel) {
    const opts = (data[key] && data[key].disambiguationOptions) || [];
    if (!opts.length) {
      // Already a precise match for this side (only the other was ambiguous).
      return { latLon: fallbackLabel, name: fallbackLabel };
    }
    // Prefer actual transit stops/stations over arbitrary POIs (TfL's top
    // match for "Victoria" is a pub in Haringey; we want London Victoria).
    const stops = opts.filter((o) => o.place && o.place.placeType === "StopPoint");
    const pool = stops.length ? stops : opts;
    pool.sort((a, b) => (b.matchQuality || 0) - (a.matchQuality || 0));
    const place = pool[0].place;
    return { latLon: `${place.lat},${place.lon}`, name: place.commonName };
  }

  function renderJourneyList() {
    els.journeyResults.classList.remove("hidden");
    els.journeyTitle.textContent =
      `${journeyEndpoints.from} → ${journeyEndpoints.to}`;
    els.journeyList.innerHTML = "";
    journeys.forEach((j, i) => {
      const li = document.createElement("li");
      li.className = "journey";
      li.dataset.idx = i;
      li.innerHTML = journeyCardHtml(j);
      li.addEventListener("click", () => selectJourney(i));
      els.journeyList.appendChild(li);
    });
  }

  function journeyCardHtml(j, expanded) {
    const chips = j.legs
      .map((leg) => {
        const st = modeStyle(leg.mode.name);
        const line =
          leg.mode.name !== "walking" && leg.routeOptions && leg.routeOptions[0] && leg.routeOptions[0].name
            ? leg.routeOptions[0].name
            : st.label;
        return `<span class="leg-chip" style="background:${st.color}">${escapeHtml(line)}</span>`;
      })
      .join('<span class="leg-sep">›</span>');

    let html =
      `<div class="journey-head">` +
      `<span class="journey-dur">${j.duration} min</span>` +
      `<span class="journey-times">${fmtTime(j.startDateTime)} → ${fmtTime(j.arrivalDateTime)}</span>` +
      `</div><div class="journey-legs">${chips}</div>`;

    if (expanded) {
      html +=
        '<ul class="journey-steps">' +
        j.legs
          .map((leg) => {
            const st = modeStyle(leg.mode.name);
            return (
              `<li><span class="step-mins" style="color:${st.color}">${leg.duration} min</span>` +
              `<span class="step-text">${escapeHtml(leg.instruction.summary)}</span></li>`
            );
          })
          .join("") +
        "</ul>";
    }
    return html;
  }

  function selectJourney(idx) {
    selectedJourneyIdx = idx;
    // Re-render cards so only the selected one is expanded + highlighted.
    Array.from(els.journeyList.children).forEach((li, i) => {
      li.classList.toggle("active", i === idx);
      li.innerHTML = journeyCardHtml(journeys[i], i === idx);
    });
    drawJourney(journeys[idx]);
  }

  function drawJourney(j) {
    journeyLayer.clearLayers();
    const all = [];

    j.legs.forEach((leg) => {
      const st = modeStyle(leg.mode.name);
      const coords = parseLegPath(leg);
      coords.forEach((c) => all.push(c));
      if (coords.length > 1) {
        L.polyline(coords, {
          color: st.color,
          weight: leg.mode.name === "walking" ? 3 : 5,
          opacity: 0.9,
          dashArray: st.dash || null,
        }).addTo(journeyLayer);
      }
    });

    // Start (green) and end (red) markers for the whole trip.
    if (all.length) {
      addEndpoint(all[0], "#16a34a", "Start");
      addEndpoint(all[all.length - 1], "#e01e2b", "Destination");
      map.fitBounds(L.latLngBounds(all), { padding: [40, 40] });
    }
    document.getElementById("map").scrollIntoView({ behavior: "smooth", block: "nearest" });
    setTimeout(() => map.invalidateSize(), 250);
  }

  function addEndpoint(latlng, color, label) {
    L.marker(latlng, {
      icon: L.divIcon({
        className: "",
        html: `<div class="me-marker" style="background:${color}"></div>`,
        iconSize: [16, 16],
        iconAnchor: [8, 8],
      }),
      zIndexOffset: 600,
    })
      .addTo(journeyLayer)
      .bindTooltip(label);
  }

  // Leg geometry is a JSON string of coordinate pairs; order varies, so detect
  // which element is the latitude (London lat ~51, lon ~0).
  function parseLegPath(leg) {
    const raw = leg.path && leg.path.lineString;
    if (!raw) return [];
    let arr;
    try {
      arr = JSON.parse(raw);
    } catch {
      return [];
    }
    const out = [];
    arr.forEach((pair) => {
      if (!Array.isArray(pair) || pair.length < 2) return;
      const [a, b] = pair;
      out.push(Math.abs(a) > Math.abs(b) ? [a, b] : [b, a]);
    });
    return out;
  }

  function fmtTime(iso) {
    const d = new Date(iso);
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  // ---------- Search flow ----------
  async function handleSearch(rawValue) {
    const lineId = rawValue.trim().toLowerCase();
    if (!lineId) return;

    setStatus("Loading route " + rawValue.trim() + "…", "loading");
    els.searchBtn.disabled = true;

    try {
      current.lineId = lineId;
      current.direction = "outbound";
      current.data = { outbound: null, inbound: null };
      resetDirButtons();

      const route = await loadRoute(lineId, "outbound");
      if (!route.stops.length) throw Object.assign(new Error("empty"), { status: 404 });

      current.data.outbound = route;
      showRoute(route);
      setStatus("", "");
    } catch (e) {
      els.routeMeta.classList.add("hidden");
      if (e.status === 404) {
        setStatus(`Route "${rawValue.trim()}" not found. Check the number and try again.`, "error");
      } else if (e.status === 429) {
        setStatus("Rate limited by TfL. Add an API key in config.js, or wait a moment.", "error");
      } else {
        setStatus("Couldn't load that route. Check your connection and try again.", "error");
      }
    } finally {
      els.searchBtn.disabled = false;
    }
  }

  function showRoute(route) {
    els.routeMeta.classList.remove("hidden");
    els.routeTitle.textContent =
      `Route ${route.name} · ${route.stops.length} stops` +
      (route.stops.length
        ? ` · ${route.stops[0].name} → ${route.stops[route.stops.length - 1].name}`
        : "");
    renderStopList(route);
    drawRoute(route);
    // Leaving near-me mode if it was active.
    els.nearbyMeta.classList.add("hidden");
    meLayer.clearLayers();
    // New route — close any open arrivals panel from a previous route.
    closePanel();
    // Start (or restart) the live bus overlay for this route + direction.
    startVehicleTracking();
    // Bring the map into view (matters on mobile, where it sits below the
    // sidebar). Once the scroll/layout settles, recompute the map size and
    // re-fit the route so the zoom is correct for the final container size.
    document.getElementById("map").scrollIntoView({ behavior: "smooth", block: "nearest" });
    setTimeout(() => {
      map.invalidateSize();
      if (lastRouteBounds) map.fitBounds(lastRouteBounds, { padding: [30, 30] });
    }, 350);
  }

  async function switchDirection(dir) {
    if (!current.lineId || dir === current.direction) return;
    current.direction = dir;
    setStatus("Loading " + dir + "…", "loading");
    try {
      if (!current.data[dir]) {
        current.data[dir] = await loadRoute(current.lineId, dir);
      }
      showRoute(current.data[dir]);
      setStatus("", "");
    } catch (e) {
      setStatus("No " + dir + " route available for this service.", "error");
      // revert toggle highlight
      resetDirButtons();
    }
  }

  // ---------- UI helpers ----------
  function setStatus(msg, cls) {
    els.status.textContent = msg;
    els.status.className = "status" + (cls ? " " + cls : "");
  }
  function resetDirButtons() {
    els.dirBtns.forEach((b) => b.classList.toggle("active", b.dataset.dir === current.direction));
  }
  function closePanel() {
    els.panel.classList.add("hidden");
    stopArrivalsPolling();
    activeStop = null;
    highlightStopInList(null);
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
    );
  }

  // ---------- Wire up ----------
  els.form.addEventListener("submit", (e) => {
    e.preventDefault();
    handleSearch(els.input.value);
  });
  els.dirBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      els.dirBtns.forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      switchDirection(btn.dataset.dir);
    });
  });
  els.apClose.addEventListener("click", closePanel);
  els.bpClose.addEventListener("click", closeBusPanel);
  els.nearmeBtn.addEventListener("click", findNearMe);

  // Mode switch (Track route / Plan journey)
  els.modeTrack.addEventListener("click", () => setMode("track"));
  els.modePlan.addEventListener("click", () => setMode("plan"));
  els.planForm.addEventListener("submit", (e) => {
    e.preventDefault();
    planJourney();
  });
  els.locBtns.forEach((btn) =>
    btn.addEventListener("click", () => useMyLocationFor(btn.dataset.target))
  );

  initMap();
})();
