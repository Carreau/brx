# brx — offline in-browser routing with gpx.studio-style editing, state in the URL

Single-page app, Vite build producing a **100% static** `dist/` that runs as an
offline-capable PWA on a phone. Leaflet from npm. App files under `js/`.

## v2 pivot: offline-first

- Default routing engine is **local**: OSM data for a user-chosen region is
  downloaded from Overpass while online, compiled to a compact graph stored in
  IndexedDB, and routed with A* in a Web Worker. No server, works offline.
- A service worker precaches the app shell and runtime-caches OSM map tiles
  (cache-first) so browsed areas remain visible offline.
- BRouter becomes an optional *online* engine (`rt=` in the hash selects it).
- URL-state model unchanged: absent `rt=` ⇒ local engine. Local profiles:
  `bike` (default), `foot`, `car`. BRouter profiles unchanged.

### Region/graph data model (shared contract)

A stored region (IndexedDB db `brx`, objectStore `regions`, keyPath `id`):

```js
{
  id: string,            // crypto-ish unique id (from name + bbox)
  name: string,
  bbox: [s, w, n, e],
  createdAt: number,     // ms epoch
  nodeLat: Float64Array, // per graph node
  nodeLng: Float64Array,
  edgeA: Uint32Array,    // edge endpoints (node indices); every OSM way node
  edgeB: Uint32Array,    //   is a graph node, so edge geometry is exact
  edgeDist: Float32Array,// meters (haversine)
  edgeCls: Uint8Array,   // index into HIGHWAY_CLASSES
  edgeDir: Uint8Array,   // 0 = both ways, 1 = a->b only, 2 = b->a only
}
```

`HIGHWAY_CLASSES` (exported constant, order matters):
`motorway, motorway_link, trunk, trunk_link, primary, primary_link, secondary,
secondary_link, tertiary, tertiary_link, unclassified, residential,
living_street, service, track, cycleway, footway, path, pedestrian,
bridleway, steps`

Profile access/speed tables live in the router (worker): e.g. `car` can't use
cycleway/footway/path/steps, `bike` can't use motorway*/trunk* and walks steps
slowly, `foot` can use everything except motorway*/trunk*. `oneway` (edgeDir)
applies to car and bike, not foot.

