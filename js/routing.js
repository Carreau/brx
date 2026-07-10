// BRouter HTTP client.

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

export async function routeSegment({ from, to, profile, endpoint, signal }) {
  const lonlats = `${from.lng},${from.lat}|${to.lng},${to.lat}`;
  const url = `${endpoint}?lonlats=${lonlats}&profile=${profile}&alternativeidx=0&format=geojson`;

  const res = await fetch(url, { signal });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`BRouter error ${res.status}: ${text.slice(0, 300)}`);
  }

  // BRouter often returns HTTP 200 with a plain-text error message.
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`BRouter error: ${text.slice(0, 300)}`);
  }

  const feature = data.features?.[0];
  if (!feature) throw new Error("BRouter error: response has no route feature");

  const props = feature.properties ?? {};
  return {
    coords: feature.geometry.coordinates.map(([lng, lat, ele]) => ({ lat, lng, ele })),
    distance: num(props["track-length"]),
    ascend: num(props["filtered ascend"]),
    time: num(props["total-time"]),
  };
}
