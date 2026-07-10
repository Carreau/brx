// Module worker: owns IndexedDB (db `brx`, store `regions`) and the merged
// in-memory routing graph. Pure graph logic lives in localgraph.js.

import {
  buildGraphFromOverpass, mergeGraphs, nearestNode, astar,
} from "./localgraph.js";

const DB_NAME = "brx";
const STORE = "regions";
const SNAP_METERS = 250;

let dbPromise = null;
function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(db, mode) {
  return db.transaction(STORE, mode).objectStore(STORE);
}
const reqP = (r) => new Promise((res, rej) => {
  r.onsuccess = () => res(r.result);
  r.onerror = () => rej(r.error);
});

async function getAllRegions() {
  const db = await openDB();
  return reqP(tx(db, "readonly").getAll());
}
async function putRegion(region) {
  const db = await openDB();
  await reqP(tx(db, "readwrite").put(region));
}
async function deleteRegion(id) {
  const db = await openDB();
  await reqP(tx(db, "readwrite").delete(id));
}

// ---- merged graph state --------------------------------------------------

let merged = null;

function graphFromRegion(r) {
  return {
    bbox: r.bbox,
    nodeLat: r.nodeLat, nodeLng: r.nodeLng,
    edgeA: r.edgeA, edgeB: r.edgeB,
    edgeDist: r.edgeDist, edgeCls: r.edgeCls, edgeDir: r.edgeDir,
  };
}

async function reload() {
  const regions = await getAllRegions();
  merged = regions.length ? mergeGraphs(regions.map(graphFromRegion)) : null;
  return { regions: regions.length };
}

function regionMeta(r) {
  const bytes = [r.nodeLat, r.nodeLng, r.edgeA, r.edgeB, r.edgeDist,
    r.edgeCls, r.edgeDir].reduce((s, a) => s + (a?.byteLength || 0), 0);
  return {
    id: r.id, name: r.name, bbox: r.bbox, createdAt: r.createdAt,
    nodeCount: r.nodeLat.length, edgeCount: r.edgeA.length, bytes,
  };
}

async function list() {
  const regions = await getAllRegions();
  return regions.map(regionMeta);
}

// Load whatever regions already exist as soon as the worker starts, so a
// fresh page load can route without an explicit `reload` message.
const initialLoad = reload().catch(() => {});

async function route({ from, to, profile }) {
  await initialLoad;
  if (!merged || merged.nodeLat.length === 0) {
    throw new Error("No routing data here — download this region first");
  }
  const a = nearestNode(merged, from.lat, from.lng, SNAP_METERS);
  const b = nearestNode(merged, to.lat, to.lng, SNAP_METERS);
  if (a < 0 || b < 0) {
    throw new Error("No routing data here — download this region first");
  }
  const res = astar(merged, a, b, profile);
  if (!res) throw new Error("No route found");
  const coords = res.path.map((n) => ({
    lat: merged.nodeLat[n], lng: merged.nodeLng[n],
  }));
  return { coords, distance: res.distance, time: res.time, ascend: 0 };
}

// ---- message dispatch ----------------------------------------------------

const handlers = {
  route: (p) => route(p),
  reload: () => reload(),
  list: () => list(),
  put: async (region) => { await putRegion(region); return { id: region.id }; },
  delete: async ({ id }) => { await deleteRegion(id); return { id }; },
};

self.onmessage = async (ev) => {
  const { id, type, payload } = ev.data || {};
  const h = handlers[type];
  if (!h) {
    self.postMessage({ id, ok: false, error: `unknown message type: ${type}` });
    return;
  }
  try {
    const result = await h(payload);
    self.postMessage({ id, ok: true, result });
  } catch (err) {
    self.postMessage({ id, ok: false, error: err?.message || String(err) });
  }
};
