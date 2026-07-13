// Leaflet wrapper: owns markers, route polylines and map interactions.
import L from 'leaflet';
import { computeSlopes, slopeRuns } from './slope.js';

const ROUTE_STYLE = { color: '#ff6b35', weight: 5, opacity: 0.9 };
// Thin dark underlay beneath slope-colored routes: keeps the light mid-scale
// colors readable against pale tiles.
const CASING_STYLE = { color: '#40342c', weight: 7, opacity: 0.5, interactive: false };
const PENDING_STYLE = { color: '#9a9aab', weight: 4, opacity: 0.6, dashArray: '6 8' };
// Invisible fat line under each route segment: a finger-sized click target.
const HIT_STYLE = { color: '#000', weight: 26, opacity: 0.001 };

const COARSE = window.matchMedia?.('(pointer: coarse)').matches ?? false;

function waypointIcon(index, count, selected) {
  let cls = index === 0 ? 'wp-icon start' : index === count - 1 ? 'wp-icon end' : 'wp-icon';
  if (selected) cls += ' selected';
  // On touch the divIcon box is 40px (hit area); the visual circle inside is
  // sized down and centered by the (pointer: coarse) CSS.
  const size = COARSE ? 40 : 24;
  return L.divIcon({
    className: '',
    html: `<div class="${cls}">${index + 1}</div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

export function createMap(el, handlers) {
  const map = L.map(el, { zoomControl: false });
  if (!COARSE) L.control.zoom({ position: 'bottomright' }).addTo(map);
  L.control.scale({ imperial: false }).addTo(map);

  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);

  // Slope-colored routes are many short polylines; one shared canvas
  // renderer keeps that cheap (SVG would create thousands of nodes).
  const routeRenderer = L.canvas({ padding: 0.5 });
  const regionLayer = L.layerGroup().addTo(map);
  const markerLayer = L.layerGroup().addTo(map);
  const routeLayer = L.layerGroup().addTo(map);
  let highlightDot = null;
  let dragging = false;
  let locMarker = null;  // "you are here" dot
  let locCircle = null;  // accuracy circle

  // True while the app itself moves the view (panTo/setView/fitPoints), so a
  // resulting zoomstart isn't mistaken for a user pinch. Reset on a timeout:
  // animated zooms fire zoomstart synchronously, but not always.
  let programmaticMove = false;
  const programmatic = (fn) => {
    programmaticMove = true;
    try { fn(); } finally { setTimeout(() => { programmaticMove = false; }, 0); }
  };

  // Debounced tap, shared by map clicks and route-insert clicks: the first tap
  // of a double-tap zoom must not add a waypoint, and the click tailing a
  // long-press must be swallowed.
  let clickTimer = null;
  const debouncedTap = (fn) => {
    if (suppressClick) { suppressClick = false; return; } // tail of a long-press
    if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; return; }
    clickTimer = setTimeout(() => {
      clickTimer = null;
      fn();
    }, 250);
  };
  map.on('click', (e) => debouncedTap(() => handlers.onMapClick?.(e.latlng)));
  map.on('moveend', () => handlers.onMapMove?.(api.getView()));
  // dragstart only fires for user-initiated pans (not panTo/setView); zoomstart
  // also fires for the app's own setView/panTo, so those set programmaticMove.
  map.on('dragstart', () => handlers.onUserPan?.());
  map.on('zoomstart', () => { if (!programmaticMove) handlers.onUserPan?.(); });

  // Long-press (~500ms without movement) on the map itself — used upstream to
  // enter crosshair precision-add mode.
  let lpTimer = null;
  let lpStart = null;
  let suppressClick = false;
  const cancelLongPress = () => { clearTimeout(lpTimer); lpTimer = null; };
  el.addEventListener('pointerdown', (e) => {
    suppressClick = false;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (e.target.closest('.leaflet-marker-icon, .leaflet-control')) return;
    lpStart = [e.clientX, e.clientY];
    cancelLongPress();
    lpTimer = setTimeout(() => {
      lpTimer = null;
      suppressClick = true; // the pointerup's click must not add a waypoint
      handlers.onLongPress?.(map.mouseEventToLatLng(e));
    }, 500);
  });
  el.addEventListener('pointermove', (e) => {
    if (lpTimer && Math.hypot(e.clientX - lpStart[0], e.clientY - lpStart[1]) > 8) cancelLongPress();
  });
  el.addEventListener('pointerup', cancelLongPress);
  el.addEventListener('pointercancel', cancelLongPress);

  const api = {
    setView({ lat, lng, zoom }) {
      programmatic(() => map.setView([lat, lng], zoom, { animate: false }));
    },

    getBounds() {
      const b = map.getBounds();
      return [b.getSouth(), b.getWest(), b.getNorth(), b.getEast()];
    },

    getView() {
      const c = map.getCenter();
      return { lat: c.lat, lng: c.lng, zoom: map.getZoom() };
    },

    setPoints(points, selected = null) {
      // An async render (segment fetch resolving) must not destroy the marker
      // under the user's cursor; the dragend reroute will re-sync markers.
      if (dragging) return;
      markerLayer.clearLayers();
      points.forEach((p, i) => {
        const m = L.marker([p.lat, p.lng], {
          icon: waypointIcon(i, points.length, i === selected),
          draggable: true,
        });
        m.on('dragstart', () => { dragging = true; });
        m.on('dragend', () => {
          dragging = false;
          const ll = m.getLatLng();
          handlers.onMarkerDrag?.(i, { lat: ll.lat, lng: ll.lng });
        });
        m.on('click', (e) => {
          L.DomEvent.stop(e);
          handlers.onMarkerTap?.(i);
        });
        m.on('contextmenu', (e) => {
          L.DomEvent.stop(e);
          handlers.onMarkerDelete?.(i);
        });
        m.addTo(markerLayer);
      });
    },

    // segments: array of { coords: [{lat,lng}] } | null (null = still routing:
    // drawn as a dashed straight line between its endpoints)
    setSegments(segments, points) {
      routeLayer.clearLayers();
      segments.forEach((seg, i) => {
        if (seg) {
          const latlngs = seg.coords.map((c) => [c.lat, c.lng]);
          // Click on the route inserts a via point into this segment.
          const insert = (e) => {
            L.DomEvent.stop(e);
            const ll = { lat: e.latlng.lat, lng: e.latlng.lng };
            debouncedTap(() => handlers.onRouteInsert?.(i, ll));
          };
          L.polyline(latlngs, HIT_STYLE).on('click', insert).addTo(routeLayer);
          const slopes = computeSlopes(seg.coords);
          if (slopes) {
            // One polyline per run of (quantized-)equal slope color; clicks
            // fall through (interactive: false) to the fat hit line above.
            L.polyline(latlngs, { ...CASING_STYLE, renderer: routeRenderer }).addTo(routeLayer);
            for (const run of slopeRuns(slopes)) {
              L.polyline(latlngs.slice(run.start, run.end + 1), {
                ...ROUTE_STYLE, color: run.color, renderer: routeRenderer, interactive: false,
              }).addTo(routeLayer);
            }
          } else {
            L.polyline(latlngs, ROUTE_STYLE).on('click', insert).addTo(routeLayer);
          }
        } else if (points[i] && points[i + 1]) {
          L.polyline(
            [[points[i].lat, points[i].lng], [points[i + 1].lat, points[i + 1].lng]],
            PENDING_STYLE,
          ).addTo(routeLayer);
        }
      });
    },

    // Dashed rectangles showing where offline routing data exists.
    setRegions(regions, highlightId = null) {
      regionLayer.clearLayers();
      for (const r of regions) {
        const hot = r.id === highlightId;
        L.rectangle([[r.bbox[0], r.bbox[1]], [r.bbox[2], r.bbox[3]]], {
          color: '#4fa3ff',
          weight: hot ? 2.5 : 1.5,
          dashArray: '4 6',
          fillColor: '#4fa3ff',
          fillOpacity: hot ? 0.12 : 0.04,
          interactive: false,
        }).addTo(regionLayer);
      }
    },

    setHighlight(latlng) {
      if (highlightDot) { highlightDot.remove(); highlightDot = null; }
      if (latlng) {
        highlightDot = L.circleMarker([latlng.lat, latlng.lng], {
          radius: 6, color: '#fff', weight: 2, fillColor: '#ff6b35', fillOpacity: 1,
        }).addTo(map);
      }
    },

    fitPoints(points) {
      if (points.length < 2) return;
      programmatic(() => map.fitBounds(L.latLngBounds(points.map((p) => [p.lat, p.lng])), { padding: [60, 60] }));
    },

    // Center on latlng, animated; never zooms out below the current zoom.
    panTo({ lat, lng }, minZoom = 0) {
      programmatic(() => map.setView([lat, lng], Math.max(map.getZoom(), minZoom), { animate: true }));
    },

    // Blue "you are here" dot + accuracy circle; heading (deg) rotates a small
    // arrow around the dot, null hides it. setLocation(null) removes everything.
    setLocation(pos) {
      if (!pos) {
        locMarker?.remove(); locCircle?.remove();
        locMarker = locCircle = null;
        return;
      }
      const ll = [pos.lat, pos.lng];
      if (!locMarker) {
        locCircle = L.circle(ll, {
          radius: pos.accuracy || 0,
          color: '#2b7de9', weight: 1, opacity: 0.5,
          fillColor: '#2b7de9', fillOpacity: 0.12,
          interactive: false,
        }).addTo(map);
        locMarker = L.marker(ll, {
          icon: L.divIcon({
            className: '',
            html: '<div class="loc-dot"><div class="loc-heading" hidden></div></div>',
            iconSize: [18, 18],
            iconAnchor: [9, 9],
          }),
          interactive: false,
          zIndexOffset: 400,
        }).addTo(map);
      } else {
        locMarker.setLatLng(ll);
        locCircle.setLatLng(ll);
        locCircle.setRadius(pos.accuracy || 0);
      }
      const arrow = locMarker.getElement()?.querySelector('.loc-heading');
      if (arrow) {
        arrow.hidden = pos.heading == null;
        if (pos.heading != null) arrow.style.transform = `rotate(${pos.heading}deg)`;
      }
    },
  };

  return api;
}
