// Slope math + shared slope→color scale. No DOM — node-importable.

const R = 6371000, RAD = Math.PI / 180;
function haversine(a, b) {
  const dLat = (b.lat - a.lat) * RAD, dLng = (b.lng - a.lng) * RAD;
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

const SMOOTH_M = 100;   // sliding-window size (DEM is ~30 m; raw slopes are noise)
export const SLOPE_MAX = 20; // clamp, percent

// Diverging scale, percent → color: blues for descents, the app's accent
// orange for near-flat, yellow → orange-red → maroon for climbs.
export const SLOPE_STOPS = [
  [-20, '#0b2e6b'],
  [-10, '#2b7de9'],
  [-4, '#82bdf5'],
  [-2, '#ff6b35'],
  [2, '#ff6b35'],
  [4, '#f2c916'],
  [8, '#ef6c00'],
  [12, '#c62815'],
  [15, '#8f1010'],
  [20, '#5c0505'],
];

const hex2 = (v) => Math.round(v).toString(16).padStart(2, '0');
export function slopeColor(pct) {
  const s = SLOPE_STOPS;
  if (pct <= s[0][0]) return s[0][1];
  for (let i = 1; i < s.length; i++) {
    if (pct <= s[i][0]) {
      const [p0, c0] = s[i - 1], [p1, c1] = s[i];
      const t = (pct - p0) / (p1 - p0);
      const a = parseInt(c0.slice(1), 16), b = parseInt(c1.slice(1), 16);
      return '#' +
        hex2((a >> 16) + t * ((b >> 16) - (a >> 16))) +
        hex2(((a >> 8) & 255) + t * (((b >> 8) & 255) - ((a >> 8) & 255))) +
        hex2((a & 255) + t * ((b & 255) - (a & 255)));
    }
  }
  return s[s.length - 1][1];
}

// Signed slope (percent) per coordinate interval, smoothed over ~SMOOTH_M of
// track distance and clamped to ±SLOPE_MAX. Returns null when the coords
// don't carry usable elevations (then callers fall back to the solid line).
export function computeSlopes(coords) {
  const n = coords.length;
  if (n < 2) return null;
  let finite = 0;
  for (const c of coords) if (Number.isFinite(c.ele)) finite++;
  if (finite < 2 || finite < n * 0.9) return null;

  // Cumulative distance + gap-tolerant elevations (carry last finite value).
  const dist = new Float64Array(n), ele = new Float64Array(n);
  let last = coords.find((c) => Number.isFinite(c.ele)).ele;
  for (let i = 0; i < n; i++) {
    if (i > 0) dist[i] = dist[i - 1] + haversine(coords[i - 1], coords[i]);
    if (Number.isFinite(coords[i].ele)) last = coords[i].ele;
    ele[i] = last;
  }
  if (dist[n - 1] <= 0) return null;

  const slopes = new Float64Array(n - 1);
  for (let i = 0; i < n - 1; i++) {
    // Grow [a,b] around interval i until it spans SMOOTH_M, preferring the
    // side that keeps the window centered on the interval's midpoint.
    let a = i, b = i + 1;
    const mid = (dist[i] + dist[i + 1]) / 2;
    while (dist[b] - dist[a] < SMOOTH_M && (a > 0 || b < n - 1)) {
      if (a > 0 && (b === n - 1 || mid - dist[a] <= dist[b] - mid)) a--;
      else b++;
    }
    const d = dist[b] - dist[a];
    const pct = d > 0 ? (100 * (ele[b] - ele[a])) / d : 0;
    slopes[i] = Math.max(-SLOPE_MAX, Math.min(SLOPE_MAX, pct));
  }
  return slopes;
}

// Group consecutive intervals into runs of equal quantized slope, so the map
// draws one polyline per run instead of one per interval. Starts at 1%
// buckets and coarsens until at most maxRuns. Returns [{start, end, color}]
// where the run covers intervals start..end-1 (coords slice start..end).
export function slopeRuns(slopes, maxRuns = 500) {
  for (let step = 1; ; step *= 2) {
    const runs = [];
    let q0 = null;
    for (let i = 0; i < slopes.length; i++) {
      const q = Math.round(slopes[i] / step) * step;
      if (q === q0) runs[runs.length - 1].end = i + 1;
      else runs.push({ start: i, end: i + 1, color: slopeColor(q) });
      q0 = q;
    }
    if (runs.length <= maxRuns || step > SLOPE_MAX) return runs;
  }
}
