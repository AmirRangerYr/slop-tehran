import * as THREE from 'three/webgpu';
import { BODY_SPECS, buildCarGeometry, buildCarProxyGeometry, createLoftedCarMaterial } from './actor-models.js';
import { vehicleContact } from './vehicle-physics.js';

// js/island-traffic.js
// Traffic on the island's main roads beyond the detailed city (js/island-roads.js), where traffic.js's road graph
// doesn't reach: a small pool of cars kept around the camera. Each drives one road at a time in its own lane (keeping
// left), follows the car or player ahead with the IDM, carries on to a connected road at the end of each (straight on
// most likely) and is recycled once far from the camera or into the detailed city, reappearing on a road 180-650 m
// away, preferably out of view. The player bumps into them like any other car; they stop, then pull away.
// Two LODs: the full model within ISL_NEAR m, a ~250-triangle proxy out to ISL_FAR.

const ISL_DRIVER = { a: 1.5, b: 2.6, T: 1.4, s0: 3 };
const ISL_CAR_LEN = 4.6;
const ISL_NEAR = 150;
const ISL_FAR = 900;
const ISL_RECYCLE = 760; // m from the camera
const SPAWN_MIN = 180, SPAWN_MAX = 650;
const KINDS = ['taxi', 'sedan', 'suv'];
const SEDANS = [0x1c2026, 0xcfd6de, 0x1d3b6c, 0x52575e, 0x6e1f24, 0x8a8f96, 0xe9ecef];
const SUVS = [0x16191e, 0xf0f3f7, 0x3a434d, 0x28382e, 0xbec6cf, 0x5b2a2a];