### js/localrouting.js  (+ js/localgraph.js, js/router-worker.js)
Main-thread facade over the engine:
- `export function createLocalRouter()` →
  - `async listRegions()` → `[{id, name, bbox, createdAt, nodeCount, edgeCount, bytes}]`
  - `async downloadRegion({bbox, name, onProgress})` → region meta.
    Fetches Overpass (`[out:json]`, ways with the highway classes above,
    `out body geom`), builds the graph, stores it. `onProgress(stage, pct?)`
    with stages like `download`/`build`/`store`.
  - `async deleteRegion(id)`
  - `async routeSegment({from, to, profile, signal})` →
    `{coords: [{lat, lng}], distance, time, ascend: 0}` — same shape as
    js/routing.js but no `ele`. Throws Error('No routing data here — download
    this region first') when either endpoint snaps to nothing within ~250 m,
    Error('No route found') when A* fails.
- Worker owns graph memory (loads all stored regions, merged); main thread
  messages `{id, type: 'route'|'reload'|..., payload}` / worker replies
  `{id, ok, result|error}`. `signal` abort resolves to rejection with
  `AbortError`-named error (worker keeps computing but reply is ignored;
  A* on city graphs is fast enough).

### PWA layer
- `public/manifest.webmanifest` + icons (any simple generated placeholder).
- `public/sw.js` hand-written: versioned precache of the app shell
  (`/`, `/index.html`, `/assets/app.js`, `/assets/app.css`, manifest, icons),
  cache-first with LRU-ish cap (~2000 entries) for `tile.openstreetmap.org`,
  network-only for Overpass. Vite build must emit **unhashed** asset names
  (`assets/app.js`, `assets/app.css`) via rollupOptions so the precache list
  is stable — configured in vite.config.js.
- `js/pwa.js`: `export function registerPWA()` — registers `/sw.js` (prod
  only or when served), no-op on unsupported/file: contexts.

## Architecture

- `index.html` — shell: map div, toolbar (profile select, endpoint input, GPX
  import/export buttons, stats), elevation canvas panel, error banner.
- `js/app.js` — integration: owns the state object, wires map <-> url <-> routing.
- `js/map.js` — Leaflet wrapper (markers, polylines, click/drag handlers).
- `js/urlstate.js` — pure hash (de)serialization.  (subagent)
- `js/routing.js` — BRouter HTTP client.                (subagent)
- `js/elevation.js` — canvas elevation profile.         (subagent)
- `js/gpx.js` — GPX export + import parsing.            (subagent)
- `style.css`

## Shared state shape

```js
state = {
  map: { lat, lng, zoom } | null,     // last known map view
  points: [ { lat, lng }, ... ],      // routing waypoints, ordered
  profile: "trekking",                // brouter profile name
  endpoint: "http://localhost:17777/brouter"  // brouter base URL
}
```

Coordinates are serialized with 5 decimal places.

## URL hash format (brouter-web inspired)

```
#map=13/48.85840/2.29450&pts=48.85840,2.29450;48.86000,2.31000&profile=trekking&rt=<encodeURIComponent(endpoint)>
```

- `map=zoom/lat/lng` — optional
- `pts=lat,lng;lat,lng;...` — optional (empty/absent = no waypoints)
- `profile=<name>` — optional, default `trekking`
- `rt=<url-encoded endpoint>` — optional, only present when non-default

## Module contracts (exact exported names)

### js/urlstate.js
- `export const DEFAULT_ENDPOINT = "http://localhost:17777/brouter"`
- `export const DEFAULT_PROFILE = "trekking"`
- `export function parseHash(hash)` → full state object (missing parts filled
  with defaults, `map: null` if absent). Accepts hash with or without leading
  `#`. Never throws; skips malformed points.
- `export function buildHash(state)` → string starting with `#`. Omits
  default-valued profile/endpoint and empty pts. Round-trips with parseHash.

### js/routing.js
- `export async function routeSegment({ from, to, profile, endpoint, signal })`
  → `{ coords: [{lat, lng, ele}], distance, ascend, time }`
  - Calls `<endpoint>?lonlats=<lng>,<lat>|<lng>,<lat>&profile=<p>&alternativeidx=0&format=geojson`
  - BRouter geojson: `features[0].geometry.coordinates` = `[lng, lat, ele]`,
    `features[0].properties`: `track-length` (m, string), `filtered ascend`
    (m, string), `total-time` (s, string).
  - On non-OK response or non-JSON body, throw `Error` whose message includes
    the response text (BRouter returns plain-text error messages).
  - Must pass `signal` through to `fetch` for cancellation.

### js/elevation.js
- `export function createElevationProfile(canvas, { onHover })` →
  `{ setData(coords), setHighlight(index|null), destroy() }`
  - `coords`: `[{lat, lng, ele}]` (full concatenated route). Compute cumulative
    haversine distance internally for the x axis.
  - Draws filled area chart, axes labels (km / m), handles devicePixelRatio and
    element resize (ResizeObserver).
  - Mouse move over canvas → `onHover(index)` with nearest coord index;
    mouse leave → `onHover(null)`. Also draws a hover crosshair + ele/km label.
  - `setData([])` clears. No external deps. Style: read colors from CSS custom
    properties `--panel-bg`, `--accent`, `--text`, with fallbacks.

### js/gpx.js
- `export function toGPX({ name, coords, waypoints })` → GPX 1.1 XML string.
  `coords` `[{lat,lng,ele}]` → one `<trk>/<trkseg>` with `<ele>`; `waypoints`
  `[{lat,lng}]` → `<rtept>`s inside a `<rte>` (so re-import recovers them).
  Escape XML. `creator="brx"`.
- `export function parseGPX(text)` → `{ points: [{lat, lng}] }` routing
  waypoints, using priority: `<rte>/<rtept>` if present, else `<wpt>`s, else
  downsample `<trkpt>`s evenly to at most 25 points. Use `DOMParser`.
  Throw `Error("Invalid GPX")` on parse failure / no points.

## Conventions
- ES2022, no TypeScript, no deps beyond Leaflet CDN (integration only).
- Each module is standalone: no imports between the four subagent modules.
- Keep code compact and idiomatic; brief comments only where non-obvious.
