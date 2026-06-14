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
  };

  // ---- State ----
  let map, routeLayer, markerLayer;
  let current = {
    lineId: null,
    direction: "outbound",
    data: { outbound: null, inbound: null }, // parsed sequences
  };
  let arrivalsTimer = null;
  let activeStop = null; // { id, name }

  // ---------- Map ----------
  function initMap() {
    map = L.map("map", { zoomControl: true, attributionControl: true }).setView(
      [51.5074, -0.1278],
      11
    );
    L.tileLayer(
      "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
      {
        attribution:
          '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/">CARTO</a> · Data: <a href="https://tfl.gov.uk">TfL</a>',
        subdomains: "abcd",
        maxZoom: 19,
      }
    ).addTo(map);
    routeLayer = L.layerGroup().addTo(map);
    markerLayer = L.layerGroup().addTo(map);
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

  // ---------- Cache ----------
  function cacheKey(lineId, dir) {
    return `route:${lineId}:${dir}`;
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

    const lineStrings = (raw.lineStrings || []).map((s) => {
      const coords = JSON.parse(s); // [[lon,lat], ...]
      return coords.map((c) => [c[1], c[0]]); // -> [lat,lon] for Leaflet
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
      map.fitBounds(L.latLngBounds(allLatLngs).pad(0.08));
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
  async function selectStop(stop) {
    activeStop = stop;
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
      const url = `${API}/StopPoint/${encodeURIComponent(activeStop.id)}/Arrivals?lineIds=${encodeURIComponent(current.lineId)}`;
      let arrivals = await getJSON(url);
      // TfL's lineIds filter is unreliable at hub stops — enforce it client-side
      // so the panel only shows the route the user actually selected.
      arrivals = arrivals.filter(
        (a) => String(a.lineId).toLowerCase() === current.lineId
      );
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

  // Pause polling when tab hidden; resume + refresh when visible.
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      stopArrivalsPolling();
    } else if (activeStop && !els.panel.classList.contains("hidden")) {
      refreshArrivals();
      startArrivalsPolling();
    }
  });

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
    // New route — close any open arrivals panel from a previous route.
    closePanel();
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

  initMap();
})();
