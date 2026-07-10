// Main-thread facade over the router worker. Owns the Worker, a pending-request
// map, and the Overpass download flow. Pure graph logic lives in localgraph.js.

import { overpassQuery, buildGraphFromOverpass } from "./localgraph.js";

// Tried in order; public instances rate-limit aggressively.
const OVERPASS_URLS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
];

// Deterministic region id from name + bbox (stable across reloads).
function regionId(name, bbox) {
  const src = `${name}|${bbox.map((n) => n.toFixed(5)).join(",")}`;
  let h = 2166136261 >>> 0; // FNV-1a
  for (let i = 0; i < src.length; i++) {
    h ^= src.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return "r" + h.toString(36);
}

export function createLocalRouter() {
  const worker = new Worker(new URL("./router-worker.js", import.meta.url), {
    type: "module",
  });

  const pending = new Map();
  let seq = 0;

  worker.onmessage = (ev) => {
    const { id, ok, result, error } = ev.data || {};
    const p = pending.get(id);
    if (!p) return; // aborted / stale
    pending.delete(id);
    if (p.signal) p.signal.removeEventListener("abort", p.onAbort);
    ok ? p.resolve(result) : p.reject(new Error(error));
  };

  function send(type, payload, signal, transfer) {
    if (signal?.aborted) return Promise.reject(abortError());
    const id = ++seq;
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, signal };
      if (signal) {
        entry.onAbort = () => {
          if (pending.has(id)) {
            pending.delete(id);
            reject(abortError());
          }
        };
        signal.addEventListener("abort", entry.onAbort, { once: true });
      }
      pending.set(id, entry);
      worker.postMessage({ id, type, payload }, transfer || []);
    });
  }

  async function listRegions() {
    return send("list");
  }

  async function deleteRegion(id) {
    await send("delete", { id });
    await send("reload");
  }

  async function routeSegment({ from, to, profile, signal }) {
    return send("route", { from, to, profile }, signal);
  }

  async function downloadRegion({ bbox, name, onProgress }) {
    const progress = (stage, pct) => onProgress && onProgress(stage, pct);

    progress("download");
    const query = overpassQuery(bbox);
    let res = null;
    let lastError = null;
    for (const url of OVERPASS_URLS) {
      try {
        res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: "data=" + encodeURIComponent(query),
        });
      } catch (e) {
        lastError = new Error(`Overpass request failed: ${e.message}`);
        res = null;
        continue;
      }
      if (res.ok) break;
      // 429 = rate-limited, 406/5xx = server-side rejection: try the next mirror.
      lastError = new Error(
        res.status === 429
          ? "Overpass is rate-limiting (429) — wait and retry"
          : res.status === 504 || res.status === 502
            ? "Overpass timed out — try a smaller region"
            : `Overpass error ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`,
      );
      res = null;
    }
    if (!res) throw lastError ?? new Error("Overpass request failed");
    const data = await res.json().catch(() => {
      throw new Error("Overpass returned invalid JSON");
    });
    const elements = data.elements || [];
    if (!elements.length) throw new Error("No roads found in this region");

    progress("build");
    const graph = buildGraphFromOverpass(elements, bbox);

    progress("store");
    const id = regionId(name, bbox);
    const createdAt = Date.now();
    const region = {
      id, name, bbox, createdAt,
      nodeLat: graph.nodeLat, nodeLng: graph.nodeLng,
      edgeA: graph.edgeA, edgeB: graph.edgeB,
      edgeDist: graph.edgeDist, edgeCls: graph.edgeCls, edgeDir: graph.edgeDir,
    };
    // Capture meta before transfer detaches the buffers on this thread.
    const nodeCount = graph.nodeLat.length, edgeCount = graph.edgeA.length;
    const transfer = [graph.nodeLat.buffer, graph.nodeLng.buffer,
      graph.edgeA.buffer, graph.edgeB.buffer, graph.edgeDist.buffer,
      graph.edgeCls.buffer, graph.edgeDir.buffer];
    const bytes = transfer.reduce((s, b) => s + b.byteLength, 0);
    await send("put", region, undefined, transfer);
    await send("reload");

    return { id, name, bbox, createdAt, nodeCount, edgeCount, bytes };
  }

  function destroy() {
    worker.terminate();
    pending.clear();
  }

  return { listRegions, downloadRegion, deleteRegion, routeSegment, destroy };
}

function abortError() {
  const e = new Error("Aborted");
  e.name = "AbortError";
  return e;
}
