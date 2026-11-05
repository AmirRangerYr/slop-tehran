import * as THREE from 'three/webgpu';
import { createTreeField, TREE_SPECIES } from './trees.js';
import { blockAt, CITY } from './city-config.js';
import { createEnforcement } from './open-city-enforcement.js';
import { GEO } from './geodata.js';

// js/open-city-details.js
// The street details of a city built from OpenStreetMap, built by main.js instead of street-details.js's New York
// furniture: the city's own trees (GEO.trees, an inventory such as NParks' for Singapore: tools/city/build.mjs), each
// where it stands on a sidewalk, median, verge or park lawn, grown to its height, its crown shape from its family
// (palms included; a shape without a model in js/trees.js isn't planted), and its road pricing gantries & traffic
// cameras (open-city-enforcement.js). Returns what main.js and the audio take from street-details.js: { group,
// footprints, signalClock, audioSignals, update(camera, player) }, and attach(network, audio) for the enforcement.

const SIDEWALK_Y = 0.22;
const LAWN_Y = 0.3; // = city-grid.js LAWN_TOP (park trees on mapped parks stand on a raised bed)
// The tree models (mature trees, 10-13 m tall at scale 1) scale as a whole, leaf cards and all: below ~60% their crowns
// thin out to bare twigs, so the inventory's young & small trees grow to this height
const MIN_HEIGHT = 7.5;

