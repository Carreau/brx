// GPX 1.1 export + import parsing.

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;",
  })[c]);
}

export function toGPX({ name, coords = [], waypoints = [] }) {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<gpx xmlns="http://www.topografix.com/GPX/1/1" version="1.1" creator="brx">',
    `  <metadata><name>${esc(name ?? "brx route")}</name></metadata>`,
  ];
  if (waypoints.length) {
    lines.push("  <rte>");
    for (const p of waypoints) {
      lines.push(`    <rtept lat="${p.lat.toFixed(6)}" lon="${p.lng.toFixed(6)}"/>`);
    }
    lines.push("  </rte>");
  }
  if (coords.length) {
    lines.push("  <trk>", `    <name>${esc(name ?? "brx route")}</name>`, "    <trkseg>");
    for (const c of coords) {
      const ele = Number.isFinite(c.ele) ? `<ele>${c.ele.toFixed(1)}</ele>` : "";
      lines.push(`      <trkpt lat="${c.lat.toFixed(6)}" lon="${c.lng.toFixed(6)}">${ele}</trkpt>`);
    }
    lines.push("    </trkseg>", "  </trk>");
  }
  lines.push("</gpx>", "");
  return lines.join("\n");
}

export function parseGPX(text) {
  let doc;
  try {
    doc = new DOMParser().parseFromString(text, "application/xml");
  } catch {
    throw new Error("Invalid GPX");
  }
  if (!doc || doc.getElementsByTagName("parsererror").length) {
    throw new Error("Invalid GPX");
  }

  // getElementsByTagName matches regardless of the gpx default namespace in
  // browsers' XML DOM only when names are unprefixed; use the NS-wildcard
  // variant to be safe with prefixed documents too.
  const byName = (tag) =>
    doc.getElementsByTagNameNS
      ? doc.getElementsByTagNameNS("*", tag)
      : doc.getElementsByTagName(tag);

  const toPoints = (nodes) => {
    const pts = [];
    for (const el of nodes) {
      const lat = parseFloat(el.getAttribute("lat"));
      const lng = parseFloat(el.getAttribute("lon"));
      if (Number.isFinite(lat) && Number.isFinite(lng)) pts.push({ lat, lng });
    }
    return pts;
  };

  let points = toPoints(byName("rtept"));
  if (!points.length) points = toPoints(byName("wpt"));
  if (!points.length) {
    const trkpts = toPoints(byName("trkpt"));
    const n = trkpts.length;
    if (n <= 25) {
      points = trkpts;
    } else {
      // Evenly sample at most 25 points, always including first and last.
      points = [];
      for (let i = 0; i < 25; i++) {
        points.push(trkpts[Math.round((i * (n - 1)) / 24)]);
      }
    }
  }

  if (!points.length) throw new Error("Invalid GPX");
  return { points };
}
