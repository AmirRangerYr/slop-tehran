import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { createRequire } from 'node:module';
import { createIslandRoads } from '../js/island-roads.js';

const require = createRequire(import.meta.url);
const { loadModule } = require('./helpers/module.cjs');

// roads.json as tools/city/tiles.mjs writes it: [class, name, x0, z0, dx, dz, ...]
function encode(list) {
  const classes = ['motorway', 'trunk', 'primary', 'secondary', 'tertiary'];
  const names = [];
  const roads = list.map(({ cls, name = '', pts }) => {
    if (name && !names.includes(name)) names.push(name);
    const r = [classes.indexOf(cls), name ? names.indexOf(name) : -1];
    let px = 0, pz = 0;
    for (const [x, z] of pts) { r.push(x - px, z - pz); px = x; pz = z; }
    return r;
  });
  return { classes, names, roads, oneway: list.map((r) => r.oneway || 0), lanes: list.map((r) => r.lanes || 2) };
}

// An east-west primary road through the island (two-way, 4 lanes), a one-way road carrying on from its east end, a
// north-south expressway; the detailed city a square around the origin
const ROADS = encode([
  { cls: 'primary', name: 'Test Avenue', pts: [[1000, 0], [1500, 0], [2000, 0]], lanes: 4 },
  { cls: 'secondary', name: 'One Way Street', pts: [[2000, 0], [2400, 0]], oneway: 1, lanes: 2 },
  { cls: 'secondary', name: 'Wrong Way Street', pts: [[2400, 300], [2000, 0]], oneway: 1, lanes: 2 },
  { cls: 'motorway', name: 'Test Expressway', pts: [[3000, -2000], [3000, 2000]], oneway: 1, lanes: 3 }
]);
const CORE = [-500, -500, 500, -500, 500, 500, -500, 500];

test('the island\'s roads: the nearest point, and arrivals in a lane of the nearest road, facing its traffic', () => {
  const roads = createIslandRoads(ROADS, { coreRing: CORE });
  assert.equal(roads.roads.length, 4);
  const p = roads.nearest(1200, 30, 100);
  assert.equal(p.road.name, 'Test Avenue');
  assert.deepEqual([p.x, p.z, Math.round(p.dist)], [1200, 0, 30]);
  assert.equal(roads.nearest(1200, 300, 100), null, 'nothing within 100 m');
  // heading east (h = pi / 2 faces +x): keeping left of the centre line (north of it, -z), in the kerbside lane
  const east = roads.snap(1200, 30, Math.PI / 2, 500, true);
  assert.ok(Math.abs(east.heading - Math.PI / 2) < 1e-9);
  assert.ok(Math.abs(east.z - -1.5 * 3.3) < 1e-6, `two lanes each way: the kerbside one, 1.5 lanes left (${east.z})`);
  // heading west: the other carriageway, south of the centre line
  const west = roads.snap(1200, 30, -Math.PI / 2, 500, true);
  assert.ok(Math.abs(west.heading + Math.PI / 2) < 1e-9 && west.z > 0);
  // the expressway runs one way only (south, +z): heading north still arrives facing south; walkers stay off it
  const exp = roads.snap(2950, 0, Math.PI, 500, true);
  assert.ok(Math.abs(exp.heading) < 1e-9, 'facing south, with the traffic');
  assert.equal(roads.snap(2950, 0, 0, 2000, true, { expressways: false }).road.name, 'One Way Street');
  // in the detailed city: none (its own road graph takes the arrival)
  assert.equal(roads.snap(0, 100, 0, 600, true), null);
});

test('the island\'s roads carry on into the ones that may be driven onwards, never against a one-way', () => {
  const roads = createIslandRoads(ROADS, { coreRing: CORE });
  const avenue = roads.roads[0];
  const east = roads.next(avenue, 1);
  assert.deepEqual(east.map((o) => o.road.name), ['One Way Street'], 'Wrong Way Street only arrives here');
  assert.equal(east[0].dir, 1);
  assert.deepEqual(roads.next(avenue, -1), [], 'a dead end at the west end');
  // a pose along a road driven against its points, offset to the left of travel
  const p = roads.pose(avenue, -1, 250, 2);
  assert.deepEqual([p.x, p.z, p.dx, p.dz + 0], [1750, 2, -1, 0], 'driving west, 2 m to its left is south (+z)');
});

