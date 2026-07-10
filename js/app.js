import 'leaflet/dist/leaflet.css';
import '../style.css';

import { parseHash, buildHash, DEFAULT_ENDPOINT, DEFAULT_PROFILE } from './urlstate.js';
import { routeSegment } from './routing.js';
import { createMap } from './map.js';
import { createElevationProfile } from './elevation.js';
import { toGPX, parseGPX } from './gpx.js';

const FALLBACK_ENDPOINT = 'https://brouter.de/brouter';
const DEFAULT_VIEW = { lat: 48.8584, lng: 2.2945, zoom: 12 };

// ---------------------------------------------------------------- state

const state = parseHash(location.hash);

// segments[i] routes points[i] -> points[i+1].
// Each entry: { key, coords, distance, ascend, time } or null while pending.
let segments = [];
const segmentCache = new Map(); // key -> resolved segment
let applyingHash = false; // suppress URL writes while restoring from the URL

const segKey = (a, b) =>
  `${a.lat.toFixed(5)},${a.lng.toFixed(5)}|${b.lat.toFixed(5)},${b.lng.toFixed(5)}|${state.profile}|${state.endpoint}`;

// ---------------------------------------------------------------- dom

const $ = (id) => document.getElementById(id);
const profileSel = $('profile');
const endpointInput = $('endpoint');
const statsEl = $('stats');
const banner = $('banner');
const bannerText = $('banner-text');
const bannerFallback = $('banner-fallback');
const elevationPanel = $('elevation-panel');

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

async function reroute() {
  routeEpoch += 1;
  const epoch = routeEpoch;
  aborters.forEach((a) => a.abort());
  aborters = [];

  const pts = state.points;
  segments = pts.slice(0, -1).map((p, i) => {
    const cached = segmentCache.get(segKey(p, pts[i + 1]));
    return cached ?? null;
  });
  render();

  const jobs = segments.map(async (seg, i) => {
    if (seg) return;
    const key = segKey(pts[i], pts[i + 1]);
    const aborter = new AbortController();
    aborters.push(aborter);
    try {
      const result = await routeSegment({
        from: pts[i],
        to: pts[i + 1],
        profile: state.profile,
        endpoint: state.endpoint,
        signal: aborter.signal,
      });
      if (epoch !== routeEpoch) return;
      segmentCache.set(key, result);
      if (segmentCache.size > 500) {
        segmentCache.delete(segmentCache.keys().next().value);
      }
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
  elevationPanel.hidden = !complete;
  if (complete) elevation.setData(allCoords());
  else elevation.setData([]);

  statsEl.hidden = done.length === 0;
  if (done.length) {
    const dist = done.reduce((s, x) => s + x.distance, 0);
    const asc = done.reduce((s, x) => s + x.ascend, 0);
    const time = done.reduce((s, x) => s + x.time, 0);
    $('stat-dist').textContent = `${(dist / 1000).toFixed(1)} km`;
    $('stat-ascend').textContent = `↗ ${Math.round(asc)} m`;
    $('stat-time').textContent = formatTime(time);
  }
}

function formatTime(s) {
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  return h ? `${h} h ${String(m).padStart(2, '0')}` : `${m} min`;
}

// ---------------------------------------------------------------- errors

function showError(err) {
  bannerText.textContent = err.message;
  const isLocal = state.endpoint === DEFAULT_ENDPOINT;
  const isNetwork = err instanceof TypeError || /fetch|network/i.test(err.message);
  bannerFallback.hidden = !(isLocal && isNetwork);
  if (bannerFallback.hidden === false) {
    bannerText.textContent =
      `Cannot reach the local BRouter at ${DEFAULT_ENDPOINT} — start it with scripts/run-brouter.sh, or:`;
  }
  banner.hidden = false;
}

$('banner-close').onclick = () => { banner.hidden = true; };
bannerFallback.onclick = () => {
  banner.hidden = true;
  endpointInput.value = FALLBACK_ENDPOINT;
  setEndpoint(FALLBACK_ENDPOINT);
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
  profileSel.value = state.profile;
  endpointInput.value = state.endpoint;
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

profileSel.onchange = () => {
  state.profile = profileSel.value;
  writeUrl();
  reroute();
};

function setEndpoint(value) {
  state.endpoint = value.trim().replace(/\/+$/, '') || DEFAULT_ENDPOINT;
  endpointInput.value = state.endpoint;
  writeUrl();
  reroute();
}
endpointInput.onchange = () => setEndpoint(endpointInput.value);

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

// ---------------------------------------------------------------- boot

profileSel.value = [...profileSel.options].some((o) => o.value === state.profile)
  ? state.profile
  : DEFAULT_PROFILE;
if (profileSel.value !== state.profile) {
  // Unknown profile in the URL: keep it in state (BRouter may know it) but
  // leave the select on the default so the UI isn't blank.
  profileSel.value = DEFAULT_PROFILE;
}
endpointInput.value = state.endpoint;
map.setView(state.map ?? DEFAULT_VIEW);
if (state.points.length >= 2 && !location.hash.includes('map=')) map.fitPoints(state.points);
reroute();
writeUrl(true);
