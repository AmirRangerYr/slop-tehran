// Deterministic street-frontage housing for the gaps in the Tehran OSM map.
//
// The first infill (Phase F) laid a world-axis-aligned lattice of identical boxes over every empty block. It looked
// artificial (a visible brown grid), ignored street direction, and ran out of its candidate budget inside the huge
// airport blocks before it ever reached most neighbourhoods. This generator instead walks the mapped residential
// streets and builds houses along both sides of each one, turned to the street, with varied widths, depths, gaps and
// heights, so the neighbourhoods read as streets of houses and apartment blocks.
//
// Rules (a lot is skipped, never nudged into something invalid):
//   - only dry land; never inside or touching a mapped park, an aerodrome/military ring, a keep-out circle (monuments)
//   - never overlapping a mapped building, another generated house, or any mapped carriageway (road half-width + margin)
//   - the OSM source is never modified; everything is computed at build time and serialised into the geodata
import { bbox, pointInRing, ringArea } from './geom.mjs';

const FRONTAGE_CLASSES = new Set(['residential', 'living_street', 'unclassified', 'tertiary', 'secondary']);
const MIN_STREET_LENGTH = 18;
const ROAD_MARGIN = 2.2; // m of clear ground between a carriageway edge and any house wall
const BUILDING_PAD = 1.2; // m between a house and a mapped building
const HOUSE_GAP_MIN = 0.7; // houses may nearly touch (terraced rows are common in Tehran)
const ROAD_CELL = 64;
const POLY_CELL = 96;
const HOUSE_CELL = 32;
const LEVEL = 3.2;
export const DEFAULT_MAX_HOUSES = 48000;

const pairsOf = (ring) => {
  if (!ring) return [];
  if (ArrayBuffer.isView(ring)) { const out = []; for (let i = 0; i + 1 < ring.length; i += 2) out.push([ring[i], ring[i + 1]]); return out; }
  if (!ring.length) return [];
  if (typeof ring[0] === 'number') { const out = []; for (let i = 0; i + 1 < ring.length; i += 2) out.push([ring[i], ring[i + 1]]); return out; }
  return ring;
};

// A reproducible 0..1 value from a few integers (no Math.random anywhere: two builds give the same city)
const rnd = (a, b = 0, c = 0) => {
  const v = Math.sin(a * 12.9898 + b * 78.233 + c * 37.719 + 47.13) * 43758.5453;
  return v - Math.floor(v);
};

// --- convex quad helpers ------------------------------------------------------------------------------------------
// u = (ux, uz): along the street; n = (-uz, ux): across it
function makeQuad(cx, cz, ux, uz, hw, hd) {
  const nx = -uz, nz = ux;
  return [
    [cx - ux * hw - nx * hd, cz - uz * hw - nz * hd],
    [cx + ux * hw - nx * hd, cz + uz * hw - nz * hd],
    [cx + ux * hw + nx * hd, cz + uz * hw + nz * hd],
    [cx - ux * hw + nx * hd, cz - uz * hw + nz * hd]
  ];
}

function quadBounds(q) {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const [x, z] of q) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (z < z0) z0 = z; if (z > z1) z1 = z; }
  return { x0, x1, z0, z1 };
}

function pointInQuad(x, z, q) {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i], b = q[(i + 1) % 4];
    const cross = (b[0] - a[0]) * (z - a[1]) - (b[1] - a[1]) * (x - a[0]);
    if (Math.abs(cross) < 1e-9) continue;
    const s = cross > 0 ? 1 : -1;
    if (sign && s !== sign) return false;
    sign = s;
  }
  return true;
}

const orient = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
function segmentsCross(a, b, c, d) {
  const o1 = orient(a, b, c), o2 = orient(a, b, d), o3 = orient(c, d, a), o4 = orient(c, d, b);
  return ((o1 > 0 && o2 < 0) || (o1 < 0 && o2 > 0)) && ((o3 > 0 && o4 < 0) || (o3 < 0 && o4 > 0));
}

function pointSegmentDistance(px, pz, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az;
  const l2 = dx * dx + dz * dz;
  const t = l2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / l2)) : 0;
  return Math.hypot(px - ax - t * dx, pz - az - t * dz);
}

// Separating-axis overlap of two convex quads (touching edges do not overlap)
function quadsOverlap(p, q) {
  for (const poly of [p, q]) {
    for (let i = 0; i < 4; i++) {
      const a = poly[i], b = poly[(i + 1) % 4];
      const ax = -(b[1] - a[1]), az = b[0] - a[0];
      let p0 = Infinity, p1 = -Infinity, q0 = Infinity, q1 = -Infinity;
      for (const [x, z] of p) { const d = x * ax + z * az; if (d < p0) p0 = d; if (d > p1) p1 = d; }
      for (const [x, z] of q) { const d = x * ax + z * az; if (d < q0) q0 = d; if (d > q1) q1 = d; }
      if (p1 <= q0 || q1 <= p0) return false;
    }
  }
  return true;
}