function createIslandTraffic(scene, { vehicles, keepLeft = true, count = 40 } = {}) {
  const group = new THREE.Group();
  group.name = 'IslandTraffic';
  scene.add(group);
  let seed = 7771;
  const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;

  // The pool: a fixed mix of taxis (the city's fleet colours), sedans & SUVs
  const taxiColours = vehicles?.taxis?.length ? vehicles.taxis : [0xffbe14];
  const cars = [];
  for (let i = 0; i < count; i++) {
    const h = rand();
    const kind = h < 0.25 ? 'taxi' : h < 0.68 ? 'sedan' : 'suv';
    const palette = kind === 'taxi' ? taxiColours : kind === 'sedan' ? SEDANS : SUVS;
    const col = new THREE.Color(palette[Math.floor(rand() * palette.length)]);
    cars.push({
      kind, active: false, road: null, dir: 1, s: 0, lane: 0, off: 0, v: 0, acc: 0, stunned: 0, desire: 0.9 + rand() * 0.2,
      x: 0, z: 0, dx: 0, dz: 1, col: [Math.fround(col.r), Math.fround(col.g), Math.fround(col.b)]
    });
  }
  const counts = { taxi: 0, sedan: 0, suv: 0 };
  for (const c of cars) counts[c.kind]++;
  const meshes = {};
  for (const kind of KINDS) {
    const spec = BODY_SPECS[kind];
    const n = Math.max(1, counts[kind]);
    meshes[kind] = [0, 1].map((lod) => {
      const geo = lod ? buildCarProxyGeometry(spec) : buildCarGeometry(spec, true);
      geo.setAttribute('paintColor', new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3));
      geo.setAttribute('carState', new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4));
      const mesh = new THREE.InstancedMesh(geo, createLoftedCarMaterial(spec, null, vehicles || undefined), n);
      // one instance far below the ground until the first update, so the loading screen compiles its pipelines
      mesh.count = 1;
      mesh.instanceMatrix.array.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, -1000, 0, 1]);
      mesh.frustumCulled = false;
      mesh.castShadow = lod === 0;
      mesh.receiveShadow = true;
      mesh.name = `IslandTraffic_${kind}${lod}`;
      group.add(mesh);
      return mesh;
    });
  }

  let roads = null;
  const D = ISL_DRIVER;
  const brakeTerm = 2 * Math.sqrt(D.a * D.b);
  const pose = {};
  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const pos = new THREE.Vector3();
  const ONE = new THREE.Vector3(1, 1, 1);
  const fwd = new THREE.Vector3();
  const contact = {};
  const bodyA = {}, bodyB = {};
  const stats = { active: 0, spawned: 0, recycled: 0 };

  function place(c) {
    roads.pose(c.road, c.dir, c.s, c.off, pose);
    c.x = pose.x; c.z = pose.z; c.dx = pose.dx; c.dz = pose.dz;
  }

  // A car onto a road 180-650 m from the camera, preferably behind it; false if no road was found
  function spawn(c, cam, camFwd) {
    for (let attempt = 0; attempt < 4; attempt++) {
      const behind = attempt < 2;
      const base = Math.atan2(-camFwd.x, -camFwd.z);
      const ang = behind ? base + (rand() - 0.5) * Math.PI : rand() * Math.PI * 2;
      const d = SPAWN_MIN + rand() * (SPAWN_MAX - SPAWN_MIN);
      const p = roads.nearest(cam.x + Math.sin(ang) * d, cam.z + Math.cos(ang) * d, 120);
      if (!p || roads.inCore(p.x, p.z)) continue;
      const road = p.road;
      const dir = road.oneway || (rand() < 0.5 ? 1 : -1);
      const s = dir > 0 ? p.s : road.len - p.s;
      const lanes = road.oneway ? road.lanes : Math.max(1, Math.floor(road.lanes / 2));
      const lane = Math.floor(rand() * lanes);
      const off = roads.laneOffset(road, lane, keepLeft);
      // not on top of another car in that lane
      if (cars.some((o) => o.active && o.road === road && o.dir === dir && Math.abs(o.off - off) < 1 && Math.abs(o.s - s) < 30)) continue;
      Object.assign(c, { active: true, road, dir, s, lane, off, v: road.speed * c.desire * 0.8, acc: 0, stunned: 0 });
      place(c);
      stats.spawned++;
      return true;
    }
    return false;
  }

  // At the end of its road: onto a connected one (straight on most likely), else back to the pool
  function carryOn(c) {
    const options = roads.next(c.road, c.dir);
    if (!options.length) return false;
    let total = 0;
    for (const o of options) total += (o.w = 0.2 + Math.max(0, o.turn) ** 3 * 3);
    let r = rand() * total, pick = options[0];
    for (const o of options) { r -= o.w; if (r <= 0) { pick = o; break; } }
    const overflow = c.s - c.road.len;
    c.road = pick.road;
    c.dir = pick.dir;
    c.s = Math.max(0, overflow);
    const lanes = c.road.oneway ? c.road.lanes : Math.max(1, Math.floor(c.road.lanes / 2));
    c.lane = Math.min(c.lane, lanes - 1);
    c.off = roads.laneOffset(c.road, c.lane, keepLeft);
    return true;
  }

  function update(dt, camera, entity, mode) {
    if (!roads) return;
    for (const kind of KINDS) for (const mesh of meshes[kind]) mesh.count = 0;
    const cam = camera.position;
    camera.getWorldDirection(fwd);

    // 1. Spawn into free slots, a couple a frame
    let spawned = 0;
    for (const c of cars) {
      if (c.active || spawned >= 2) continue;
      if (spawn(c, cam, fwd)) spawned++;
      else break; // (no roads nearby: try again next frame)
    }

    // 2. Following: the nearest car ahead in the same lane of the same road, or the player in it
    const pl = entity && mode !== 'helicopter' ? entity : null;
    const plSpeed = pl ? (pl.speed || 0) : 0;
    for (const c of cars) {
      if (!c.active) continue;
      let gap = Infinity, dv = 0;
      for (const o of cars) {
        if (o === c || !o.active) continue;
        // ahead along this car's direction, close to its line
        const rx = o.x - c.x, rz = o.z - c.z;
        const along = rx * c.dx + rz * c.dz;
        if (along <= 0 || along > 120) continue;
        if (Math.abs(rx * c.dz - rz * c.dx) > 1.7) continue;
        if (o.dx * c.dx + o.dz * c.dz < 0.3) continue; // oncoming
        const g = along - ISL_CAR_LEN;
        if (g < gap) { gap = g; dv = c.v - o.v * (o.dx * c.dx + o.dz * c.dz); }
      }
      if (pl) {
        const rx = pl.position.x - c.x, rz = pl.position.z - c.z;
        const along = rx * c.dx + rz * c.dz;
        if (along > 0 && along < 120 && Math.abs(rx * c.dz - rz * c.dx) < 2.2) {
          const g = along - ISL_CAR_LEN;
          if (g < gap) { gap = g; dv = c.v - Math.max(0, plSpeed * (Math.sin(pl.heading || 0) * c.dx + Math.cos(pl.heading || 0) * c.dz)); }
        }
      }
      const v0 = c.road.speed * c.desire;
      const sStar = D.s0 + Math.max(0, c.v * D.T + (c.v * dv) / brakeTerm);
      c.acc = Math.max(-9, D.a * (1 - (c.v / v0) ** 4 - (gap < Infinity ? (sStar / Math.max(gap, 0.1)) ** 2 : 0)));
      if (c.stunned > 0) { c.stunned -= dt; c.acc = Math.min(c.acc, -6); }
    }

    // 3. Move, carry on, recycle
    for (const c of cars) {
      if (!c.active) continue;
      c.v = Math.max(0, c.v + c.acc * dt);
      c.s += c.v * dt;
      if (c.s >= c.road.len && !carryOn(c)) { c.active = false; stats.recycled++; continue; }
      place(c);
      const d = Math.hypot(c.x - cam.x, c.z - cam.z);
      if (d > ISL_RECYCLE || roads.inCore(c.x, c.z)) { c.active = false; stats.recycled++; }
    }

    // 4. The player bumps into them: pushed out, the car brakes to a stop for a moment
    if (pl && (mode === 'car' || mode === 'cyclist' || mode === 'person')) {
      const half = mode === 'car' ? [0.92, 2.25] : mode === 'cyclist' ? [0.35, 0.9] : [0.3, 0.3];
      for (const c of cars) {
        if (!c.active) continue;
        if (Math.abs(c.x - pl.position.x) > 6 || Math.abs(c.z - pl.position.z) > 6) continue;
        Object.assign(bodyA, { x: pl.position.x, z: pl.position.z, sin: Math.sin(pl.heading || 0), cos: Math.cos(pl.heading || 0), halfW: half[0], halfL: half[1] });
        Object.assign(bodyB, { x: c.x, z: c.z, sin: c.dx, cos: c.dz, halfW: 0.92, halfL: 2.25 });
        if (!vehicleContact(bodyA, bodyB, contact)) continue;
        pl.position.x += contact.nx * contact.depth;
        pl.position.z += contact.nz * contact.depth;
        if (pl.mesh) pl.mesh.position.copy(pl.position);
        // the player's speed into the car is lost
        const into = -((Math.sin(pl.heading || 0) * contact.nx + Math.cos(pl.heading || 0) * contact.nz));
        if (into > 0 && pl.speed) pl.speed *= 0.3;
        c.v *= 0.3;
        c.stunned = 2.5;
      }
    }

    // 5. Instances
    let active = 0;
    for (const c of cars) {
      if (!c.active) continue;
      active++;
      const dx = c.x - cam.x, dz = c.z - cam.z, dy = cam.y;
      const d2 = dx * dx + dz * dz + dy * dy;
      if (d2 > ISL_FAR * ISL_FAR) continue;
      const lod = d2 < ISL_NEAR * ISL_NEAR ? 0 : 1;
      if (lod && dx * fwd.x + dz * fwd.z < -40) continue;
      q.setFromAxisAngle(up, Math.atan2(c.dx, c.dz));
      m4.compose(pos.set(c.x, 0, c.z), q, ONE);
      const mesh = meshes[c.kind][lod];
      const slot = mesh.count++;
      m4.toArray(mesh.instanceMatrix.array, slot * 16);
      const attrs = mesh.geometry.attributes;
      attrs.paintColor.array.set(c.col, slot * 3);
      attrs.carState.array[slot * 4] = c.acc < -1.2 ? 1 : 0;
    }
    stats.active = active;
    for (const kind of KINDS) {
      for (const mesh of meshes[kind]) {
        if (!mesh.count) continue;
        mesh.instanceMatrix.needsUpdate = true;
        mesh.geometry.attributes.paintColor.needsUpdate = true;
        mesh.geometry.attributes.carState.needsUpdate = true;
      }
    }
  }

  return {
    group,
    cars,
    stats,
    update,
    // the island's roads (js/island-roads.js), once loaded
    setRoads(r) { roads = r; }
  };
}

export { createIslandTraffic };
