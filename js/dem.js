// Terrarium DEM (AWS Open Data terrain tiles): fetch + decode PNG tiles for a
// bbox into a single Int16Array height grid. Main-thread only (uses
// createImageBitmap / canvas); the router worker just samples the grid.

const TILE = 256;
export const DEM_NODATA = -32768; // sentinel for missing tiles / failed decode

const tileURL = (z, x, y) =>
  `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;

const lng2x = (lng, z) => ((lng + 180) / 360) * 2 ** z;
const lat2y = (lat, z) => {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z;
};

function tileRange(bbox, z) {
  const [s, w, n, e] = bbox;
  const x0 = Math.floor(lng2x(w, z));
  const y0 = Math.floor(lat2y(n, z)); // north edge = smallest tile y
  return {
    x0, y0,
    w: Math.floor(lng2x(e, z)) - x0 + 1,
    h: Math.floor(lat2y(s, z)) - y0 + 1,
  };
}

// buildDEM(bbox, onProgress?) -> { z, x0, y0, w, h, data: Int16Array }.
// Zoom starts at 12 and steps down until the bbox fits in ~48 tiles. Missing
// tiles leave DEM_NODATA; throws only if every tile failed (e.g. offline).
export async function buildDEM(bbox, onProgress, maxTiles = 48) {
  let z = 12;
  let r = tileRange(bbox, z);
  while (z > 0 && r.w * r.h > maxTiles) r = tileRange(bbox, --z);
  const { x0, y0, w, h } = r;
  const gridW = w * TILE;
  const data = new Int16Array(gridW * h * TILE).fill(DEM_NODATA);

  const canvas = typeof OffscreenCanvas !== "undefined"
    ? new OffscreenCanvas(TILE, TILE)
    : Object.assign(document.createElement("canvas"), { width: TILE, height: TILE });
  const ctx = canvas.getContext("2d", { willReadFrequently: true });

  const jobs = [];
  for (let ty = 0; ty < h; ty++)
    for (let tx = 0; tx < w; tx++) jobs.push([tx, ty]);
  const total = jobs.length;
  let done = 0, failed = 0, next = 0;

  async function decodeOne([tx, ty]) {
    const res = await fetch(tileURL(z, x0 + tx, y0 + ty));
    if (!res.ok) throw new Error(`tile ${res.status}`);
    const bmp = await createImageBitmap(await res.blob());
    // No awaits below: safe to share one canvas across the pool.
    ctx.drawImage(bmp, 0, 0);
    bmp.close?.();
    const px = ctx.getImageData(0, 0, TILE, TILE).data;
    for (let row = 0; row < TILE; row++) {
      let s = row * TILE * 4;
      const d = (ty * TILE + row) * gridW + tx * TILE;
      for (let col = 0; col < TILE; col++, s += 4) {
        // meters = R*256 + G + B/256 - 32768
        const m = Math.round(px[s] * 256 + px[s + 1] + px[s + 2] / 256 - 32768);
        data[d + col] = Math.max(-32767, Math.min(32767, m));
      }
    }
  }

  const pool = Array.from({ length: Math.min(6, total) }, async () => {
    while (next < total) {
      const job = jobs[next++];
      try {
        await decodeOne(job);
      } catch {
        failed++; // tolerate per-tile failure: leave DEM_NODATA there
      }
      done++;
      onProgress?.(done, total);
    }
  });
  await Promise.all(pool);
  if (failed === total) throw new Error("elevation tiles unavailable");

  return { z, x0, y0, w, h, data };
}
