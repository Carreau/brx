// Pure URL-hash (de)serialization for brx. No DOM/window access.

// endpoint "local" = the in-browser offline engine; anything else is a
// BRouter HTTP endpoint (rt= in the hash).
export const DEFAULT_ENDPOINT = "local";
export const DEFAULT_PROFILE = "bike";

const fmt = (n) => n.toFixed(5);

// parseHash(hash) -> full state object; never throws, skips malformed parts.
export function parseHash(hash) {
  const state = {
    map: null,
    points: [],
    profile: DEFAULT_PROFILE,
    endpoint: DEFAULT_ENDPOINT,
  };
  if (typeof hash !== "string") return state;
  let s = hash.startsWith("#") ? hash.slice(1) : hash;
  for (const part of s.split("&")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const key = part.slice(0, eq);
    const val = part.slice(eq + 1);
    if (key === "map") {
      const m = val.split("/").map(Number);
      if (m.length === 3 && m.every(Number.isFinite)) {
        state.map = { zoom: m[0], lat: m[1], lng: m[2] };
      }
    } else if (key === "pts") {
      for (const p of val.split(";")) {
        if (!p) continue;
        const raw = p.split(",");
        const c = raw.map(Number);
        if (c.length === 2 && raw.every((r) => r.trim() !== "") && c.every(Number.isFinite)) {
          state.points.push({ lat: c[0], lng: c[1] });
        }
      }
    } else if (key === "profile") {
      if (val) state.profile = val;
    } else if (key === "rt") {
      try {
        const dec = decodeURIComponent(val);
        if (dec) state.endpoint = dec;
      } catch {
        // malformed encoding: keep default
      }
    }
  }
  return state;
}

// buildHash(state) -> "#..."; omits defaults and empty pts.
export function buildHash(state) {
  const parts = [];
  const { map, points = [], profile, endpoint } = state ?? {};
  if (map) parts.push(`map=${map.zoom}/${fmt(map.lat)}/${fmt(map.lng)}`);
  if (points.length) {
    parts.push(`pts=${points.map((p) => `${fmt(p.lat)},${fmt(p.lng)}`).join(";")}`);
  }
  if (profile && profile !== DEFAULT_PROFILE) parts.push(`profile=${profile}`);
  if (endpoint && endpoint !== DEFAULT_ENDPOINT) {
    parts.push(`rt=${encodeURIComponent(endpoint)}`);
  }
  return "#" + parts.join("&");
}
