import 'leaflet/dist/leaflet.css';
import '../style.css';

import { parseHash, buildHash, DEFAULT_ENDPOINT, DEFAULT_PROFILE } from './urlstate.js';
import { routeSegment as brouterSegment } from './routing.js';
import { createLocalRouter } from './localrouting.js';
import { createMap } from './map.js';
import { createElevationProfile } from './elevation.js';
import { toGPX, parseGPX } from './gpx.js';
import { registerPWA } from './pwa.js';

const BROUTER_DEFAULT = 'https://brouter.de/brouter';
const DEFAULT_VIEW = { lat: 48.8584, lng: 2.2945, zoom: 12 };
const PROFILES = {
  local: ['bike', 'foot', 'car'],
  brouter: ['trekking', 'fastbike', 'car-fast', 'shortest', 'hiking-mountain'],
};

// ---------------------------------------------------------------- state

const state = parseHash(location.hash);
const localRouter = createLocalRouter();

// segments[i] routes points[i] -> points[i+1].
let segments = [];
const segmentCache = new Map();
let applyingHash = false;
let lastBrouterUrl = state.endpoint !== 'local' ? state.endpoint : BROUTER_DEFAULT;

const engine = () => (state.endpoint === 'local' ? 'local' : 'brouter');
const segKey = (a, b) =>
  `${a.lat.toFixed(5)},${a.lng.toFixed(5)}|${b.lat.toFixed(5)},${b.lng.toFixed(5)}|${state.profile}|${state.endpoint}`;

// ---------------------------------------------------------------- dom

const $ = (id) => document.getElementById(id);
const engineSel = $('engine');
const profileSel = $('profile');
const endpointRow = $('endpoint-row');
const endpointInput = $('endpoint');
const statsEl = $('stats');
const banner = $('banner');
const bannerText = $('banner-text');
const bannerFallback = $('banner-fallback');
const elevationPanel = $('elevation-panel');
const regionProgress = $('region-progress');

// ---------------------------------------------------------------- map & elevation

const map = createMap($('map'), {
  onMapClick(latlng) {
    pushPoints([...state.points, round(latlng)]);
  },
  onMapMove(view) {
    state.map = view;
    if (!applyingHash) writeUrl(true);
  },
  onMarkerDrag(i, latlng) {
    const pts = state.points.slice();
    pts[i] = round(latlng);
    pushPoints(pts);
  },
  onMarkerDelete(i) {
    pushPoints(state.points.filter((_, j) => j !== i));
  },
  onRouteInsert(segIndex, latlng) {
    const pts = state.points.slice();
    pts.splice(segIndex + 1, 0, round(latlng));
    pushPoints(pts);
  },
});

const elevation = createElevationProfile($('elevation'), {
  onHover(index) {
    const coords = allCoords();
    map.setHighlight(index != null && coords[index] ? coords[index] : null);
  },
});

function round({ lat, lng }) {
  return { lat: +lat.toFixed(5), lng: +lng.toFixed(5) };
}

function allCoords() {
  return segments.filter(Boolean).flatMap((s) => s.coords);
}

// ---------------------------------------------------------------- routing

let routeEpoch = 0;
let aborters = [];

function routeOne({ from, to, signal }) {
  if (engine() === 'local') {
    return localRouter.routeSegment({ from, to, profile: state.profile, signal });
  }
  return brouterSegment({ from, to, profile: state.profile, endpoint: state.endpoint, signal });
}

async function reroute() {
  routeEpoch += 1;
  const epoch = routeEpoch;
  aborters.forEach((a) => a.abort());
  aborters = [];

  const pts = state.points;
  segments = pts.slice(0, -1).map((p, i) => segmentCache.get(segKey(p, pts[i + 1])) ?? null);
  render();

  const jobs = segments.map(async (seg, i) => {
    if (seg) return;
    const key = segKey(pts[i], pts[i + 1]);
    const aborter = new AbortController();
    aborters.push(aborter);
    try {
      const result = await routeOne({ from: pts[i], to: pts[i + 1], signal: aborter.signal });
      if (epoch !== routeEpoch) return;
      segmentCache.set(key, result);
      if (segmentCache.size > 500) segmentCache.delete(segmentCache.keys().next().value);
      segments[i] = result;
      render();
    } catch (err) {
      if (err.name === 'AbortError' || epoch !== routeEpoch) return;
      showError(err);
    }
  });
  await Promise.allSettled(jobs);
}