// A convex quad against a polygon ring: true if they overlap or touch
function quadTouchesRing(quad, qb, entry) {
  const { ring, bounds } = entry;
  if (ring.length < 3 || qb.x0 > bounds.x1 || qb.x1 < bounds.x0 || qb.z0 > bounds.z1 || qb.z1 < bounds.z0) return false;
  const cx = (quad[0][0] + quad[2][0]) / 2, cz = (quad[0][1] + quad[2][1]) / 2;
  if (pointInRing(cx, cz, ring)) return true;
  for (const [x, z] of quad) if (pointInRing(x, z, ring)) return true;
  for (const [x, z] of ring) if (x >= qb.x0 && x <= qb.x1 && z >= qb.z0 && z <= qb.z1 && pointInQuad(x, z, quad)) return true;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    for (let j = 0; j < 4; j++) if (segmentsCross(a, b, quad[j], quad[(j + 1) % 4])) return true;
  }
  return false;
}

// --- spatial indexes ------------------------------------------------------------------------------------------------
function polygonIndex(rings) {
  const cells = new Map();
  let size = 0;
  for (const raw of rings) {
    const ring = pairsOf(raw);
    if (ring.length < 3) continue;
    const entry = { ring, bounds: bbox(ring) };
    size++;
    const b = entry.bounds;
    for (let ix = Math.floor(b.x0 / POLY_CELL); ix <= Math.floor(b.x1 / POLY_CELL); ix++) {
      for (let iz = Math.floor(b.z0 / POLY_CELL); iz <= Math.floor(b.z1 / POLY_CELL); iz++) {
        const k = `${ix},${iz}`;
        if (!cells.has(k)) cells.set(k, []);
        cells.get(k).push(entry);
      }
    }
  }
  return {
    size,
    touches(quad) {
      const qb = quadBounds(quad);
      const seen = new Set();
      for (let ix = Math.floor(qb.x0 / POLY_CELL); ix <= Math.floor(qb.x1 / POLY_CELL); ix++) {
        for (let iz = Math.floor(qb.z0 / POLY_CELL); iz <= Math.floor(qb.z1 / POLY_CELL); iz++) {
          for (const entry of cells.get(`${ix},${iz}`) || []) {
            if (seen.has(entry)) continue;
            seen.add(entry);
            if (quadTouchesRing(quad, qb, entry)) return true;
          }
        }
      }
      return false;
    }
  };
}

function roadIndex(segments) {
  const cells = new Map();
  for (const s of segments || []) {
    const reach = (Number(s.r) || 0) + 34;
    const x0 = Math.min(s.x0, s.x1) - reach, x1 = Math.max(s.x0, s.x1) + reach;
    const z0 = Math.min(s.z0, s.z1) - reach, z1 = Math.max(s.z0, s.z1) + reach;
    for (let ix = Math.floor(x0 / ROAD_CELL); ix <= Math.floor(x1 / ROAD_CELL); ix++) {
      for (let iz = Math.floor(z0 / ROAD_CELL); iz <= Math.floor(z1 / ROAD_CELL); iz++) {
        const k = `${ix},${iz}`;
        if (!cells.has(k)) cells.set(k, []);
        cells.get(k).push(s);
      }
    }
  }
  return {
    // true when the quad keeps `margin` m clear of every carriageway (each segment's own half-width included)
    isClear(quad, cx, cz, margin) {
      for (const s of cells.get(`${Math.floor(cx / ROAD_CELL)},${Math.floor(cz / ROAD_CELL)}`) || []) {
        const need = (Number(s.r) || 0) + margin;
        const a = [s.x0, s.z0], b = [s.x1, s.z1];
        if (pointInQuad(s.x0, s.z0, quad) || pointInQuad(s.x1, s.z1, quad)) return false;
        let d = Infinity;
        for (let i = 0; i < 4; i++) {
          const c = quad[i], e = quad[(i + 1) % 4];
          if (segmentsCross(a, b, c, e)) return false;
          d = Math.min(d, pointSegmentDistance(c[0], c[1], s.x0, s.z0, s.x1, s.z1),
            pointSegmentDistance(s.x0, s.z0, c[0], c[1], e[0], e[1]), pointSegmentDistance(s.x1, s.z1, c[0], c[1], e[0], e[1]));
        }
        if (d < need) return false;
      }
      return true;
    }
  };
}

