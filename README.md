# London Live — Bus Tracker

A lightweight, interactive web app to monitor London buses in real time. Search a
bus route, see it drawn on the map with every stop, and click any stop for live
TfL arrival predictions.

![mode: bus](https://img.shields.io/badge/mode-bus-e01e2b)

## Features

- 🔎 **Search any London bus route** (e.g. `38`, `73`, `N29`)
- 🗺️ **Route drawn on a dark map** with all stops marked (Leaflet + OpenStreetMap)
- 🔁 **Outbound / inbound** direction toggle
- ⏱️ **Live arrivals** — click a stop for real-time "due in X min", refreshed every 30s
- 🪶 **Built to stay light** (see below)

## Keeping it light (anti-overload)

- Nothing is fetched until you pick a route.
- Route geometry + stop lists are **cached in `localStorage`** for 7 days
  (they rarely change) — only live arrivals hit the network repeatedly.
- Only the **selected stop** is polled, every 30s.
- Polling **pauses automatically when the browser tab is hidden**.

## Data source

[TfL Unified API](https://api.tfl.gov.uk) — official, free, real-time London
transport data.

## Setup

It's a static site — no build step.

### Run locally

```bash
# from the repo root
python3 -m http.server 8000
# then open http://localhost:8000
```

### (Optional) Add a TfL API key

The site works without a key, but TfL rate-limits unauthenticated traffic. For
heavier use, register a free key at <https://api-portal.tfl.gov.uk> and paste it
into [`config.js`](config.js):

```js
window.TFL_CONFIG = { appKey: "YOUR_KEY_HERE" };
```

Because this is a public static site, prefer a **domain-locked** key (set the
allowed origin in the TfL portal) so it's safe to commit.

## Deploy (GitHub Pages)

Push to `main`, then in the repo: **Settings → Pages → Source: `main` / root**.
The site will be served at `https://<user>.github.io/London_live_bus/`.

## Roadmap

- [ ] Tube / rail mode
- [ ] Stop search (jump to a stop without knowing the route)
- [ ] "Near me" using geolocation