function insideFlatRing(x, z, ring) {
  let inside = false;
  const n = Math.floor((ring || []).length / 2);
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = ring[i * 2], zi = ring[i * 2 + 1];
    const xj = ring[j * 2], zj = ring[j * 2 + 1];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

// OSM often maps a park boundary but not every tree inside it. Render a restrained, deterministic tree layout only
// inside mapped park polygons; this fills the landscaped ground without inventing any house/building footprints.
function mappedParkTrees() {
  if (GEO.city !== 'tehran') return [];
  const treeSites = [];
  // Footprints of the buildings, in a 40 m grid, so every park (3.5 km² of them) is planted without a scan of all
  // 19,000 buildings per candidate tree
  const CELL = 40;
  const grid = new Map();
  const d = GEO.buildings?.data;
  if (d) {
    let i = 0, fx = 0, fz = 0;
    while (i < d.length) {
      const rings = d[i++]; i += 3;
      let bx0 = Infinity, bz0 = Infinity, bx1 = -Infinity, bz1 = -Infinity;
      for (let r = 0; r < rings; r++) {
        const n = d[i++];
        let px = fx, pz = fz;
        for (let k = 0; k < n; k++) {
          px += d[i++]; pz += d[i++];
          const x = px / 10, z = pz / 10;
          if (!r) { bx0 = Math.min(bx0, x); bx1 = Math.max(bx1, x); bz0 = Math.min(bz0, z); bz1 = Math.max(bz1, z); }
          if (!k) { fx = px; fz = pz; }
        }
      }
      if (!Number.isFinite(bx0)) continue;
      const box = { x0: bx0 - 2.5, x1: bx1 + 2.5, z0: bz0 - 2.5, z1: bz1 + 2.5 };
      for (let cx = Math.floor(box.x0 / CELL); cx <= Math.floor(box.x1 / CELL); cx++) {
        for (let cz = Math.floor(box.z0 / CELL); cz <= Math.floor(box.z1 / CELL); cz++) {
          const key = cx * 100003 + cz;
          if (!grid.has(key)) grid.set(key, []);
          grid.get(key).push(box);
        }
      }
    }
  }
  const underBuilding = (x, z) => (grid.get(Math.floor(x / CELL) * 100003 + Math.floor(z / CELL)) || [])
    .some((b) => x >= b.x0 && x <= b.x1 && z >= b.z0 && z <= b.z1);
  const perimeter = (GEO.airfield?.boundaries || []).map((p) => p.ring);
  // Every mapped green area is planted, denser in woodland and gardens than on open grass, and never the Azadi plaza's
  // paved centre (the monument keeps its own square); a cap keeps the tree field affordable on phones.
  const MAX_TREES = 3500;
  const WOODLAND = new Set(['wood', 'forest', 'orchard']);
  const SPACING = { wood: 11, forest: 11, orchard: 9, garden: 15, park: 17, playground: 24, grass: 28, meadow: 40, grassland: 40, recreation_ground: 26 };
  const keepClear = (GEO.monuments || []).map((m) => ({ x: m.x, z: m.z, r: (m.span || 60) * 1.25 }));
  // First pass: how many trees the natural spacing would plant everywhere; if that is over the cap every park's spacing
  // is widened by the same factor, so the last parks in the list are not left bare while the first are dense
  const flatArea = (r) => { let a = 0; for (let i = 0; i + 3 < r.length; i += 2) a += r[i] * r[i + 3] - r[i + 2] * r[i + 1]; a += r[r.length - 2] * r[1] - r[0] * r[r.length - 1]; return Math.abs(a) / 2; };
  let wanted = 0;
  for (const park of GEO.parks || []) {
    const sp = SPACING[park.kind] || 20;
    for (const poly of park.polygons?.length ? park.polygons : (park.rings || []).map((outer) => ({ outer }))) {
      if (poly.outer && poly.outer.length >= 6) wanted += flatArea(poly.outer) / (sp * sp);
    }
  }
  const widen = wanted > MAX_TREES * 0.9 ? Math.sqrt(wanted / (MAX_TREES * 0.9)) : 1;
  for (let pi = 0; pi < (GEO.parks || []).length && treeSites.length < MAX_TREES; pi++) {
    const park = GEO.parks[pi];
    const spacing = (SPACING[park.kind] || 20) * widen;
    const polygons = park.polygons?.length ? park.polygons : (park.rings || []).map((outer) => ({ outer, holes: [] }));
    for (const polygon of polygons) {
      if (treeSites.length >= MAX_TREES) break;
      const outer = polygon.outer;
      if (!outer || outer.length < 6) continue;
      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
      for (let i = 0; i + 1 < outer.length; i += 2) {
        minX = Math.min(minX, outer[i]); maxX = Math.max(maxX, outer[i]);
        minZ = Math.min(minZ, outer[i + 1]); maxZ = Math.max(maxZ, outer[i + 1]);
      }
      const seed = (x, z) => { const n = Math.sin(x * 12.9898 + z * 78.233 + pi * 37.7) * 43758.5453; return n - Math.floor(n); };
      const x0 = Math.ceil(minX / spacing) * spacing, z0 = Math.ceil(minZ / spacing) * spacing;
      for (let z = z0; z <= maxZ && treeSites.length < MAX_TREES; z += spacing) {
        for (let x = x0; x <= maxX && treeSites.length < MAX_TREES; x += spacing) {
          const jx = x + (seed(x, z) - 0.5) * spacing * 0.7;
          const jz = z + (seed(z, x) - 0.5) * spacing * 0.7;
          if (!insideFlatRing(jx, jz, outer)) continue;
          if ((polygon.holes || []).some((hole) => insideFlatRing(jx, jz, hole))) continue;
          if (keepClear.some((c) => Math.hypot(jx - c.x, jz - c.z) < c.r)) continue;
          if (underBuilding(jx, jz)) continue;
          if (perimeter.some((ring) => insideFlatRing(jx, jz, ring))) continue;
          const pick = seed(jx + 31, jz);
          treeSites.push({ x: jx, y: WOODLAND.has(park.kind) ? 0.34 : 0.3, z: jz, height: 8 + seed(jz, jx) * 5, species: pick < 0.6 ? 0 : pick < 0.88 ? 2 : 1, tier: 0 });
        }
      }
    }
  }
  return treeSites;
}

function buildOpenCityDetails(scene) {
  const group = new THREE.Group();
  group.name = 'CityStreetDetails';
  const sites = [];
  const trees = GEO.trees;
  if (trees) {
    const speciesOf = trees.shapes.map((name) => TREE_SPECIES.findIndex((sp) => sp.name === name));
    let qx = 0;
    let qz = 0;
    for (let i = 0; i < trees.heights.length; i++) {
      qx += trees.xz[i * 2]; // dm, each a step from the tree before
      qz += trees.xz[i * 2 + 1];
      const species = speciesOf[trees.shape[i]];
      if (species < 0) continue;
      const x = qx / 10;
      const z = qz / 10;
      const height = Math.max(MIN_HEIGHT, trees.heights[i]);
      const b = blockAt(x, z);
      const park = !!b && b.park > 0.6;
      // draw distance: park trees and the tall ones furthest
      sites.push({ x, y: b ? (park ? LAWN_Y : SIDEWALK_Y) : 0, z, height, species, tier: park ? 0 : height >= 12 ? 1 : 2 });
    }
  }
  if (GEO.city === 'tehran') sites.push(...mappedParkTrees());
  if (sites.length) group.add(createTreeField(scene, sites).group);
  const enforcement = createEnforcement(group, { keepLeft: CITY.driveSide === 'left' });
  scene.add(group);
  console.info(`[cityDetails] ${sites.length} trees${trees ? ` (${trees.credit})` : ''}`);
  const signalClock = { value: 0 }; // main.js keeps it at the traffic's time
  return {
    group,
    footprints: [],
    signalClock,
    audioSignals: [],
    update: enforcement ? (camera, player) => enforcement.update(signalClock.value, player) : null,
    attach: enforcement ? (network, audio) => enforcement.attach(network, audio) : null
  };
}

export { buildOpenCityDetails };