function houseIndex() {
  const cells = new Map();
  const cell = (v) => Math.floor(v / HOUSE_CELL);
  return {
    insert(quad) {
      const b = quadBounds(quad);
      const entry = { quad, b };
      for (let ix = cell(b.x0); ix <= cell(b.x1); ix++) {
        for (let iz = cell(b.z0); iz <= cell(b.z1); iz++) {
          const k = `${ix},${iz}`;
          if (!cells.has(k)) cells.set(k, []);
          cells.get(k).push(entry);
        }
      }
    },
    overlaps(quad) {
      const b = quadBounds(quad);
      const seen = new Set();
      for (let ix = cell(b.x0); ix <= cell(b.x1); ix++) {
        for (let iz = cell(b.z0); iz <= cell(b.z1); iz++) {
          for (const e of cells.get(`${ix},${iz}`) || []) {
            if (seen.has(e)) continue;
            seen.add(e);
            if (e.b.x0 > b.x1 || e.b.x1 < b.x0 || e.b.z0 > b.z1 || e.b.z1 < b.z0) continue;
            if (quadsOverlap(quad, e.quad)) return true;
          }
        }
      }
      return false;
    }
  };
}

// --- one street as a walkable polyline -------------------------------------------------------------------------------
function polyline(pts) {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const length = cum[cum.length - 1];
  const at = (s) => {
    const t = Math.max(0, Math.min(length, s));
    let lo = 0, hi = cum.length - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (cum[mid] <= t) lo = mid; else hi = mid; }
    const span = cum[hi] - cum[lo] || 1;
    const f = (t - cum[lo]) / span;
    return [pts[lo][0] + (pts[hi][0] - pts[lo][0]) * f, pts[lo][1] + (pts[hi][1] - pts[lo][1]) * f];
  };
  return { length, at };
}

// What a neighbourhood builds: chance of a taller apartment block, of a lot left empty, and the house height range (m)
const STYLE = {
  housing: { apartments: 0.55, skip: 0.45, houseTop: [6.0, 7.6] }, // Ekbatan-like: mapped towers dominate; few villas
  midrise: { apartments: 0.34, skip: 0.1, houseTop: [6.4, 9.8] },
  lowrise: { apartments: 0.1, skip: 0.1, houseTop: [5.6, 7.8] },
  generic: { apartments: 0.16, skip: 0.1, houseTop: [5.8, 8.2] }
};

/**
 * Houses along the mapped residential streets.
 *  streets            [{ pts: [[x, z], ...], w (carriageway width), cls }] at-grade street pieces
 *  roadSegments       [{ x0, z0, x1, z1, r }] every at-grade carriageway that must stay clear (r: half-width)
 *  parks              [{ polygons: [{ outer }] }] or [{ rings }]: mapped green areas (never built on)
 *  excludedRings      aerodrome / military rings
 *  keepOut            [{ x, z, r }] circles (monument plazas)
 *  existingBuildings  [{ outer }] mapped ground-level footprints
 *  districts          [{ x, z, r, style }] (the style picks the mix of houses & apartments; the named neighbourhoods
 *                     build first, so a cap on the total never starves them)
 *  isLandPoint        (x, z) => boolean
 * Returns { houses: [build.mjs building records], stats }.
 */