// ---------------------------------------------------------------- rendering

function render() {
  map.setPoints(state.points);
  map.setSegments(segments, state.points);

  const done = segments.filter(Boolean);
  const complete = segments.length > 0 && done.length === segments.length;

  $('export').disabled = !complete;

  // Elevation only when the engine provided elevations (BRouter does,
  // the offline graph doesn't).
  const coords = complete ? allCoords() : [];
  const hasEle = coords.some((c) => Number.isFinite(c.ele));
  elevationPanel.hidden = !(complete && hasEle);
  elevation.setData(complete && hasEle ? coords : []);

  statsEl.hidden = done.length === 0;
  if (done.length) {
    const dist = done.reduce((s, x) => s + x.distance, 0);
    const asc = done.reduce((s, x) => s + x.ascend, 0);
    const time = done.reduce((s, x) => s + x.time, 0);
    $('stat-dist').textContent = `${(dist / 1000).toFixed(1)} km`;
    $('stat-ascend').textContent = asc > 0 ? `↗ ${Math.round(asc)} m` : '';
    $('stat-time').textContent = formatTime(time);
  }
}

function formatTime(s) {
  const totalMin = Math.round(s / 60);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h ? `${h} h ${String(m).padStart(2, '0')}` : `${m} min`;
}

// ---------------------------------------------------------------- errors

function showError(err) {
  bannerText.textContent = err.message;
  // Local engine lacking data: offer a one-click switch to online routing.
  bannerFallback.hidden = !(engine() === 'local' && /routing data/i.test(err.message));
  banner.hidden = false;
}

$('banner-close').onclick = () => { banner.hidden = true; };
bannerFallback.onclick = () => {
  banner.hidden = true;
  state.endpoint = lastBrouterUrl;
  if (!PROFILES.brouter.includes(state.profile)) state.profile = PROFILES.brouter[0];
  syncControls();
  writeUrl();
  reroute();
};

// ---------------------------------------------------------------- url sync

function writeUrl(replace = false) {
  const hash = buildHash(state);
  if (hash === location.hash || (hash === '#' && !location.hash)) return;
  const url = hash === '#' ? location.pathname + location.search : hash;
  if (replace) history.replaceState(null, '', url);
  else history.pushState(null, '', url);
}

function applyHash() {
  applyingHash = true;
  const s = parseHash(location.hash);
  state.points = s.points;
  state.profile = s.profile;
  state.endpoint = s.endpoint;
  if (s.map) { state.map = s.map; map.setView(s.map); }
  syncControls();
  banner.hidden = true;
  reroute();
  applyingHash = false;
}

window.addEventListener('popstate', applyHash);

// A points change is a user action worth a history entry (undo via Back).
function pushPoints(pts) {
  state.points = pts;
  banner.hidden = true;
  writeUrl();
  reroute();
}

// ---------------------------------------------------------------- controls

function syncControls() {
  const eng = engine();
  engineSel.value = eng;
  endpointRow.hidden = eng !== 'brouter';
  endpointInput.value = eng === 'brouter' ? state.endpoint : lastBrouterUrl;

  const profiles = PROFILES[eng];
  profileSel.replaceChildren(
    ...profiles.map((p) => Object.assign(document.createElement('option'), { value: p, textContent: p })),
  );
  if (!profiles.includes(state.profile)) {
    // Keep an unknown profile from the URL selectable (BRouter may know it).
    if (eng === 'brouter' && state.profile) {
      profileSel.append(Object.assign(document.createElement('option'), { value: state.profile, textContent: state.profile }));
    } else {
      state.profile = profiles[0];
    }
  }
  profileSel.value = state.profile;
}

