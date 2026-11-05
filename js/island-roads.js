// js/island-roads.js
// The island's main roads beyond the detailed city (tiles/<city>/roads.json, tools/city/tiles.mjs) as a queryable road
// set, for the island's traffic (js/island-traffic.js), teleports beyond the detailed city and the maps:
// - roads: [{ cls, name, pts (Float32Array x, z), cum (arc length at each point), len, oneway (1 along the points, -1
//   against, 0 both), lanes, speed (m/s) }]
// - nearest(x, z, r): the closest point on any road within r m: { road, seg, t, s (arc length), x, z, dx, dz (unit
//   direction along the points) } or null
// - snap(x, z, heading, r, keepLeft, { expressways }): a place to arrive on the nearest road: in a lane of its carriageway, facing its
//   traffic (the way nearest the requested heading where it runs both ways): { x, z, heading } or null
// - next(road, dir, list): the roads carrying on from the end `dir` is heading for (1: its last point, -1: its first),
//   as [{ road, dir }] that may be driven that way
// - inCore(x, z): inside the detailed city (whose own road graph and traffic take over)
// The world frame is the city's: x east, z south (north = -z); a heading h faces (sin h, cos h).

const CELL = 100; // m: the segment index's cells
const LANE = 3.3; // m per travel lane
// m/s by class: expressways at 90 km/h, Singapore's limit, the main roads 50-70 km/h
const SPEED = { motorway: 25, trunk: 19.4, primary: 16.7, secondary: 13.9, tertiary: 11.1 };
const JOIN = 3; // m: road ends this close are joined

function ringContains(ring, x, z) {
  let inside = false;
  for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
    const zi = ring[i + 1], zj = ring[j + 1];
    if ((zi > z) !== (zj > z) && x < ring[i] + ((z - zi) * (ring[j] - ring[i])) / (zj - zi)) inside = !inside;
  }
  return inside;
}