export function generateVacantHouseInfill({
  streets = [], roadSegments = [], parks = [], excludedRings = [], keepOut = [], existingBuildings = [], districts = [],
  isLandPoint = () => true, maxHouses = DEFAULT_MAX_HOUSES
} = {}) {
  const parkRings = [];
  for (const park of parks) {
    if (Array.isArray(park.polygons) && park.polygons.length) { for (const poly of park.polygons) if (poly.outer) parkRings.push(poly.outer); }
    else for (const r of park.rings || []) parkRings.push(r);
  }
  // keep-out circles become 24-gons so every restriction goes through the same polygon test
  for (const c of keepOut) {
    parkRings.push(Array.from({ length: 24 }, (_, i) => [c.x + Math.cos((i / 24) * Math.PI * 2) * c.r, c.z + Math.sin((i / 24) * Math.PI * 2) * c.r]));
  }
  const noBuild = polygonIndex([...parkRings, ...excludedRings]);
  const mapped = polygonIndex(existingBuildings.map((b) => b.outer || b.rings?.[0]));
  const roads = roadIndex(roadSegments);
  const placed = houseIndex();

  const styleAt = (x, z) => {
    let best = null, bd = Infinity;
    for (const d of districts) { const dist = Math.hypot(x - d.x, z - d.z); if (dist < d.r && dist < bd) { bd = dist; best = d; } }
    return best ? best.style : 'generic';
  };
  const districtDistance = (pts) => {
    const [x, z] = pts[Math.floor(pts.length / 2)];
    let best = Infinity;
    for (const d of districts) best = Math.min(best, Math.max(0, Math.hypot(x - d.x, z - d.z) - d.r));
    return best;
  };

  const candidates = streets
    .map((s, index) => ({ ...s, index, pts: s.pts || [] }))
    .filter((s) => FRONTAGE_CLASSES.has(s.cls) && s.pts.length >= 2)
    .map((s) => ({ ...s, line: polyline(s.pts) }))
    .filter((s) => s.line.length >= MIN_STREET_LENGTH);
  const priority = new Map(candidates.map((s) => [s.index, districtDistance(s.pts)]));
  candidates.sort((a, b) => priority.get(a.index) - priority.get(b.index) || a.index - b.index);

  const houses = [];
  const stats = { streets: candidates.length, lots: 0, placed: 0, apartments: 0, rejected: { land: 0, restricted: 0, road: 0, building: 0, overlap: 0 }, maxReached: false };

  outer:
  for (const street of candidates) {
    for (const side of [-1, 1]) {
      let s = 2 + rnd(street.index, side, 1) * 5;
      let lot = 0;
      while (s < street.line.length - 2) {
        if (houses.length >= maxHouses) { stats.maxReached = true; break outer; }
        lot++;
        const r1 = rnd(street.index, side * 31 + lot, 2), r2 = rnd(street.index, side * 17 + lot, 3), r3 = rnd(street.index, side * 7 + lot, 4);
        const r4 = rnd(street.index, side * 13 + lot, 5), r5 = rnd(street.index, side * 3 + lot, 6);
        const baseWidth = 8 + r1 * 5.5;
        const baseDepth = 9.5 + r2 * 5;
        const probeC = street.line.at(s + baseWidth / 2);
        const style = styleAt(probeC[0], probeC[1]);
        const mix = STYLE[style] || STYLE.generic;
        const apartments = r5 < mix.apartments;
        // an apartment block is wider, deeper and taller than a house
        const w = apartments ? Math.min(20, baseWidth * 1.5 + 2) : baseWidth;
        const d = apartments ? Math.min(17, baseDepth + 3) : baseDepth;
        const sc = s + w / 2;
        if (sc > street.line.length - 1) break;
        // the street's direction over the lot, then the lot's centre in front of the carriageway
        const a = street.line.at(sc - w / 2), b = street.line.at(sc + w / 2), c = street.line.at(sc);
        const tl = Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (tl < 1e-6) { s += 3; continue; }
        const ux = (b[0] - a[0]) / tl, uz = (b[1] - a[1]) / tl;
        const setback = (street.w || 6) / 2 + 5.2 + r3 * 3.4;
        const lateral = side * (setback + d / 2);
        const centre = [c[0] - uz * lateral, c[1] + ux * lateral];
        stats.lots++;

        if (r4 < mix.skip) { s += w * 0.6 + 1; continue; } // an empty plot, a yard, a gap between houses

        const quad = makeQuad(centre[0], centre[1], ux, uz, w / 2, d / 2);
        const probes = [centre, ...quad, ...quad.map((p, i) => [(p[0] + quad[(i + 1) % 4][0]) / 2, (p[1] + quad[(i + 1) % 4][1]) / 2])];
        const next = () => { s += Math.min(w, 11) * 0.45 + 1.6; };

        if (!probes.every(([x, z]) => isLandPoint(x, z))) { stats.rejected.land++; next(); continue; }
        if (noBuild.touches(makeQuad(centre[0], centre[1], ux, uz, w / 2 + 2.2, d / 2 + 2.2))) { stats.rejected.restricted++; next(); continue; }
        if (!roads.isClear(quad, centre[0], centre[1], ROAD_MARGIN)) { stats.rejected.road++; next(); continue; }
        if (mapped.touches(makeQuad(centre[0], centre[1], ux, uz, w / 2 + BUILDING_PAD, d / 2 + BUILDING_PAD))) { stats.rejected.building++; next(); continue; }
        if (placed.overlaps(makeQuad(centre[0], centre[1], ux, uz, w / 2 + HOUSE_GAP_MIN / 2, d / 2 + HOUSE_GAP_MIN / 2))) { stats.rejected.overlap++; next(); continue; }

        placed.insert(quad);
        const outerRing = quad.map((p) => [p[0], p[1]]);
        if (ringArea(outerRing) > 0) outerRing.reverse();
        let top;
        let type = 'house';
        if (apartments) {
          type = 'apartments';
          top = (4 + Math.floor(rnd(centre[0], centre[1], 8) * 3)) * LEVEL; // 4-6 storeys
          stats.apartments++;
        } else {
          const [lo, hi] = mix.houseTop;
          top = lo + rnd(centre[0], centre[1], 9) * (hi - lo);
        }
        houses.push({ part: false, type, outer: outerRing, holes: [], cx: centre[0], cz: centre[1], top: Math.round(top * 10) / 10, bottom: 0, area: w * d, generatedInfill: true });
        stats.placed++;
        s += w + (r1 < 0.5 ? HOUSE_GAP_MIN + 0.1 : 2.2 + r2 * 3);
      }
    }
  }
  return { houses, stats };
}
