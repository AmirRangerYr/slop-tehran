import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateVacantHouseInfill } from '../tools/city/infill.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const square = (x0, z0, x1, z1) => [[x0,z0],[x1,z0],[x1,z1],[x0,z1]];
const bounds = (ring) => ({x0:Math.min(...ring.map(p=>p[0])),z0:Math.min(...ring.map(p=>p[1])),x1:Math.max(...ring.map(p=>p[0])),z1:Math.max(...ring.map(p=>p[1]))});
const overlaps = (a,b,pad=0) => a.x0 < b.x1 + pad && a.x1 > b.x0 - pad && a.z0 < b.z1 + pad && a.z1 > b.z0 - pad;

const street = (x0, z0, x1, z1, w = 7) => ({ pts: [[x0, z0], [x1, z1]], w, cls: 'residential' });
const segs = (streets) => streets.map((s) => ({ x0: s.pts[0][0], z0: s.pts[0][1], x1: s.pts[1][0], z1: s.pts[1][1], r: s.w / 2 }));
const quadOf = (h) => bounds(h.outer);

test('frontage housing is deterministic, lines the street on both sides and keeps clear of its carriageway', () => {
  const streets = [street(0, 0, 300, 0)];
  const args = { streets, roadSegments: segs(streets), maxHouses: 500 };
  const first = generateVacantHouseInfill(args);
  const second = generateVacantHouseInfill(args);
  assert.ok(first.houses.length > 20, `expected many houses along a 300 m street, got ${first.houses.length}`);
  assert.deepEqual(first.houses.map((h) => h.outer), second.houses.map((h) => h.outer));
  assert.ok(first.houses.some((h) => h.cz > 0) && first.houses.some((h) => h.cz < 0), 'both sides of the street are built');
  for (const h of first.houses) {
    const b = quadOf(h);
    assert.ok(b.z0 > 3.5 + 2 || b.z1 < -3.5 - 2, 'no house touches the carriageway (half-width 3.5 m + margin)');
    assert.ok(h.top >= 5 && h.bottom === 0 && h.generatedInfill);
  }
});

test('houses never overlap each other, mapped buildings, parks, restricted rings or keep-out circles', () => {
  const streets = [street(-200, 0, 200, 0), street(0, -200, 0, 200)];
  const park = square(40, 10, 120, 80);
  const existing = square(-120, -60, -70, -12);
  const restricted = square(-180, 20, -100, 90);
  const { houses, stats } = generateVacantHouseInfill({
    streets, roadSegments: segs(streets), parks: [{ rings: [park] }], excludedRings: [restricted],
    existingBuildings: [{ outer: existing, bottom: 0 }], keepOut: [{ x: 0, z: 0, r: 40 }], maxHouses: 1000
  });
  assert.ok(houses.length > 10);
  assert.ok(stats.rejected.restricted > 0, 'park / restricted / keep-out candidates are rejected');
  for (let i = 0; i < houses.length; i++) {
    const b = quadOf(houses[i]);
    assert.equal(overlaps(b, bounds(park), 0), false, 'house must not overlap a park');
    assert.equal(overlaps(b, bounds(existing), 0.5), false, 'house must not overlap a mapped building');
    assert.equal(overlaps(b, bounds(restricted), 0), false, 'house must not overlap a restricted area');
    assert.ok(Math.hypot(houses[i].cx, houses[i].cz) > 40, 'house must stay out of the keep-out circle');
  }
  // generated houses are turned to their street, so compare footprints exactly rather than bounding boxes: no two share area
  const poly = (h) => h.outer;
  const centreIn = (h, g) => { let inside = false; const r = poly(g); for (let a = 0, c = r.length - 1; a < r.length; c = a++) { if ((r[a][1] > h.cz) !== (r[c][1] > h.cz) && h.cx < ((r[c][0] - r[a][0]) * (h.cz - r[a][1])) / (r[c][1] - r[a][1]) + r[a][0]) inside = !inside; } return inside; };
  for (let i = 0; i < houses.length; i++) for (let j = i + 1; j < houses.length; j++) assert.equal(centreIn(houses[i], houses[j]) || centreIn(houses[j], houses[i]), false, 'houses do not stack');
});

test('houses follow a diagonal street (turned to it) and stay on dry land only', () => {
  const streets = [street(0, 0, 250, 250)];
  const { houses } = generateVacantHouseInfill({ streets, roadSegments: segs(streets), isLandPoint: (x, z) => x - z < 60, maxHouses: 500 });
  assert.ok(houses.length > 10);
  const edge = houses[0].outer;
  const dx = edge[1][0] - edge[0][0], dz = edge[1][1] - edge[0][1];
  const angle = Math.abs((Math.atan2(dz, dx) * 180) / Math.PI) % 90;
  assert.ok(Math.abs(angle - 45) < 1.5, `a house on a 45° street is turned 45°, got ${angle.toFixed(1)}`);
  for (const h of houses) for (const [x, z] of h.outer) assert.ok(x - z < 60, 'no house corner stands in the water');
});

test('only residential-type streets carry houses; the cap and the named neighbourhoods are respected', () => {
  const motorway = { pts: [[0, 0], [300, 0]], w: 20, cls: 'motorway' };
  assert.equal(generateVacantHouseInfill({ streets: [motorway], roadSegments: segs([motorway]) }).houses.length, 0);
  const streets = [street(0, 0, 400, 0), street(0, 500, 400, 500)];
  const near = { x: 200, z: 500, r: 100, style: 'lowrise' };
  const capped = generateVacantHouseInfill({ streets, roadSegments: segs(streets), districts: [near], maxHouses: 8 });
  assert.equal(capped.houses.length, 8);
  assert.ok(capped.stats.maxReached);
  assert.ok(capped.houses.every((h) => h.cz > 400), 'the named neighbourhood is built before other streets');
});

test('touch controls stay physically left/right while their caption remains RTL and right-aligned', () => {
  const css = fs.readFileSync(path.join(root, 'css/style.css'), 'utf8');
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.match(css, /#touch-controls\s*\{[^}]*direction:\s*ltr\s*;/s);
  assert.match(css, /\.touch-movement\s*\{[^}]*direction:\s*rtl[^}]*text-align:\s*right/s);
  assert.match(css, /\.touch-movement\s+\.touch-caption\s*\{[^}]*direction:\s*rtl[^}]*text-align:\s*right/s);
  assert.ok(html.indexOf('<div class="touch-movement">') < html.indexOf('<div class="touch-actions"'), 'movement element remains the leftmost flex child under LTR container direction');
});

test('park renderers consume independent outer polygons and explicit holes, and airport features include a solid wall', () => {
  const grid = fs.readFileSync(path.join(root, 'js/city-grid.js'), 'utf8');
  const details = fs.readFileSync(path.join(root, 'js/open-city-details.js'), 'utf8');
  const features = fs.readFileSync(path.join(root, 'js/tehran-features.js'), 'utf8');
  assert.match(grid, /park\.polygons/);
  assert.match(details, /park\.polygons/);
  assert.doesNotMatch(details, /rings\.slice\(1\)\.some\(\(hole\)/, 'extra outer polygons must not be treated as holes');
  assert.match(features, /TehranAirportPerimeterWall/);
  assert.match(features, /wallSegments/);
});
