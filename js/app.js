import 'leaflet/dist/leaflet.css';
import '../style.css';

import { parseHash, buildHash, DEFAULT_ENDPOINT, DEFAULT_PROFILE } from './urlstate.js';
import { routeSegment as brouterSegment } from './routing.js';
import { createLocalRouter } from './localrouting.js';
import { createMap } from './map.js';
import { createElevationProfile } from './elevation.js';
import { toGPX, parseGPX } from './gpx.js';
import { registerPWA, setupInstall } from './pwa.js';
import { createGeolocate } from './geolocate.js';
import { showNotice } from './notice.js';

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
const COARSE = matchMedia('(pointer: coarse)').matches;
const phoneMq = matchMedia('(max-width: 640px)'); // live: phone layout follows resizes
const SMALL = phoneMq.matches;
const engineSel = $('engine');
const profileSel = $('profile');
const endpointRow = $('endpoint-row');
const endpointInput = $('endpoint');
const statsEl = $('stats');
const banner = $('banner');
const bannerText = $('banner-text');
const bannerFallback = $('banner-fallback');
const bannerDownload = $('banner-download');
const elevationPanel = $('elevation-panel');
const regionProgress = $('region-progress');
const dlToast = $('dl-toast');

// ---------------------------------------------------------------- map & elevation

const map = createMap($('map'), {
  onMapClick(latlng) {
    if (xhMode) return; // crosshair mode: plain taps don't add points
    // With a marker selected, a map tap deselects instead of adding a point.
    if (selected != null) { setSelected(null); return; }
    pushPoints([...state.points, round(latlng)]);
  },
  onMarkerTap(i) {
    if (xhMode) return;
    setSelected(selected === i ? null : i);
  },
  onLongPress(latlng) {
    // Long-press enters crosshair precision-add, centered on the press.
    if (xhMode) return;
    map.panTo(latlng);
    enterCrosshair('add');
  },
  onUserPan() {
    geo.userPanned(); // manual pan drops follow back to locate
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
    if (xhMode) return; // crosshair mode: taps on the route don't insert
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

// ---------------------------------------------------------------- selection

let selected = null; // waypoint index or null

function setSelected(i) {
  selected = i;
  $('wp-chip').hidden = i == null;
  if (i != null) $('wp-chip-text').textContent = `Waypoint ${i + 1} of ${state.points.length}`;
  map.setPoints(state.points, selected);
}

$('wp-chip-delete').onclick = () => {
  const i = selected;
  if (i == null) return;
  setSelected(null);
  pushPoints(state.points.filter((_, j) => j !== i));
};

// history.back() is only safe while there are app-pushed entries beneath us
// (boot uses replaceState, so a freshly opened shared URL has none).
let undoDepth = 0;
$('undo').onclick = () => { if (undoDepth > 0) history.back(); };

// ---------------------------------------------------------------- crosshair mode

// Precision placement: a fixed center reticle, the map pans underneath.
// Entered by long-pressing the map ('add') or from the waypoint chip ('move').
let xhMode = null; // null | { kind: 'add' } | { kind: 'move', index }

function enterCrosshair(kind, index = null) {
  xhMode = { kind, index };
  $('crosshair').hidden = false;
  $('xh-chip').hidden = false;
  $('xh-ok').textContent = kind === 'move' ? 'Move here' : 'Add here';
  $('wp-chip').hidden = true; // the confirm chip takes its spot
}

function exitCrosshair() {
  xhMode = null;
  $('crosshair').hidden = true;
  $('xh-chip').hidden = true;
  if (selected != null) $('wp-chip').hidden = false;
}

$('xh-ok').onclick = () => {
  if (!xhMode) return;
  const { kind, index } = xhMode;
  const c = round(map.getView());
  exitCrosshair();
  if (kind === 'move') {
    const pts = state.points.slice();
    pts[index] = c;
    pushPoints(pts);
  } else {
    pushPoints([...state.points, c]);
  }
};
$('xh-cancel').onclick = exitCrosshair;
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && xhMode) exitCrosshair();
});

$('wp-chip-move').onclick = () => {
  if (selected == null) return;
  map.panTo(state.points[selected]);
  enterCrosshair('move', selected);
};

// ---------------------------------------------------------------- locate / follow

const locateBtn = $('locate');
let lastFix = null;
let panOnFix = false; // one-shot pan/zoom on the first fix after turning on

const geo = createGeolocate({
  onUpdate(pos) {
    lastFix = pos;
    map.setLocation(pos);
    if (geo.mode === 'follow') map.panTo(pos);
    else if (panOnFix) { panOnFix = false; map.panTo(pos, 16); }
  },
  onModeChange(mode) {
    if (mode === 'off') {
      panOnFix = false;
      lastFix = null;
      map.setLocation(null);
    } else if (mode === 'locate' && !lastFix) {
      panOnFix = true;
    } else if (mode === 'follow' && lastFix) {
      map.panTo(lastFix, 16);
    }
    locateBtn.classList.toggle('locating', mode === 'locate');
    locateBtn.classList.toggle('following', mode === 'follow');
    locateBtn.title = locateBtn.ariaLabel = {
      off: 'Show my location',
      locate: 'Follow my location',
      follow: 'Stop following',
    }[mode];
  },
  onError: showError,
});

