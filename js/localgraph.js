// Pure routing-graph logic: Overpass query, graph build/merge, nearest-node,
// A*. No DOM / Worker / IndexedDB — fully node-testable.

// Order matters: index into this array is stored in graph.edgeCls (Uint8).
export const HIGHWAY_CLASSES = [
  "motorway", "motorway_link", "trunk", "trunk_link", "primary",
  "primary_link", "secondary", "secondary_link", "tertiary", "tertiary_link",
  "unclassified", "residential", "living_street", "service", "track",
  "cycleway", "footway", "path", "pedestrian", "bridleway", "steps",
];
const CLS_INDEX = new Map(HIGHWAY_CLASSES.map((c, i) => [c, i]));

// ---- Overpass ------------------------------------------------------------

export function overpassQuery(bbox) {
  const [s, w, n, e] = bbox;
  const box = `${s},${w},${n},${e}`;
  const re = HIGHWAY_CLASSES.join("|");
  return `[out:json][timeout:90];\n` +
    `way["highway"~"^(${re})$"](${box});\n` +
    `out body geom qt;`;
}

// ---- Graph construction --------------------------------------------------

const R = 6371000; // earth radius, meters
const toRad = (d) => (d * Math.PI) / 180;
export function haversine(aLat, aLng, bLat, bLng) {
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const la1 = toRad(aLat), la2 = toRad(bLat);
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

const truthy = new Set(["yes", "true", "1"]);

// buildGraphFromOverpass(elements, bbox) -> graph (typed arrays per SPEC).
// Every OSM node on a kept way becomes a graph node; ways sharing an OSM node
// id join there. bbox is stored on the graph for meta but not used to clip.
export function buildGraphFromOverpass(elements, bbox) {
  const idToIdx = new Map();      // OSM node id -> graph node index
  const nodeLat = [], nodeLng = [];
  const edgeA = [], edgeB = [], edgeDist = [], edgeCls = [], edgeDir = [];

  const nodeIdx = (id, lat, lng) => {
    let i = idToIdx.get(id);
    if (i === undefined) {
      i = nodeLat.length;
      idToIdx.set(id, i);
      nodeLat.push(lat);
      nodeLng.push(lng);
    }
    return i;
  };

  for (const el of elements) {
    if (el.type !== "way") continue;
    const tags = el.tags || {};
    const cls = CLS_INDEX.get(tags.highway);
    if (cls === undefined) continue;
    if (tags.area === "yes") continue;
    if (tags.access === "no" || tags.access === "private") continue;

    const ids = el.nodes;
    const geom = el.geometry;
    if (!ids || !geom || ids.length < 2) continue;

    // Direction: junction=roundabout implies oneway; oneway=-1 reverses.
    let dir = 0;
    const ow = tags.oneway;
    if (tags.junction === "roundabout" && ow !== "no") dir = 1;
    if (ow === "-1" || ow === "reverse") dir = 2;
    else if (ow && truthy.has(ow)) dir = 1;

    for (let k = 0; k < ids.length - 1; k++) {
      const g = geom[k], g2 = geom[k + 1];
      if (!g || !g2) continue; // clipped geometry gap: skip this segment
      const a = nodeIdx(ids[k], g.lat, g.lon);
      const b = nodeIdx(ids[k + 1], g2.lat, g2.lon);
      if (a === b) continue;
      edgeA.push(a);
      edgeB.push(b);
      edgeDist.push(haversine(g.lat, g.lon, g2.lat, g2.lon));
      edgeCls.push(cls);
      edgeDir.push(dir);
    }
  }

  return {
    bbox,
    nodeLat: Float64Array.from(nodeLat),
    nodeLng: Float64Array.from(nodeLng),
    edgeA: Uint32Array.from(edgeA),
    edgeB: Uint32Array.from(edgeB),
    edgeDist: Float32Array.from(edgeDist),
    edgeCls: Uint8Array.from(edgeCls),
    edgeDir: Uint8Array.from(edgeDir),
  };
}

// mergeGraphs(graphs) -> single graph, deduplicating nodes shared across
// regions by coordinate. Overpass `out geom` returns identical coordinates for
// the same OSM node in each region's download, so nodes at the same location
// collapse to one index — this stitches overlapping regions into one connected
// graph. Without it, an overlapping road exists as two disjoint copies (one per
// region) and routing from a point in region A to a point in region B, where
// each point lies only in its own region, finds no path across the seam.
const COORD_KEY_DP = 7; // ~1cm; matches Overpass geometry precision
function coordKey(lat, lng) {
  return `${lat.toFixed(COORD_KEY_DP)},${lng.toFixed(COORD_KEY_DP)}`;
}
export function mergeGraphs(graphs) {
  const gs = graphs.filter(Boolean);
  const nEdges = gs.reduce((s, g) => s + g.edgeA.length, 0);
  const nodeLat = [], nodeLng = [];
  const keyToIdx = new Map();
  const edgeA = new Uint32Array(nEdges);
  const edgeB = new Uint32Array(nEdges);
  const out = {
    bbox: null,
    edgeDist: new Float32Array(nEdges),
    edgeCls: new Uint8Array(nEdges),
    edgeDir: new Uint8Array(nEdges),
    edgeA, edgeB,
  };

  const mergedIdx = (lat, lng) => {
    const k = coordKey(lat, lng);
    let i = keyToIdx.get(k);
    if (i === undefined) {
      i = nodeLat.length;
      keyToIdx.set(k, i);
      nodeLat.push(lat);
      nodeLng.push(lng);
    }
    return i;
  };

  let eOff = 0;
  for (const g of gs) {
    // Map this region's local node indices to merged (deduped) indices.
    const remap = new Uint32Array(g.nodeLat.length);
    for (let i = 0; i < g.nodeLat.length; i++) {
      remap[i] = mergedIdx(g.nodeLat[i], g.nodeLng[i]);
    }
    out.edgeDist.set(g.edgeDist, eOff);
    out.edgeCls.set(g.edgeCls, eOff);
    out.edgeDir.set(g.edgeDir, eOff);
    for (let i = 0; i < g.edgeA.length; i++) {
      edgeA[eOff + i] = remap[g.edgeA[i]];
      edgeB[eOff + i] = remap[g.edgeB[i]];
    }
    eOff += g.edgeA.length;
  }
  out.nodeLat = Float64Array.from(nodeLat);
  out.nodeLng = Float64Array.from(nodeLng);
  return out;
}

// ---- Nearest node --------------------------------------------------------

export function nearestNode(graph, lat, lng, maxMeters = Infinity) {
  const { nodeLat, nodeLng } = graph;
  let best = -1, bestD = Infinity;
  for (let i = 0; i < nodeLat.length; i++) {
    const d = haversine(lat, lng, nodeLat[i], nodeLng[i]);
    if (d < bestD) { bestD = d; best = i; }
  }
  return bestD <= maxMeters ? best : -1;
}

// ---- Profiles ------------------------------------------------------------
// Per class: speed km/h (0 / null => class not routable for this profile) and
// a preference factor (>1 penalizes cost, <1 favors). Cost = dist/speed * pref.

const N = HIGHWAY_CLASSES.length;
const idx = (c) => CLS_INDEX.get(c);
function table(spec, defSpeed, defPref) {
  const speed = new Float32Array(N), pref = new Float32Array(N);
  for (let i = 0; i < N; i++) { speed[i] = defSpeed; pref[i] = defPref; }
  for (const [cls, s, p = 1] of spec) {
    speed[idx(cls)] = s;
    pref[idx(cls)] = p;
  }
  return { speed, pref };
}

// oneway (edgeDir) constrains car & bike, not foot.
export const PROFILES = {
  car: {
    oneway: true,
    ...table([
      ["motorway", 110], ["motorway_link", 70],
      ["trunk", 90], ["trunk_link", 60],
      ["primary", 80, 1.05], ["primary_link", 50],
      ["secondary", 65, 1.05], ["secondary_link", 45],
      ["tertiary", 50], ["tertiary_link", 40],
      ["unclassified", 40], ["residential", 30, 1.1],
      ["living_street", 15, 1.3], ["service", 20, 1.3],
      ["track", 0], ["cycleway", 0], ["footway", 0], ["path", 0],
      ["pedestrian", 0], ["bridleway", 0], ["steps", 0],
    ], 40, 1),
  },
  bike: {
    oneway: true,
    ...table([
      ["motorway", 0], ["motorway_link", 0], ["trunk", 0], ["trunk_link", 0],
      ["primary", 18, 1.8], ["primary_link", 16, 1.8],
      ["secondary", 18, 1.4], ["secondary_link", 16, 1.4],
      ["tertiary", 18, 1.05], ["tertiary_link", 17, 1.05],
      ["unclassified", 16, 1.1], ["residential", 15, 1.0],
      ["living_street", 12, 0.95], ["service", 12, 1.1],
      ["track", 10, 1.1], ["cycleway", 18, 0.8],
      ["footway", 6, 1.6], ["path", 10, 1.1],
      ["pedestrian", 6, 1.4], ["bridleway", 8, 1.3],
      ["steps", 2, 4],
    ], 15, 1),
  },
  foot: {
    oneway: false,
    ...table([
      ["motorway", 0], ["motorway_link", 0], ["trunk", 0], ["trunk_link", 0],
      ["primary", 4.5, 1.3], ["primary_link", 4.5, 1.3],
      ["secondary", 4.5, 1.2], ["secondary_link", 4.5, 1.2],
      ["tertiary", 4.5, 1.05], ["tertiary_link", 4.5, 1.05],
      ["unclassified", 4.5], ["residential", 4.5],
      ["living_street", 4.5, 0.95], ["service", 4.5],
      ["track", 4, 0.95], ["cycleway", 4.5, 0.9],
      ["footway", 4.5, 0.85], ["path", 4, 0.9],
      ["pedestrian", 4.5, 0.85], ["bridleway", 3.5], ["steps", 2, 1.2],
    ], 4.5, 1),
  },
};

// ---- Adjacency (built lazily, cached on graph) ---------------------------

// CSR-style adjacency: for each node, a slice of (neighbor, edgeIndex, forward).
function buildAdjacency(graph) {
  const nNodes = graph.nodeLat.length;
  const { edgeA, edgeB } = graph;
  const deg = new Uint32Array(nNodes);
  for (let e = 0; e < edgeA.length; e++) { deg[edgeA[e]]++; deg[edgeB[e]]++; }
  const off = new Uint32Array(nNodes + 1);
  for (let i = 0; i < nNodes; i++) off[i + 1] = off[i] + deg[i];
  const total = off[nNodes];
  const nbr = new Uint32Array(total);   // neighbor node
  const eid = new Uint32Array(total);   // edge index
  const fwd = new Uint8Array(total);    // 1 if traversing a->b, 0 if b->a
  const cur = off.slice(0, nNodes);
  for (let e = 0; e < edgeA.length; e++) {
    const a = edgeA[e], b = edgeB[e];
    let p = cur[a]++; nbr[p] = b; eid[p] = e; fwd[p] = 1;
    p = cur[b]++; nbr[p] = a; eid[p] = e; fwd[p] = 0;
  }
  return { off, nbr, eid, fwd };
}

// ---- Binary min-heap over (fScore, node) ---------------------------------

class Heap {
  constructor() { this.f = []; this.n = []; }
  get size() { return this.n.length; }
  push(f, node) {
    const { f: fs, n: ns } = this;
    let i = ns.length;
    fs.push(f); ns.push(node);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (fs[p] <= fs[i]) break;
      [fs[p], fs[i]] = [fs[i], fs[p]];
      [ns[p], ns[i]] = [ns[i], ns[p]];
      i = p;
    }
  }
  pop() {
    const { f: fs, n: ns } = this;
    const top = ns[0];
    const lastF = fs.pop(), lastN = ns.pop();
    if (fs.length) {
      fs[0] = lastF; ns[0] = lastN;
      let i = 0;
      const len = fs.length;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < len && fs[l] < fs[m]) m = l;
        if (r < len && fs[r] < fs[m]) m = r;
        if (m === i) break;
        [fs[m], fs[i]] = [fs[i], fs[m]];
        [ns[m], ns[i]] = [ns[i], ns[m]];
        i = m;
      }
    }
    return top;
  }
}

