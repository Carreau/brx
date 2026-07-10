// Leaflet wrapper: owns markers, route polylines and map interactions.
import L from 'leaflet';

const ROUTE_STYLE = { color: '#ff6b35', weight: 5, opacity: 0.9 };
const PENDING_STYLE = { color: '#9a9aab', weight: 4, opacity: 0.6, dashArray: '6 8' };

function waypointIcon(index, count) {
  const cls = index === 0 ? 'wp-icon start' : index === count - 1 ? 'wp-icon end' : 'wp-icon';
  return L.divIcon({
    className: '',
    html: `<div class="${cls}">${index + 1}</div>`,
    iconSize: [24, 24],
    iconAnchor: [12, 12],
  });
}

export function createMap(el, handlers) {
  const map = L.map(el, { zoomControl: false });
  L.control.zoom({ position: 'bottomright' }).addTo(map);
  L.control.scale({ imperial: false }).addTo(map);

  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);

  const markerLayer = L.layerGroup().addTo(map);
  const routeLayer = L.layerGroup().addTo(map);
  let highlightDot = null;
  let dragging = false;

  map.on('click', (e) => handlers.onMapClick?.(e.latlng));
  map.on('moveend', () => handlers.onMapMove?.(api.getView()));

  const api = {
    setView({ lat, lng, zoom }) {
      map.setView([lat, lng], zoom, { animate: false });
    },

    getBounds() {
      const b = map.getBounds();
      return [b.getSouth(), b.getWest(), b.getNorth(), b.getEast()];
    },

    getView() {
      const c = map.getCenter();
      return { lat: c.lat, lng: c.lng, zoom: map.getZoom() };
    },

    setPoints(points) {
      // An async render (segment fetch resolving) must not destroy the marker
      // under the user's cursor; the dragend reroute will re-sync markers.
      if (dragging) return;
      markerLayer.clearLayers();
      points.forEach((p, i) => {
        const m = L.marker([p.lat, p.lng], {
          icon: waypointIcon(i, points.length),
          draggable: true,
        });
        m.on('dragstart', () => { dragging = true; });
        m.on('dragend', () => {
          dragging = false;
          const ll = m.getLatLng();
          handlers.onMarkerDrag?.(i, { lat: ll.lat, lng: ll.lng });
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
          const line = L.polyline(seg.coords.map((c) => [c.lat, c.lng]), ROUTE_STYLE);
          // Click on the route inserts a via point into this segment.
          line.on('click', (e) => {
            L.DomEvent.stop(e);
            handlers.onRouteInsert?.(i, { lat: e.latlng.lat, lng: e.latlng.lng });
          });
          line.addTo(routeLayer);
        } else if (points[i] && points[i + 1]) {
          L.polyline(
            [[points[i].lat, points[i].lng], [points[i + 1].lat, points[i + 1].lng]],
            PENDING_STYLE,
          ).addTo(routeLayer);
        }
      });
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
      map.fitBounds(L.latLngBounds(points.map((p) => [p.lat, p.lng])), { padding: [60, 60] });
    },
  };

  return api;
}
