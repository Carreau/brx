# brx

A hybrid of [gpx.studio](https://gpx.studio) and [BRouter-web](https://brouter.de/brouter-web/): gpx.studio-style route editing on a Leaflet map, **routing computed entirely in the browser** (works offline on a phone), **all state in the URL hash** (shareable links, Back button = undo).

## Quick start

```sh
npm install
npm run dev              # open the printed URL
```

Click the map to add waypoints. The route is computed offline using downloaded OSM data. Click the route line to insert a via point, drag markers to move them, right-click a marker to delete it.

## 100% static

```sh
npm run build           # → dist/
npm run preview         # serve the build locally
```

Deploy `dist/` to any static host (GitHub Pages, Netlify, etc.). Served over https (or localhost) enables the service worker.

## Offline routing

While online, click "Download visible area" — road data comes from [Overpass API](https://overpass-api.de/) (mirrors: `kumi.systems`, `private.coffee`), is compiled to a compact typed-array graph, and stored in IndexedDB. A Web Worker routes with A* (no elevation data in this mode). Profiles: `bike` (default), `foot`, `car`.

## PWA

Hand-written service worker precaches the app shell and caches OpenStreetMap tiles (LRU cap ~2000). After one online visit, the whole app—including viewed map areas—works offline. HTTPS (or localhost) required.

## Optional online engine

Switch the Engine select to "BRouter (online)" for elevation profiles and climb stats (endpoint defaults to `brouter.de`, configurable). Profiles: `trekking`, `fastbike`, `car-fast`, `shortest`, `hiking-mountain`.

## URL hash format

```
#map=13/48.85840/2.29450&pts=48.85840,2.29450;48.86000,2.31000&profile=bike&rt=<endpoint>
```

| param | meaning | default |
|---|---|---|
| `map=zoom/lat/lng` | map view | unset |
| `pts=lat,lng;…` | routing waypoints | unset |
| `profile=` | profile name | `bike` |
| `rt=` | routing endpoint (BRouter URL) | unset (use local engine) |

Waypoint edits push history entries; Back = undo.

## Editing & export

- Click map to add waypoint; click route to insert via point
- Drag markers to move; right-click to delete
- Reverse route, clear all
- GPX export (track + route points for re-import) and import (rtept > wpt > downsampled trkpt)
- Segment-level caching: dragging one waypoint recomputes only adjacent segments

## Architecture

| file | role |
|---|---|
| `js/app.js` | integration, state, segment cache |
| `js/map.js` | Leaflet wrapper (markers, polylines, interactions) |
| `js/urlstate.js` | hash ⇄ state (pure) |
| `js/localgraph.js` | graph build from Overpass + A* (pure) |
| `js/localrouting.js` | main-thread facade for offline routing |
| `js/router-worker.js` | worker: owns IndexedDB, merged graph, routes |
| `js/routing.js` | BRouter HTTP client |
| `js/elevation.js` | canvas elevation profile |
| `js/gpx.js` | GPX export/import |
| `js/pwa.js` | service worker registration |
| `public/sw.js` | service worker (precache + tile cache) |

Vite + vanilla ES modules. No deps beyond Leaflet.