locateBtn.onclick = () => geo.cycle();

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
  map.setPoints(state.points, selected);
  map.setSegments(segments, state.points);
  $('undo').hidden = undoDepth === 0;

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
  let distText = '', ascText = '', timeText = '';
  if (done.length) {
    const dist = done.reduce((s, x) => s + x.distance, 0);
    const asc = done.reduce((s, x) => s + x.ascend, 0);
    const time = done.reduce((s, x) => s + x.time, 0);
    distText = `${(dist / 1000).toFixed(1)} km`;
    ascText = asc > 0 ? `↗ ${Math.round(asc)} m` : '';
    timeText = formatTime(time);
  }
  // Same stats in the toolbar panel (desktop) and the bottom bar (phone).
  $('stat-dist').textContent = distText;
  $('stat-ascend').textContent = ascText;
  $('stat-time').textContent = timeText;
  $('bb-dist').textContent = distText;
  $('bb-ascend').textContent = ascText;
  $('bb-time').textContent = timeText;
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
  // Local engine lacking data: offer a one-click switch to online routing,
  // or downloading the visible area for offline use.
  const noData = engine() === 'local' && /routing data/i.test(err.message);
  bannerFallback.hidden = !noData;
  bannerDownload.hidden = !noData;
  banner.hidden = false;
}

$('banner-close').onclick = () => { banner.hidden = true; };
bannerDownload.onclick = () => {
  banner.hidden = true;
  downloadVisibleArea();
};
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
  else { history.pushState(null, '', url); undoDepth += 1; }
}

function applyHash() {
  applyingHash = true;
  const s = parseHash(location.hash);
  state.points = s.points;
  state.profile = s.profile;
  state.endpoint = s.endpoint;
  if (s.map) { state.map = s.map; map.setView(s.map); }
  if (selected != null) setSelected(null);
  if (xhMode) exitCrosshair();
  syncControls();
  banner.hidden = true;
  reroute();
  applyingHash = false;
}

window.addEventListener('popstate', () => {
  undoDepth = Math.max(0, undoDepth - 1);
  applyHash(); // re-renders, which also updates the undo FAB
});

// A points change is a user action worth a history entry (undo via Back).
function pushPoints(pts) {
  state.points = pts;
  if (selected != null) setSelected(null);
  if (xhMode) exitCrosshair();
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
  syncBottomBar();
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

$('export').onclick = async () => {
  const gpx = toGPX({ name: 'brx route', coords: allCoords(), waypoints: state.points });
  // Prefer the native share sheet on devices that can share files (phones);
  // fall back to a plain download otherwise, or if sharing itself failed.
  const file = new File([gpx], 'route.gpx', { type: 'application/gpx+xml' });
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: 'brx route' });
      return;
    } catch (err) {
      if (err.name === 'AbortError') return; // user closed the share sheet
    }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([gpx], { type: 'application/gpx+xml' }));
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
  map.setRegions(regions);
  const list = $('region-list');
  let hotId = null; // coarse-pointer tap-to-highlight toggle
  list.replaceChildren(...regions.map((r) => {
    const li = document.createElement('li');
    li.onmouseenter = () => map.setRegions(regions, r.id);
    li.onmouseleave = () => map.setRegions(regions, COARSE ? hotId : null);
    if (COARSE) {
      li.onclick = (e) => {
        if (e.target.tagName === 'BUTTON') return;
        hotId = hotId === r.id ? null : r.id;
        map.setRegions(regions, hotId);
      };
    }
    const name = Object.assign(document.createElement('span'), {
      className: 'region-name', textContent: r.name, title: r.name,
    });
    const size = Object.assign(document.createElement('span'), {
      className: 'region-size', textContent: `${(r.bytes / 1e6).toFixed(1)} MB`,
    });
    const del = Object.assign(document.createElement('button'), { textContent: '✕', title: 'Delete' });
    del.onclick = async () => {
      const ok = await showNotice(`Delete offline region “${r.name}”?`,
        [{ label: 'Delete', value: true, danger: true }]);
      if (!ok) return;
      await localRouter.deleteRegion(r.id);
      refreshRegions();
      if (engine() === 'local') reroute();
    };
    li.append(name, size, del);
    return li;
  }));
}

// Overpass responses have no usable length header (gzip), so the bar is
// indeterminate: an animated sweep plus a live label ("… 4.2 MB").
function setProgress(el, label) {
  el.querySelector('.progress-label').textContent = label;
}