function createIslandRoads(data, { coreRing = null } = {}) {
  const roads = data.roads.map((r, k) => {
    const cls = data.classes[r[0]];
    const n = (r.length - 2) / 2;
    const pts = new Float32Array(n * 2);
    let x = 0, z = 0;
    for (let i = 0; i < n; i++) {
      x += r[2 + i * 2];
      z += r[3 + i * 2];
      pts[i * 2] = x;
      pts[i * 2 + 1] = z;
    }
    const cum = new Float32Array(n);
    for (let i = 1; i < n; i++) cum[i] = cum[i - 1] + Math.hypot(pts[i * 2] - pts[i * 2 - 2], pts[i * 2 + 1] - pts[i * 2 - 1]);
    return {
      id: k, cls, name: r[1] >= 0 ? data.names[r[1]] : '', pts, cum, len: cum[n - 1] || 0,
      oneway: data.oneway ? data.oneway[k] : 0, lanes: data.lanes ? data.lanes[k] : 2, speed: SPEED[cls] || 11
    };
  }).filter((r) => r.len > 1);

  // Segments by cell
  const cells = new Map();
  const key = (i, j) => i * 100003 + j;
  for (const road of roads) {
    const P = road.pts;
    for (let s = 0; s + 1 < P.length / 2; s++) {
      const x0 = Math.min(P[s * 2], P[s * 2 + 2]), x1 = Math.max(P[s * 2], P[s * 2 + 2]);
      const z0 = Math.min(P[s * 2 + 1], P[s * 2 + 3]), z1 = Math.max(P[s * 2 + 1], P[s * 2 + 3]);
      for (let i = Math.floor(x0 / CELL); i <= Math.floor(x1 / CELL); i++) {
        for (let j = Math.floor(z0 / CELL); j <= Math.floor(z1 / CELL); j++) {
          const k = key(i, j);
          let list = cells.get(k);
          if (!list) cells.set(k, (list = []));
          list.push(road, s);
        }
      }
    }
  }

  // Road ends, to carry on from one road to the next
  const ends = new Map();
  const endKey = (x, z) => key(Math.round(x / JOIN), Math.round(z / JOIN));
  const endsNear = (x, z) => {
    const out = [];
    const i0 = Math.round(x / JOIN), j0 = Math.round(z / JOIN);
    for (let i = i0 - 1; i <= i0 + 1; i++) for (let j = j0 - 1; j <= j0 + 1; j++) for (const e of ends.get(key(i, j)) || []) out.push(e);
    return out;
  };
  for (const road of roads) {
    const P = road.pts, n = P.length / 2;
    for (const [end, x, z] of [[0, P[0], P[1]], [1, P[n * 2 - 2], P[n * 2 - 1]]]) {
      const k = endKey(x, z);
      let list = ends.get(k);
      if (!list) ends.set(k, (list = []));
      list.push({ road, end, x, z });
    }
  }

  const inCore = (x, z) => !!coreRing && ringContains(coreRing, x, z);

  function nearest(x, z, r = 200, filter = null) {
    let best = null, bd = r * r;
    const i0 = Math.floor((x - r) / CELL), i1 = Math.floor((x + r) / CELL);
    const j0 = Math.floor((z - r) / CELL), j1 = Math.floor((z + r) / CELL);
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        const list = cells.get(key(i, j));
        if (!list) continue;
        for (let k = 0; k < list.length; k += 2) {
          const road = list[k], s = list[k + 1];
          if (filter && !filter(road)) continue;
          const P = road.pts;
          const ax = P[s * 2], az = P[s * 2 + 1], bx = P[s * 2 + 2], bz = P[s * 2 + 3];
          const sx = bx - ax, sz = bz - az;
          const L2 = sx * sx + sz * sz;
          if (!L2) continue;
          const t = Math.max(0, Math.min(1, ((x - ax) * sx + (z - az) * sz) / L2));
          const px = ax + sx * t, pz = az + sz * t;
          const d = (px - x) ** 2 + (pz - z) ** 2;
          if (d < bd) {
            bd = d;
            const L = Math.sqrt(L2);
            best = { road, seg: s, t, s: road.cum[s] + L * t, x: px, z: pz, dx: sx / L, dz: sz / L, dist: Math.sqrt(d) };
          }
        }
      }
    }
    return best;
  }

  // The lateral offset (m, to the left of travel) of lane `k` of a road driven one way
  function laneOffset(road, k, keepLeft = true) {
    if (road.oneway) return (k - (road.lanes - 1) / 2) * LANE;
    const perSide = Math.max(1, Math.floor(road.lanes / 2));
    return (Math.min(k, perSide - 1) + 0.5) * LANE * (keepLeft ? 1 : -1);
  }

  // (`expressways`: false keeps walkers and cyclists off the motorways and trunk roads where there's another road)
  function snap(x, z, heading = 0, r = 600, keepLeft = true, { expressways = true } = {}) {
    const street = (road) => road.cls !== 'motorway' && road.cls !== 'trunk';
    const p = (!expressways && nearest(x, z, r, street)) || nearest(x, z, r);
    if (!p || inCore(p.x, p.z)) return null;
    // which way: the road's own one way, else the one nearest the heading asked for
    let dir = p.road.oneway || 1;
    if (!p.road.oneway && p.dx * Math.sin(heading) + p.dz * Math.cos(heading) < 0) dir = -1;
    const dx = p.dx * dir, dz = p.dz * dir;
    // the kerbside lane: left of travel where traffic keeps left (left of (dx, dz) is (dz, -dx))
    const off = laneOffset(p.road, p.road.oneway ? (keepLeft ? p.road.lanes - 1 : 0) : 99, keepLeft);
    return { x: p.x + dz * off, z: p.z - dx * off, heading: Math.atan2(dx, dz), road: p.road, dir };
  }

  // Roads carrying on from the end of `road` driven `dir`, their own direction of travel away from it
  function next(road, dir) {
    const P = road.pts, n = P.length / 2;
    const [ex, ez] = dir > 0 ? [P[n * 2 - 2], P[n * 2 - 1]] : [P[0], P[1]];
    // the direction arriving
    const [ax, az] = dir > 0 ? [P[n * 2 - 4], P[n * 2 - 3]] : [P[2], P[3]];
    const inL = Math.hypot(ex - ax, ez - az) || 1;
    const ix = (ex - ax) / inL, iz = (ez - az) / inL;
    const out = [];
    for (const e of endsNear(ex, ez)) {
      if (e.road === road || Math.hypot(e.x - ex, e.z - ez) > JOIN * 1.5) continue;
      const d = e.end === 0 ? 1 : -1; // leaving from its first point runs along it
      if (e.road.oneway && e.road.oneway !== d) continue;
      const Q = e.road.pts, m = Q.length / 2;
      const [bx, bz] = d > 0 ? [Q[2], Q[3]] : [Q[m * 2 - 4], Q[m * 2 - 3]];
      const oL = Math.hypot(bx - e.x, bz - e.z) || 1;
      const turn = (ix * (bx - e.x) + iz * (bz - e.z)) / oL;
      if (turn < -0.2) continue; // no U-turns onto the other carriageway
      out.push({ road: e.road, dir: d, turn });
    }
    return out;
  }

  // A point and the travel direction at arc length s along a road driven `dir`, offset `off` m to its left
  function pose(road, dir, s, off, out = {}) {
    const P = road.pts, cum = road.cum, n = P.length / 2;
    const u = dir > 0 ? s : road.len - s; // arc length along the points
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (cum[mid] <= u) lo = mid; else hi = mid; }
    const L = cum[hi] - cum[lo] || 1;
    const t = Math.max(0, Math.min(1, (u - cum[lo]) / L));
    let dx = (P[hi * 2] - P[lo * 2]) / L, dz = (P[hi * 2 + 1] - P[lo * 2 + 1]) / L;
    if (dir < 0) { dx = -dx; dz = -dz; }
    out.x = P[lo * 2] + (P[hi * 2] - P[lo * 2]) * t + dz * off;
    out.z = P[lo * 2 + 1] + (P[hi * 2 + 1] - P[lo * 2 + 1]) * t - dx * off;
    out.dx = dx;
    out.dz = dz;
    return out;
  }

  return { roads, data, nearest, snap, next, pose, laneOffset, inCore, LANE };
}

// roads.json, fetched once and shared
let loading = null;
function loadIslandRoads(url, options) {
  if (!loading) {
    loading = fetch(url).then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    }).then((data) => createIslandRoads(data, options));
  }
  return loading;
}

export { createIslandRoads, loadIslandRoads, SPEED };
