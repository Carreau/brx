# brx — local BRouter routing with gpx.studio-style editing, state in the URL

Single-page app, no build step. Plain ES modules loaded from `index.html`.
Leaflet 1.9 comes from CDN. All app files live at the repo root under `js/`.

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
