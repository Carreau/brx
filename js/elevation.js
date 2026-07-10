// Canvas elevation profile. Browser-only, no deps.

const PAD = { top: 10, right: 12, bottom: 20, left: 42 };

function haversine(a, b) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

// Nice rounded tick step so we get ~n ticks over span.
function niceStep(span, n) {
  const raw = span / Math.max(n, 1);
  const mag = 10 ** Math.floor(Math.log10(raw || 1));
  for (const m of [1, 2, 5, 10]) if (m * mag >= raw) return m * mag;
  return 10 * mag;
}

function cssColor(el, name, fallback) {
  const v = getComputedStyle(el).getPropertyValue(name).trim();
  return v || fallback;
}

export function createElevationProfile(canvas, { onHover } = {}) {
  const ctx = canvas.getContext("2d");
  let coords = [];      // [{lat, lng, ele}]
  let dists = [];       // cumulative meters, same length
  let total = 0;
  let hoverIdx = null;  // from mouse over canvas
  let highlightIdx = null; // from setHighlight (map hover)

  function ele(i) {
    const e = coords[i].ele;
    return Number.isFinite(e) ? e : 0;
  }

  function rebuild() {
    dists = [];
    total = 0;
    for (let i = 0; i < coords.length; i++) {
      if (i > 0) total += haversine(coords[i - 1], coords[i]);
      dists.push(total);
    }
  }

  function draw() {
    const dpr = window.devicePixelRatio || 1;
    // clientWidth is 0 while the panel is display:none — never fall back to
    // canvas.width (the backing store), or the buffer grows by dpr each draw.
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (!w || !h) return;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const bg = cssColor(canvas, "--panel-bg", "#1e1e28");
    const accent = cssColor(canvas, "--accent", "#ff6b35");
    const text = cssColor(canvas, "--text", "#e8e8ee");

    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);

    const iw = w - PAD.left - PAD.right;
    const ih = h - PAD.top - PAD.bottom;
    if (coords.length < 2 || total <= 0 || iw <= 0 || ih <= 0) return;

    let eMin = Infinity, eMax = -Infinity;
    for (let i = 0; i < coords.length; i++) {
      const e = ele(i);
      if (e < eMin) eMin = e;
      if (e > eMax) eMax = e;
    }
    if (eMax - eMin < 1) { eMin -= 5; eMax += 5; } // flat line (e.g. all ele missing)

    const x = (d) => PAD.left + (d / total) * iw;
    const y = (e) => PAD.top + ih - ((e - eMin) / (eMax - eMin)) * ih;

    // grid + y-axis labels (meters)
    ctx.font = "10px sans-serif";
    ctx.strokeStyle = text;
    ctx.fillStyle = text;
    const yStep = niceStep(eMax - eMin, 4);
    ctx.globalAlpha = 1;
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    for (let e = Math.ceil(eMin / yStep) * yStep; e <= eMax; e += yStep) {
      ctx.globalAlpha = 0.15;
      ctx.beginPath();
      ctx.moveTo(PAD.left, y(e));
      ctx.lineTo(PAD.left + iw, y(e));
      ctx.stroke();
      ctx.globalAlpha = 0.8;
      ctx.fillText(`${Math.round(e)} m`, PAD.left - 4, y(e));
    }

    // x-axis labels (km)
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    const totalKm = total / 1000;
    const xStep = niceStep(totalKm, 6);
    for (let km = 0; km <= totalKm + 1e-9; km += xStep) {
      const px = x(km * 1000);
      ctx.globalAlpha = 0.15;
      ctx.beginPath();
      ctx.moveTo(px, PAD.top);
      ctx.lineTo(px, PAD.top + ih);
      ctx.stroke();
      ctx.globalAlpha = 0.8;
      ctx.fillText(`${+km.toFixed(2)} km`, px, PAD.top + ih + 4);
    }
    ctx.globalAlpha = 1;

    // filled area + line
    ctx.beginPath();
    ctx.moveTo(x(dists[0]), y(ele(0)));
    for (let i = 1; i < coords.length; i++) ctx.lineTo(x(dists[i]), y(ele(i)));
    ctx.strokeStyle = accent;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.lineTo(x(dists[coords.length - 1]), PAD.top + ih);
    ctx.lineTo(x(dists[0]), PAD.top + ih);
    ctx.closePath();
    ctx.globalAlpha = 0.25;
    ctx.fillStyle = accent;
    ctx.fill();
    ctx.globalAlpha = 1;

    // highlight marker (from map hover)
    if (highlightIdx != null && coords[highlightIdx]) {
      ctx.beginPath();
      ctx.arc(x(dists[highlightIdx]), y(ele(highlightIdx)), 4, 0, 2 * Math.PI);
      ctx.fillStyle = accent;
      ctx.fill();
      ctx.strokeStyle = text;
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    // hover crosshair + label
    if (hoverIdx != null && coords[hoverIdx]) {
      const px = x(dists[hoverIdx]), py = y(ele(hoverIdx));
      ctx.strokeStyle = text;
      ctx.globalAlpha = 0.5;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(px, PAD.top);
      ctx.lineTo(px, PAD.top + ih);
      ctx.moveTo(PAD.left, py);
      ctx.lineTo(PAD.left + iw, py);
      ctx.stroke();
      ctx.globalAlpha = 1;

      ctx.beginPath();
      ctx.arc(px, py, 3, 0, 2 * Math.PI);
      ctx.fillStyle = accent;
      ctx.fill();

      const label = `${(dists[hoverIdx] / 1000).toFixed(1)} km · ${Math.round(ele(hoverIdx))} m`;
      ctx.font = "11px sans-serif";
      const tw = ctx.measureText(label).width;
      let lx = px + 8;
      if (lx + tw + 8 > w) lx = px - tw - 16;
      const ly = Math.max(py - 22, PAD.top);
      ctx.fillStyle = bg;
      ctx.globalAlpha = 0.9;
      ctx.fillRect(lx, ly, tw + 8, 16);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = accent;
      ctx.strokeRect(lx, ly, tw + 8, 16);
      ctx.fillStyle = text;
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillText(label, lx + 4, ly + 8);
    }
  }

  function nearestIndex(mouseX) {
    if (coords.length < 2 || total <= 0) return null;
    const iw = (canvas.clientWidth || canvas.width) - PAD.left - PAD.right;
    if (iw <= 0) return null;
    const d = ((mouseX - PAD.left) / iw) * total;
    // binary search on cumulative distances
    let lo = 0, hi = dists.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (dists[mid] < d) lo = mid + 1; else hi = mid;
    }
    if (lo > 0 && Math.abs(dists[lo - 1] - d) < Math.abs(dists[lo] - d)) lo--;
    return lo;
  }

  function onMouseMove(ev) {
    const rect = canvas.getBoundingClientRect();
    const idx = nearestIndex(ev.clientX - rect.left);
    if (idx !== hoverIdx) {
      hoverIdx = idx;
      draw();
      if (onHover) onHover(idx);
    }
  }

  function onMouseLeave() {
    if (hoverIdx !== null) {
      hoverIdx = null;
      draw();
    }
    if (onHover) onHover(null);
  }

  canvas.addEventListener("mousemove", onMouseMove);
  canvas.addEventListener("mouseleave", onMouseLeave);
  const ro = new ResizeObserver(() => draw());
  ro.observe(canvas);

  return {
    setData(newCoords) {
      coords = Array.isArray(newCoords) ? newCoords : [];
      hoverIdx = null;
      highlightIdx = null;
      rebuild();
      draw();
    },
    setHighlight(index) {
      highlightIdx = Number.isInteger(index) && coords[index] ? index : null;
      draw();
    },
    destroy() {
      canvas.removeEventListener("mousemove", onMouseMove);
      canvas.removeEventListener("mouseleave", onMouseLeave);
      ro.disconnect();
    },
  };
}