// Shared by the toolbar/sheet button and the banner's "Download this area" CTA.
async function downloadVisibleArea() {
  const b = map.getBounds(); // [s, w, n, e]
  const area = (b[2] - b[0]) * (b[3] - b[1]);
  if (area > 0.15) {
    const ok = await showNotice(
      'Large area — the download may be slow or rejected by Overpass. Zoom in for faster downloads.',
      [{ label: 'Download anyway', value: true }],
    );
    if (!ok) return;
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
      onProgress(stage, info) {
        let msg =
          { download: 'Downloading OSM data…', build: 'Building routing graph…', dem: 'Downloading elevation…', store: 'Saving…' }[stage] ?? stage;
        if (info?.loaded) msg += ` ${(info.loaded / 1048576).toFixed(1)} MB`;
        if (info?.total) msg += ` ${info.done}/${info.total}`;
        setProgress(regionProgress, msg);
        // On phones also show a toast above the bottom bar, so progress stays
        // visible with the sheet closed.
        setProgress(dlToast, msg);
        dlToast.hidden = !phoneMq.matches;
      },
    });
    regionProgress.hidden = true;
    banner.hidden = true; // clear a stale "no routing data" error
    await refreshRegions();
    if (engine() === 'local') reroute();
  } catch (err) {
    regionProgress.hidden = true;
    showError(err);
  } finally {
    dlToast.hidden = true;
    btn.disabled = false;
  }
}

$('download-region').onclick = downloadVisibleArea;

// ---------------------------------------------------------------- phone layout

// Bottom sheet: re-homes #toolbar-body on phones. The node is physically
// moved (not duplicated) so all the wiring above keeps working.
const sheet = $('sheet');
const sheetScrim = $('sheet-scrim');
const toolbarBody = $('toolbar-body');

function openSheet(on) {
  sheet.classList.toggle('open', on);
  sheetScrim.hidden = !on;
}
$('bb-menu').onclick = () => openSheet(!sheet.classList.contains('open'));
sheetScrim.onclick = () => openSheet(false);
$('sheet-handle').onclick = () => openSheet(false);

function placeToolbarBody() {
  (phoneMq.matches ? $('sheet-scroll') : $('toolbar')).appendChild(toolbarBody);
  if (!phoneMq.matches) openSheet(false);
}
phoneMq.addEventListener('change', placeToolbarBody);
placeToolbarBody();

// Segmented profile control (local profiles). With BRouter active, taps pick
// the nearest BRouter profile; the highlight reflects the nearest local one.
const NEAREST_LOCAL = { trekking: 'bike', fastbike: 'bike', 'car-fast': 'car', 'hiking-mountain': 'foot' };
const TO_BROUTER = { bike: 'trekking', foot: 'hiking-mountain', car: 'car-fast' };
const bbButtons = [...document.querySelectorAll('#bb-profiles button')];
bbButtons.forEach((btn) => {
  btn.onclick = () => {
    state.profile = engine() === 'local' ? btn.dataset.profile : TO_BROUTER[btn.dataset.profile];
    syncControls();
    writeUrl();
    reroute();
  };
});

function syncBottomBar() {
  const p = engine() === 'local' ? state.profile : NEAREST_LOCAL[state.profile];
  bbButtons.forEach((b) => b.classList.toggle('active', b.dataset.profile === p));
}

// Elevation strip: the small handle (not the scrub area) toggles ~40vh.
$('elev-expand').onclick = () => {
  const on = elevationPanel.classList.toggle('expanded');
  const btn = $('elev-expand');
  btn.textContent = on ? '⌄' : '⌃';
  btn.title = btn.ariaLabel = on ? 'Collapse elevation profile' : 'Expand elevation profile';
  btn.setAttribute('aria-expanded', String(on));
};

// ---------------------------------------------------------------- boot

syncControls();
map.setView(state.map ?? DEFAULT_VIEW);
if (state.points.length >= 2 && !location.hash.includes('map=')) map.fitPoints(state.points);
refreshRegions();
reroute();
writeUrl(true);
registerPWA();
setupInstall($('install'));

// ---------------------------------------------------------------- collapse panel
const toolbar = $('toolbar');
const collapseBtn = $('collapse');
function setCollapsed(on) {
  toolbar.classList.toggle('collapsed', on);
  collapseBtn.setAttribute('aria-expanded', String(!on));
  collapseBtn.title = on ? 'Expand panel' : 'Collapse panel';
  try { localStorage.setItem('brx-collapsed', on ? '1' : '0'); } catch {}
}
collapseBtn.onclick = () => setCollapsed(!toolbar.classList.contains('collapsed'));
// Small screens: start collapsed (map first) unless the user chose otherwise.
try {
  const saved = localStorage.getItem('brx-collapsed');
  if (saved === '1' || (saved == null && SMALL)) setCollapsed(true);
} catch {
  if (SMALL) setCollapsed(true);
}
if (SMALL) $('regions-box').open = false;
