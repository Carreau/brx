# brx

A hybrid of [gpx.studio](https://gpx.studio) and
[BRouter-web](https://brouter.de/brouter-web/): interactive route editing on a
map, **routing done by a local BRouter server**, and the **entire state kept in
the URL** — every route is a shareable, bookmarkable link, and Back/Forward is
undo/redo.

## Quick start

```sh
# 1. Start a local BRouter (downloads jar + segment tiles on first run)
npm run brouter          # serves http://localhost:17777/brouter

# 2. In another terminal
npm install
npm run dev              # open the printed URL
```

Click the map to add waypoints; the route between them is computed by BRouter.
Click the route line to insert a via point, drag markers to move them,
right-click a marker to delete it.

If no local BRouter is reachable, the error banner offers a one-click fallback
to the public `brouter.de` server.

## State in the URL

Everything lives in the hash, brouter-web style:

```
#map=13/48.85840/2.29450&pts=48.85840,2.29450;48.86000,2.31000&profile=trekking&rt=<endpoint>
```

- `map=zoom/lat/lng` — map view
- `pts=lat,lng;…` — routing waypoints
- `profile=` — BRouter profile (omitted when default `trekking`)
- `rt=` — BRouter endpoint (omitted when default `http://localhost:17777/brouter`)

Waypoint edits push history entries, so the browser's Back button undoes them.

## Features

- Segment-level routing with caching — dragging one waypoint only recomputes
  the two adjacent segments
- Elevation profile (canvas, hover syncs a marker on the map)
- Distance / climb / time stats
- GPX export (track + route points, so re-importing recovers your waypoints)
  and GPX import (rtept > wpt > downsampled trkpt)
- Reverse route, clear, profile picker, custom endpoint

## Routing other regions

`npm run brouter` downloads the `E0_N45` segment tile (France north, incl.
Paris) by default. Pick tiles for your region from
<https://brouter.de/brouter/segments4/> and pass them:

```sh
SEGMENTS="E5_N45 E5_N40" npm run brouter
```

See `scripts/README.md` for details.

## Stack

Vite + vanilla ES modules + Leaflet. Modules:

| file | role |
|---|---|
| `js/app.js` | integration, state, segment cache |
| `js/map.js` | Leaflet wrapper (markers, polylines, interactions) |
| `js/urlstate.js` | hash ⇄ state (pure, node-testable) |
| `js/routing.js` | BRouter HTTP client |
| `js/elevation.js` | canvas elevation profile |
| `js/gpx.js` | GPX export/import |