// js/island-traffic.js with three.js & the car models stubbed (the driving runs unchanged)
class V3 { constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; } set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; } copy(v) { return this.set(v.x, v.y, v.z); } }
const THREE = {
  Group: class { constructor() { this.children = []; } add(...c) { this.children.push(...c); } },
  Color: class { constructor(hex) { this.r = ((hex >> 16) & 255) / 255; this.g = ((hex >> 8) & 255) / 255; this.b = (hex & 255) / 255; } },
  InstancedMesh: class { constructor(geometry, material, n) { this.geometry = geometry; this.count = n; this.instanceMatrix = { array: new Float32Array(n * 16) }; } },
  InstancedBufferAttribute: class { constructor(array) { this.array = array; } },
  Matrix4: class { compose() { return this; } toArray() {} },
  Quaternion: class { setFromAxisAngle() { return this; } },
  Vector3: V3
};
const geometry = () => ({ attributes: {}, setAttribute(k, a) { this.attributes[k] = a; } });
const { vehicleContact } = loadModule(fs.readFileSync(new URL('../js/vehicle-physics.js', import.meta.url), 'utf8'), { globals: { Math } });
const { createIslandTraffic } = loadModule(fs.readFileSync(new URL('../js/island-traffic.js', import.meta.url), 'utf8'), {
  imports: {
    'three/webgpu': THREE,
    './actor-models.js': { BODY_SPECS: { taxi: {}, sedan: {}, suv: {} }, buildCarGeometry: geometry, buildCarProxyGeometry: geometry, createLoftedCarMaterial: () => ({}) },
    './vehicle-physics.js': { vehicleContact }
  },
  globals: { Math, Float32Array, Infinity }
});

function camera(x, z) {
  return { position: new V3(x, 40, z), getWorldDirection(v) { return v.set(1, 0, 0); } };
}

test('island traffic: cars appear on the roads around the camera, keep their lane, carry on and keep their distance', () => {
  const roads = createIslandRoads(ROADS, { coreRing: CORE });
  const scene = { add() {} };
  const traffic = createIslandTraffic(scene, { vehicles: { taxis: [0x1f63c3] }, keepLeft: true, count: 12 });
  traffic.setRoads(roads);
  const cam = camera(1600, 0);
  for (let i = 0; i < 30 * 60; i++) traffic.update(1 / 30, cam, null, 'helicopter');
  const active = traffic.cars.filter((c) => c.active);
  assert.ok(active.length >= 6, `cars on the nearby roads (${active.length})`);
  for (const c of active) {
    assert.ok(!roads.inCore(c.x, c.z), 'none in the detailed city');
    assert.ok(Math.hypot(c.x - cam.position.x, c.z - cam.position.z) <= 760 + 30, 'kept around the camera');
    // keeping left: the left of travel is (dz, -dx); a two-way road's cars are on their own side of its centre line
    const p = roads.nearest(c.x, c.z, 20);
    assert.ok(p, 'on a road');
    if (!p.road.oneway) {
      const side = (c.x - p.x) * c.dz - (c.z - p.z) * c.dx;
      assert.ok(side > 1, `left of the centre line (${side.toFixed(2)})`);
    } else {
      assert.ok(c.dx * p.dx + c.dz * p.dz > 0.99, 'with a one-way road\'s traffic');
    }
    assert.ok(c.v <= 16.7 * 1.1 + 0.01, 'within the fastest of these roads\' limits');
  }
  // no two cars in one lane closer than a car length and the standstill gap
  for (const a of active) {
    for (const b of active) {
      if (a === b || a.road !== b.road || a.dir !== b.dir || Math.abs(a.off - b.off) > 1) continue;
      assert.ok(Math.abs(a.s - b.s) > 4.6 + 1.5, `gap ${Math.abs(a.s - b.s).toFixed(1)} m`);
    }
  }
  assert.ok(traffic.stats.recycled > 0, 'cars leave and come back');
});

test('island traffic stops behind the player and gets bumped out of the way', () => {
  const roads = createIslandRoads(ROADS, { coreRing: CORE });
  const traffic = createIslandTraffic({ add() {} }, { keepLeft: true, count: 1 });
  traffic.setRoads(roads);
  const cam = camera(2200, 0);
  traffic.update(1 / 30, cam, null, 'helicopter');
  const c = traffic.cars[0];
  assert.ok(c.active);
  // put the car on One Way Street heading east and a stopped player 40 m ahead of it in its lane
  Object.assign(c, { road: roads.roads[1], dir: 1, s: 100, lane: 0, off: roads.laneOffset(roads.roads[1], 0), v: 12 });
  const ahead = roads.pose(c.road, 1, 140, c.off);
  const player = { position: new V3(ahead.x, 0, ahead.z), heading: Math.PI / 2, speed: 0 };
  for (let i = 0; i < 30 * 20; i++) traffic.update(1 / 30, cam, player, 'car');
  const gap = Math.hypot(player.position.x - c.x, player.position.z - c.z);
  assert.ok(c.v < 0.2 && gap > 4.6 && gap < 4.6 + 6, `stopped behind the player (${gap.toFixed(1)} m, ${c.v.toFixed(2)} m/s)`);
  // the player reverses into it: pushed back out
  player.position.x = c.x + 2;
  player.position.z = c.z;
  traffic.update(1 / 30, cam, player, 'car');
  const hit = {};
  const overlap = vehicleContact({ x: player.position.x, z: player.position.z, sin: 1, cos: 0, halfW: 0.92, halfL: 2.25 },
    { x: c.x, z: c.z, sin: c.dx, cos: c.dz, halfW: 0.92, halfL: 2.25 }, hit);
  assert.ok(!overlap || hit.depth < 1e-6, `no overlap left (${overlap && hit.depth})`);
  assert.ok(c.stunned > 0 && c.v < 0.2, 'the car stops for a moment');
});