engineSel.onchange = () => {
  if (engineSel.value === 'local') {
    if (state.endpoint !== 'local') lastBrouterUrl = state.endpoint;
    state.endpoint = 'local';
  } else {
    state.endpoint = lastBrouterUrl;
  }
  if (!PROFILES[engine()].includes(state.profile)) state.profile = PROFILES[engine()][0];
  syncControls();
  writeUrl();
  reroute();
};

profileSel.onchange = () => {
  state.profile = profileSel.value;
  writeUrl();
  reroute();
};

endpointInput.onchange = () => {
  const v = endpointInput.value.trim().replace(/\/+$/, '') || BROUTER_DEFAULT;
  state.endpoint = v;
  lastBrouterUrl = v;
  syncControls();
  writeUrl();
  reroute();
};

$('reverse').onclick = () => pushPoints(state.points.slice().reverse());
$('clear').onclick = () => pushPoints([]);

$('export').onclick = () => {
  const gpx = toGPX({ name: 'brx route', coords: allCoords(), waypoints: state.points });
  const blob = new Blob([gpx], { type: 'application/gpx+xml' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'route.gpx';
  a.click();
  URL.revokeObjectURL(a.href);
};

$('import').onclick = () => $('file').click();
$('file').onchange = async () => {
  const file = $('file').files[0];
  $('file').value = '';
  if (!file) return;
  try {
    const { points } = parseGPX(await file.text());
    pushPoints(points.map(round));
    map.fitPoints(points);
  } catch (err) {
    showError(err);
  }
};

// ---------------------------------------------------------------- offline regions

async function refreshRegions() {
  const regions = await localRouter.listRegions().catch(() => []);
  const list = $('region-list');
  list.replaceChildren(...regions.map((r) => {
    const li = document.createElement('li');
    const name = Object.assign(document.createElement('span'), {
      className: 'region-name', textContent: r.name, title: r.name,
    });
    const size = Object.assign(document.createElement('span'), {
      className: 'region-size', textContent: `${(r.bytes / 1e6).toFixed(1)} MB`,
    });
    const del = Object.assign(document.createElement('button'), { textContent: '✕', title: 'Delete' });
    del.onclick = async () => {
      await localRouter.deleteRegion(r.id);
      refreshRegions();
      if (engine() === 'local') reroute();
    };
    li.append(name, size, del);
    return li;
  }));
}

$('download-region').onclick = async () => {
  const b = map.getBounds(); // [s, w, n, e]
  const area = (b[2] - b[0]) * (b[3] - b[1]);
  if (area > 0.15 &&
      !confirm('Large area — the download may be slow or rejected by Overpass. Zoom in for faster downloads. Continue?')) {
    return;
  }
  const c = map.getView();
  const name = `${c.lat.toFixed(3)}, ${c.lng.toFixed(3)} (z${c.zoom})`;
  const btn = $('download-region');
  btn.disabled = true;
  regionProgress.hidden = false;
  try {
    await localRouter.downloadRegion({
      bbox: b,
      name,
      onProgress(stage) {
        regionProgress.textContent =
          { download: 'Downloading OSM data…', build: 'Building routing graph…', store: 'Saving…' }[stage] ?? stage;
      },
    });
    regionProgress.textContent = '';
    regionProgress.hidden = true;
    banner.hidden = true; // clear a stale "no routing data" error
    await refreshRegions();
    if (engine() === 'local') reroute();
  } catch (err) {
    regionProgress.hidden = true;
    showError(err);
  } finally {
    btn.disabled = false;
  }
};

// ---------------------------------------------------------------- boot

syncControls();
map.setView(state.map ?? DEFAULT_VIEW);
if (state.points.length >= 2 && !location.hash.includes('map=')) map.fitPoints(state.points);
refreshRegions();
reroute();
writeUrl(true);
registerPWA();
