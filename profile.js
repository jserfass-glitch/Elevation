// Elevation profile along a route the user draws: freehand strokes or
// straight taps. The chart marks where each segment starts and ends.

import { DEM_MAX_ZOOM, areaSampler, lngToX, latToY, pixelMeters } from './dem.js';

const SAMPLE_M = 20; // target spacing between profile samples, meters
const MAX_SAMPLES = 4000;
const EARTH_RADIUS = 6371000;

const toRad = (d) => (d * Math.PI) / 180;
export function haversine([lng1, lat1], [lng2, lat2]) {
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS * Math.asin(Math.sqrt(a));
}

/**
 * Samples elevation along a route made of legs. Each leg is a polyline of
 * [lng, lat] points (two points for a straight tap, many for a drawn stroke)
 * and starts where the previous one ended; leg ends are the numbered
 * boundaries on the chart.
 * Returns { points: [{ d, elev, lngLat, seg }], vertices: [{ d, elev, i }],
 * segments: [{ d0, d1, length, gain, loss }], gain, loss, length } in meters.
 */
export async function sampleProfile(legs) {
  legs = legs.filter((leg) => leg.length > 1);
  const cums = legs.map((leg) => {
    const c = [0];
    for (let k = 1; k < leg.length; k++) c.push(c[k - 1] + haversine(leg[k - 1], leg[k]));
    return c;
  });
  const lengths = cums.map((c) => c[c.length - 1]);
  const total = lengths.reduce((a, b) => a + b, 0);
  if (!legs.length || total === 0) return null;
  const spacing = Math.max(SAMPLE_M, total / MAX_SAMPLES);

  // One sampler covers the whole route, at the finest zoom that keeps the
  // tile count sensible.
  const all = legs.flat();
  const lngs = all.map((v) => v[0]);
  const lats = all.map((v) => v[1]);
  const center = [(Math.min(...lngs) + Math.max(...lngs)) / 2, (Math.min(...lats) + Math.max(...lats)) / 2];
  const radius = Math.max(...all.map((v) => haversine(center, v))) + 200;
  let z = DEM_MAX_ZOOM;
  while (z > 8 && (radius / pixelMeters(z, center[1]) / 256) * 2 > 6) z--;
  const s = await areaSampler(z, center[0], center[1], radius);
  const n = 2 ** z;
  const elevAt = ([lng, lat]) => s.sample(lngToX(lng, n) * 256, latToY(lat, n) * 256);

  // Position `dist` meters along leg i.
  const along = (i, dist) => {
    const leg = legs[i];
    const c = cums[i];
    let k = 1;
    while (k < c.length - 1 && c[k] < dist) k++;
    const span = c[k] - c[k - 1] || 1;
    const t = Math.max(0, Math.min(1, (dist - c[k - 1]) / span));
    const a = leg[k - 1];
    const b = leg[k];
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  };

  const points = [];
  const verts = [];
  const segments = [];
  let d = 0;
  for (let i = 0; i < legs.length; i++) {
    const len = lengths[i];
    const steps = Math.max(1, Math.round(len / spacing));
    const seg = { d0: d, d1: d + len, length: len, gain: 0, loss: 0 };
    const last = i === legs.length - 1;
    let prev = null;
    // The last sample of a leg is the first of the next, so only the final
    // leg emits its end point; its elevation still counts toward this leg.
    for (let k = 0; k <= steps; k++) {
      const lngLat = along(i, (len * k) / steps);
      const elev = elevAt(lngLat);
      if (k === 0) verts.push({ d, elev, i });
      if (k < steps || last) points.push({ d: d + (len * k) / steps, elev, lngLat, seg: i });
      if (prev != null && Number.isFinite(elev) && Number.isFinite(prev)) {
        const diff = elev - prev;
        if (diff > 0) seg.gain += diff;
        else seg.loss -= diff;
      }
      prev = elev;
    }
    segments.push(seg);
    d += len;
  }
  const end = legs[legs.length - 1];
  verts.push({ d, elev: elevAt(end[end.length - 1]), i: legs.length });
  const gain = segments.reduce((a, s2) => a + s2.gain, 0);
  const loss = segments.reduce((a, s2) => a + s2.loss, 0);
  return { points, vertices: verts, segments, gain, loss, length: total };
}

/** Douglas-Peucker simplification of [x, y] screen points. */
export function simplify(pts, tolerance) {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, ay] = pts[a];
    const [bx, by] = pts[b];
    const dx = bx - ax;
    const dy = by - ay;
    const len = Math.hypot(dx, dy) || 1;
    let worst = -1;
    let worstD = tolerance;
    for (let k = a + 1; k < b; k++) {
      const dist = Math.abs(dy * pts[k][0] - dx * pts[k][1] + bx * ay - by * ax) / len;
      if (dist > worstD) {
        worst = k;
        worstD = dist;
      }
    }
    if (worst > 0) {
      keep[worst] = 1;
      stack.push([a, worst], [worst, b]);
    }
  }
  return pts.filter((_, k) => keep[k]);
}

/**
 * Draws the profile into an SVG element. Vertex markers are labeled 1..n.
 * `fmtElev(m)` and `fmtDist(m)` format axis labels; `onHover(point|null)` reports
 * the point under the pointer.
 */