// astar(graph, fromIdx, toIdx, profile) -> {path, distance, time} | null.
// Cost minimized is travel time (with preference factor); distance/time are
// the true totals along the chosen path.
export function astar(graph, fromIdx, toIdx, profileName) {
  const prof = PROFILES[profileName];
  if (!prof) throw new Error(`unknown profile: ${profileName}`);
  if (fromIdx === toIdx) return { path: [fromIdx], distance: 0, time: 0 };

  const adj = graph._adj || (graph._adj = buildAdjacency(graph));
  const { off, nbr, eid, fwd } = adj;
  const { edgeDist, edgeCls, edgeDir, nodeLat, nodeLng } = graph;
  const { speed, pref, oneway } = prof;

  // Admissible heuristic: straight-line dist / fastest allowed speed (h in
  // the same cost units — hours*preferenceless). Use max speed among classes.
  let vmax = 0;
  for (let i = 0; i < speed.length; i++) if (speed[i] > vmax) vmax = speed[i];
  const tLat = nodeLat[toIdx], tLng = nodeLng[toIdx];
  const h = (node) =>
    haversine(nodeLat[node], nodeLng[node], tLat, tLng) / 1000 / vmax;

  const nNodes = nodeLat.length;
  const g = new Float64Array(nNodes).fill(Infinity);
  const came = new Int32Array(nNodes).fill(-1);
  const closed = new Uint8Array(nNodes);
  g[fromIdx] = 0;

  const open = new Heap();
  open.push(h(fromIdx), fromIdx);

  while (open.size) {
    const u = open.pop();
    if (closed[u]) continue;
    closed[u] = 1;
    if (u === toIdx) break;

    for (let p = off[u]; p < off[u + 1]; p++) {
      const e = eid[p];
      const cls = edgeCls[e];
      const v0 = speed[cls];
      if (v0 <= 0) continue; // class not routable for this profile

      // oneway: edgeDir 1 = a->b only, 2 = b->a only. fwd[p]=1 means we go a->b.
      if (oneway) {
        const d = edgeDir[e];
        if (d === 1 && fwd[p] === 0) continue;
        if (d === 2 && fwd[p] === 1) continue;
      }

      const w = nbr[p];
      if (closed[w]) continue;
      const cost = edgeDist[e] / 1000 / v0 * pref[cls];
      const ng = g[u] + cost;
      if (ng < g[w]) {
        g[w] = ng;
        came[w] = u;
        open.push(ng + h(w), w);
      }
    }
  }

  if (came[toIdx] === -1 && toIdx !== fromIdx) return null;

  // Reconstruct path and sum true distance/time.
  const path = [];
  for (let n = toIdx; n !== -1; n = came[n]) path.push(n);
  path.reverse();
  if (path[0] !== fromIdx) return null;

  let distance = 0, time = 0;
  for (let i = 0; i < path.length - 1; i++) {
    const a = path[i], b = path[i + 1];
    // find the edge between a and b that we used (cheapest allowed)
    let bestD = 0, bestV = 0;
    for (let p = off[a]; p < off[a + 1]; p++) {
      if (nbr[p] !== b) continue;
      const e = eid[p], cls = edgeCls[e], v0 = speed[cls];
      if (v0 <= 0) continue;
      if (oneway) {
        const d = edgeDir[e];
        if (d === 1 && fwd[p] === 0) continue;
        if (d === 2 && fwd[p] === 1) continue;
      }
      const t = edgeDist[e] / 1000 / v0;
      if (bestV === 0 || t < bestD / bestV) { bestD = edgeDist[e]; bestV = v0; }
    }
    distance += bestD;
    time += bestD / 1000 / bestV * 3600; // seconds
  }
  return { path, distance, time };
}