export function drawProfileChart(svg, profile, { toUnits = (m) => m, fmtElev, fmtDist, onHover }) {
  const W = svg.clientWidth || 300;
  const H = svg.clientHeight || 140;
  const pad = { l: 52, r: 12, t: 16, b: 20 };
  const cw = W - pad.l - pad.r;
  const ch = H - pad.t - pad.b;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);

  const pts = profile.points.filter((p) => Number.isFinite(p.elev)).map((p) => ({ ...p, elev: toUnits(p.elev), raw: p }));
  const verts = profile.vertices.map((v) => ({ ...v, elev: toUnits(v.elev) }));
  let lo = Math.min(...pts.map((p) => p.elev));
  let hi = Math.max(...pts.map((p) => p.elev));
  if (hi - lo < 10) {
    lo -= 5;
    hi += 5;
  }
  const padE = (hi - lo) * 0.08;
  lo -= padE;
  hi += padE;
  const x = (d) => pad.l + (d / profile.length) * cw;
  const y = (e) => pad.t + ch - ((e - lo) / (hi - lo)) * ch;

  const el = (name, attrs = {}, text) => {
    const e = document.createElementNS('http://www.w3.org/2000/svg', name);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    if (text != null) e.textContent = text;
    return e;
  };
  svg.replaceChildren();

  // Alternate segment bands so each segment reads as its own block.
  profile.segments.forEach((s, i) => {
    svg.append(el('rect', { class: `seg-band ${i % 2 ? 'odd' : ''}`, x: x(s.d0), y: pad.t, width: Math.max(0, x(s.d1) - x(s.d0)), height: ch }));
  });

  // Elevation grid lines
  const ticks = niceTicks(lo, hi, 4);
  for (const t of ticks) {
    svg.append(el('line', { class: 'grid', x1: pad.l, x2: W - pad.r, y1: y(t), y2: y(t) }));
    svg.append(el('text', { class: 'axis', x: pad.l - 6, y: y(t) + 4, 'text-anchor': 'end' }, fmtElev(t)));
  }
  // Distance labels at start and end
  svg.append(el('text', { class: 'axis', x: pad.l, y: H - 6 }, '0'));
  svg.append(el('text', { class: 'axis', x: W - pad.r, y: H - 6, 'text-anchor': 'end' }, fmtDist(profile.length)));

  // Area + line
  const path = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.d).toFixed(1)},${y(p.elev).toFixed(1)}`).join('');
  svg.append(el('path', { class: 'area', d: `${path}L${x(pts[pts.length - 1].d).toFixed(1)},${pad.t + ch}L${x(pts[0].d).toFixed(1)},${pad.t + ch}Z` }));
  svg.append(el('path', { class: 'line', d: path }));

  // Vertex markers: a line down to the axis and a numbered dot.
  verts.forEach((v) => {
    const vx = x(v.d);
    svg.append(el('line', { class: 'vertex-line', x1: vx, x2: vx, y1: pad.t, y2: pad.t + ch }));
    if (Number.isFinite(v.elev)) {
      svg.append(el('circle', { class: 'vertex-dot', cx: vx, cy: y(v.elev), r: 5 }));
      svg.append(el('text', { class: 'vertex-label', x: vx, y: pad.t - 3, 'text-anchor': 'middle' }, String(v.i + 1)));
    }
  });

  // Hover cursor
  const cursor = el('line', { class: 'cursor', x1: 0, x2: 0, y1: pad.t, y2: pad.t + ch, visibility: 'hidden' });
  const dot = el('circle', { class: 'cursor-dot', r: 4, visibility: 'hidden' });
  svg.append(cursor, dot);
  const hit = el('rect', { x: pad.l, y: 0, width: cw, height: H, fill: 'transparent' });
  svg.append(hit);

  const move = (clientX) => {
    const box = svg.getBoundingClientRect();
    const px = ((clientX - box.left) / box.width) * W;
    const d = Math.max(0, Math.min(profile.length, ((px - pad.l) / cw) * profile.length));
    // nearest sample by distance
    let lo2 = 0;
    let hi2 = pts.length - 1;
    while (lo2 < hi2) {
      const mid = (lo2 + hi2) >> 1;
      if (pts[mid].d < d) lo2 = mid + 1;
      else hi2 = mid;
    }
    const p = pts[lo2];
    cursor.setAttribute('x1', x(p.d));
    cursor.setAttribute('x2', x(p.d));
    cursor.setAttribute('visibility', 'visible');
    dot.setAttribute('cx', x(p.d));
    dot.setAttribute('cy', y(p.elev));
    dot.setAttribute('visibility', 'visible');
    onHover(p.raw);
  };
  const leave = () => {
    cursor.setAttribute('visibility', 'hidden');
    dot.setAttribute('visibility', 'hidden');
    onHover(null);
  };
  hit.addEventListener('pointermove', (e) => move(e.clientX));
  hit.addEventListener('pointerdown', (e) => {
    hit.setPointerCapture(e.pointerId);
    move(e.clientX);
  });
  hit.addEventListener('pointerleave', leave);
  hit.addEventListener('pointerup', (e) => {
    if (e.pointerType !== 'mouse') leave();
  });
}

function niceTicks(lo, hi, count) {
  const span = hi - lo;
  const raw = span / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) || mag * 10;
  const out = [];
  for (let t = Math.ceil(lo / step) * step; t <= hi; t += step) out.push(t);
  return out;
}
