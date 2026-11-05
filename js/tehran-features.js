import * as THREE from 'three/webgpu';
import { GEO } from './geodata.js';

const pointRing = (flat) => {
  const out = [];
  for (let i = 0; i + 1 < (flat || []).length; i += 2) out.push({ x: flat[i], z: flat[i + 1] });
  return out;
};

function insideRing(x, z, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a.z > z) !== (b.z > z) && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) inside = !inside;
  }
  return inside;
}

function polygonMesh(ring, y, material) {
  const pts = pointRing(ring);
  if (pts.length < 3) return null;
  const shape = new THREE.Shape();
  pts.forEach((p, i) => i ? shape.lineTo(p.x, -p.z) : shape.moveTo(p.x, -p.z));
  shape.closePath();
  const geo = new THREE.ShapeGeometry(shape, 1);
  geo.rotateX(-Math.PI / 2);
  geo.translate(0, y, 0);
  const mesh = new THREE.Mesh(geo, material);
  mesh.receiveShadow = true;
  return mesh;
}

// The block slabs top out at y = 0.22, lawns at 0.30 and woodland at 0.34 (city-grid.js). The airfield's paved surfaces go
// above all of them (before, they were buried under the slab and never showed). Layers are centimetres apart on purpose:
// closer ones z-fight on a 24-bit depth buffer.
const AIRFIELD_Y = 0.4;

function buildAirfield(scene) {
  const data = GEO.airfield;
  if (!data) return { runwayCount: 0, fenceCount: 0 };
  const group = new THREE.Group();
  group.name = 'TehranAirfieldFeatures';
  const runwayMat = new THREE.MeshStandardNodeMaterial({ color: 0x373a3b, roughness: 0.96, metalness: 0.02 });
  const taxiMat = new THREE.MeshStandardNodeMaterial({ color: 0x50504a, roughness: 0.96, metalness: 0.01 });
  const apronMat = new THREE.MeshStandardNodeMaterial({ color: 0x77766e, roughness: 0.94, metalness: 0.01 });
  const markMat = new THREE.MeshBasicNodeMaterial({ color: 0xdedbd0 });
  const fenceMat = new THREE.LineBasicMaterial({ color: 0x282b2c, transparent: true, opacity: 0.95 });

  // Large mapped paved areas (aprons and the few polygonal taxiways) go below the runway centreline features.
  for (const a of data.areas || []) {
    const mat = a.kind === 'apron' ? apronMat : taxiMat;
    const mesh = polygonMesh(a.ring, a.kind === 'apron' ? AIRFIELD_Y : AIRFIELD_Y + 0.02, mat);
    if (mesh) { mesh.name = `TehranAirfield_${a.kind}`; group.add(mesh); }
  }

  // OSM runways are often split into several ways. Render every mapped segment at its real tagged width; no airport
  // buildings are generated here. The static bands are separate from the road graph and cannot spawn civilian traffic.
  let runwayCount = 0;
  const runwayMarkings = [];
  for (const line of data.lines || []) {
    const values = line.line || [];
    const n = Math.floor(values.length / 2);
    if (n < 2) continue;
    const isRunway = line.kind === 'runway' || line.kind === 'stopway';
    const width = Math.max(6, Math.min(80, Number(line.width) || (isRunway ? 45 : 12)));
    const material = isRunway ? runwayMat : taxiMat;
    const meshGroup = new THREE.Group();
    meshGroup.name = `Tehran_${line.kind}_${line.name || runwayCount}`;
    for (let i = 0; i + 1 < n; i++) {
      const ax = values[i * 2], az = values[i * 2 + 1];
      const bx = values[(i + 1) * 2], bz = values[(i + 1) * 2 + 1];
      const dx = bx - ax, dz = bz - az;
      const len = Math.hypot(dx, dz);
      if (len < 2) continue;
      const geo = new THREE.BoxGeometry(len + 0.8, 0.08, width);
      geo.rotateY(-Math.atan2(dz, dx));
      geo.translate((ax + bx) / 2, AIRFIELD_Y + (isRunway ? 0.05 : 0.03), (az + bz) / 2);
      const segment = new THREE.Mesh(geo, material);
      segment.receiveShadow = true;
      meshGroup.add(segment);
      if (isRunway && len > 26) {
        // A simple broken centreline keeps the runways legible at ground level without adding aircraft or buildings.
        const ux = dx / len, uz = dz / len;
        for (let d = 14; d < len - 8; d += 34) {
          const x = ax + ux * d, z = az + uz * d;
          const dash = new THREE.Mesh(new THREE.BoxGeometry(12, 0.035, 0.55), markMat);
          dash.rotateY(-Math.atan2(dz, dx));
          dash.position.set(x, AIRFIELD_Y + 0.12, z);
          runwayMarkings.push(dash);
        }
      }
    }
    if (meshGroup.children.length) {
      group.add(meshGroup);
      if (isRunway) runwayCount++;
    }
  }
  group.add(...runwayMarkings);

  // The airport and mapped military airfield perimeters use continuous raised fence lines instead of an invisible
  // boundary. This is a single lightweight line geometry, not thousands of scene objects.
  const fenceVertices = [];
  let fenceCount = 0;
  const addFence = (flat, closeLoop = true) => {
    const pts = pointRing(flat);
    if (pts.length < 2) return;
    fenceCount++;
    const total = pts.length;
    const segments = closeLoop ? total : total - 1;
    for (let i = 0; i < segments; i++) {
      const a = pts[i], b = pts[(i + 1) % total];
      const len = Math.hypot(b.x - a.x, b.z - a.z);
      const steps = Math.max(1, Math.ceil(len / 5));
      for (let j = 0; j < steps; j++) {
        const t0 = j / steps, t1 = (j + 1) / steps;
        const x0 = a.x + (b.x - a.x) * t0, z0 = a.z + (b.z - a.z) * t0;
        const x1 = a.x + (b.x - a.x) * t1, z1 = a.z + (b.z - a.z) * t1;
        // 3 visible horizontal wires, plus short vertical posts every ~5 m.
        for (const y of [0.45, 1.2, 2.0]) fenceVertices.push(x0, y, z0, x1, y, z1);
        fenceVertices.push(x0, 0, z0, x0, 2.2, z0);
      }
    }
  };
  for (const b of data.boundaries || []) addFence(b.ring);
  for (const f of data.fences || []) {
    const line = f.line || [];
    const isClosed = line.length >= 4 && line[0] === line[line.length - 2] && line[1] === line[line.length - 1];
    addFence(line, isClosed);
  }
  if (fenceVertices.length) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(fenceVertices, 3));
    const lines = new THREE.LineSegments(geo, fenceMat);
    lines.name = 'TehranAirportAndMilitaryFences';
    group.add(lines);
  }

  // A visible concrete perimeter wall follows the same mapped airport/military boundary rings. Faces are merged into
  // one non-indexed geometry so the long perimeter does not create a separate scene object for every wall segment.
  const wallPositions = [];
  let wallSegments = 0;
  const wallMaterial = new THREE.MeshStandardNodeMaterial({ color: 0xbab6ab, roughness: 0.94, metalness: 0.0 });
  const tri = (a, b, c) => wallPositions.push(...a, ...b, ...c);
  const quad = (a, b, c, d) => { tri(a, b, c); tri(a, c, d); };
  for (const boundary of data.boundaries || []) {
    const pts = pointRing(boundary.ring);
    if (pts.length < 3) continue;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      const dx = b.x - a.x, dz = b.z - a.z, length = Math.hypot(dx, dz);
      if (length < 2) continue;
      const half = 0.16;
      const nx = (-dz / length) * half, nz = (dx / length) * half;
      const a0 = [a.x + nx, 0.0, a.z + nz], b0 = [b.x + nx, 0.0, b.z + nz];
      const a1 = [a.x - nx, 0.0, a.z - nz], b1 = [b.x - nx, 0.0, b.z - nz];
      const a2 = [a.x + nx, 2.65, a.z + nz], b2 = [b.x + nx, 2.65, b.z + nz];
      const a3 = [a.x - nx, 2.65, a.z - nz], b3 = [b.x - nx, 2.65, b.z - nz];
      quad(a0, b0, b2, a2); // outside face
      quad(b1, a1, a3, b3); // inside face
      quad(a1, a0, a2, a3); // end-facing side A
      quad(b0, b1, b3, b2); // end-facing side B
      quad(a2, b2, b3, a3); // top cap
      quad(a1, b1, b0, a0); // ground cap
      wallSegments++;
    }
  }
  if (wallPositions.length) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(wallPositions, 3));
    geo.computeVertexNormals();
    const wall = new THREE.Mesh(geo, wallMaterial);
    wall.name = 'TehranAirportPerimeterWall';
    wall.castShadow = true;
    wall.receiveShadow = true;
    group.add(wall);
  }

  scene.add(group);
  console.info(`[tehranFeatures] ${runwayCount} runway bands, ${(data.areas || []).length} paved airfield areas, ${fenceCount} fence loops, ${wallSegments} solid wall segments`);
  return { runwayCount, fenceCount, wallSegments, group };
}

// The Azadi Tower (Hossein Amanat, 1971) and its square. The monument stands at the world origin: the frame is centred
// on the centroid of its mapped X-shaped footprint (tools/city/cities/tehran.mjs `monuments`). Its plan is two pointed
// arches crossing at the crown (the mapped footprint's four arms), each 63 m across at the base, under a domed
// crown; the top is 45 m above the plaza. Dimensions are in metres. (The Phase D model was one flat 8 m-deep slab,
// built 490 m from the monument, in the road.)
const BASE_Y = 0.4; // plaza paving: well above the ground slab (0.22), lawns (0.30) and woodland (0.34)

// An arch as a thick pointed-arch band standing in the XY plane, `depth` m deep (z), centred on z = 0
function archBand(span, height, openW, openH, depth, material) {
  const S = span / 2;
  // One closed contour with the passage as a notch in its base (a hole touching the outline would not triangulate)
  const profile = new THREE.Shape();
  profile.moveTo(-S, 0);
  profile.lineTo(-openW, 0);
  profile.bezierCurveTo(-openW * 0.92, openH * 0.5, -openW * 0.32, openH * 0.86, 0, openH);
  profile.bezierCurveTo(openW * 0.32, openH * 0.86, openW * 0.92, openH * 0.5, openW, 0);
  profile.lineTo(S, 0);
  profile.bezierCurveTo(S * 0.86, height * 0.42, S * 0.3, height * 0.84, 0, height);
  profile.bezierCurveTo(-S * 0.3, height * 0.84, -S * 0.86, height * 0.42, -S, 0);
  const geo = new THREE.ExtrudeGeometry(profile, { depth, bevelEnabled: true, bevelSize: 0.35, bevelThickness: 0.35, bevelSegments: 1, curveSegments: 24, steps: 1 });
  geo.translate(0, 0, -depth / 2);
  const mesh = new THREE.Mesh(geo, material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

function obbCollider(cx, cz, hx, hz, ux, uz, minY, maxY) {
  const ex = Math.abs(ux) * hx + Math.abs(uz) * hz;
  const ez = Math.abs(uz) * hx + Math.abs(ux) * hz;
  return { minX: cx - ex, maxX: cx + ex, minZ: cz - ez, maxZ: cz + ez, minY, maxY, obb: { cx, cz, hx, hz, cs: ux, sn: -uz } };
}

function buildAzadiTower(scene, monument) {
  const m = monument || { x: 0, z: 0, axes: [[0.2728, -0.9621], [0.6688, 0.7435]], span: 63, height: 45 };
  const group = new THREE.Group();
  group.name = 'AzadiTower';
  group.position.set(m.x, 0, m.z);
  const stone = new THREE.MeshStandardNodeMaterial({ color: 0xe9e6dc, roughness: 0.62, metalness: 0.02 });
  const stoneWarm = new THREE.MeshStandardNodeMaterial({ color: 0xd9d3c4, roughness: 0.74, metalness: 0.02 });
  const paving = new THREE.MeshStandardNodeMaterial({ color: 0xcfcabd, roughness: 0.82, metalness: 0.0 });
  const water = new THREE.MeshStandardNodeMaterial({ color: 0x2f6c86, roughness: 0.08, metalness: 0.25 });
  const dark = new THREE.MeshStandardNodeMaterial({ color: 0x3c3a36, roughness: 0.9, metalness: 0.05 });

  const span = m.span || 63;
  const archTop = (m.height || 45) - 5; // the domed crown rises the last 5 m
  const [A, B] = m.axes;
  const colliders = [];

  // --- Plaza: a paved disc around the monument, two granite steps up to the platform ---------------------------------
  const plazaR = span * 1.2;
  const disc = new THREE.Mesh(new THREE.CircleGeometry(plazaR, 72), paving);
  disc.rotation.x = -Math.PI / 2;
  disc.position.y = BASE_Y;
  disc.receiveShadow = true;
  group.add(disc);
  const ring = new THREE.Mesh(new THREE.RingGeometry(plazaR - 1.2, plazaR + 0.4, 72), dark);
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = BASE_Y + 0.03;
  group.add(ring);
  const step1 = new THREE.Mesh(new THREE.CylinderGeometry(span * 0.74, span * 0.76, 0.5, 8), stoneWarm);
  step1.position.y = BASE_Y + 0.25;
  const step2 = new THREE.Mesh(new THREE.CylinderGeometry(span * 0.66, span * 0.68, 0.5, 8), stone);
  step2.position.y = BASE_Y + 0.75;
  for (const st of [step1, step2]) { st.castShadow = true; st.receiveShadow = true; st.rotation.y = Math.PI / 8; group.add(st); }
  const deckY = BASE_Y + 1.0;

  // --- The two crossing arches ------------------------------------------------------------------------------------
  const arches = [[A, span, archTop, 10], [B, span * 0.96, archTop * 0.985, 9]];
  for (const [axis, sp, h, depth] of arches) {
    const arch = archBand(sp, h, sp * 0.225, h * 0.7, depth, stone);
    arch.rotation.y = Math.atan2(-axis[1], axis[0]); // local +x (the span) onto the axis
    arch.position.y = deckY;
    group.add(arch);
    // The legs are solid; the passage between them is open. One box per leg (centre ±(S − leg/2)).
    const S = sp / 2, legW = S - sp * 0.225;
    for (const sign of [-1, 1]) {
      const off = sign * (S - legW / 2);
      colliders.push(obbCollider(m.x + axis[0] * off, m.z + axis[1] * off, legW / 2, depth / 2 + 0.4, axis[0], axis[1], 0, h * 0.62));
    }
  }

  // --- Crown: a domed pavilion over the crossing, with a dark slit, and a cornice band ---------------------------
  const crownY = deckY + archTop - 2.2;
  const crown = new THREE.Mesh(new THREE.CylinderGeometry(8.5, 10.5, 4.4, 24), stone);
  crown.position.y = crownY + 2.2;
  crown.castShadow = true;
  group.add(crown);
  const dome = new THREE.Mesh(new THREE.SphereGeometry(8.5, 28, 12, 0, Math.PI * 2, 0, Math.PI / 2), stone);
  dome.scale.set(1, 0.62, 1);
  dome.position.y = crownY + 4.4;
  dome.castShadow = true;
  group.add(dome);
  const cornice = new THREE.Mesh(new THREE.CylinderGeometry(10.9, 10.9, 0.5, 24), stoneWarm);
  cornice.position.y = crownY + 0.25;
  group.add(cornice);
  for (const axis of [A, B]) {
    const slit = new THREE.Mesh(new THREE.BoxGeometry(0.9, 3.2, 17.2), dark);
    slit.position.y = crownY + 2.4;
    slit.rotation.y = Math.atan2(-axis[1], axis[0]);
    group.add(slit);
  }

  // --- Four reflecting pools on the diagonals between the arches, with granite copings ---------------------------------
  const sumX = A[0] + B[0], sumZ = A[1] + B[1], difX = A[0] - B[0], difZ = A[1] - B[1];
  const lenS = Math.hypot(sumX, sumZ) || 1, lenD = Math.hypot(difX, difZ) || 1;
  const bisectors = [[sumX / lenS, sumZ / lenS], [difX / lenD, difZ / lenD]];
  for (const [bx, bz] of bisectors) {
    for (const sign of [-1, 1]) {
      const cx = bx * sign * span * 0.98, cz = bz * sign * span * 0.98;
      const yaw = Math.atan2(-bz, bx);
      const coping = new THREE.Mesh(new THREE.BoxGeometry(26, 0.5, 10.4), stoneWarm);
      coping.position.set(cx, BASE_Y + 0.25, cz);
      coping.rotation.y = yaw;
      coping.receiveShadow = true;
      const pool = new THREE.Mesh(new THREE.PlaneGeometry(24, 8.4), water);
      pool.rotation.set(-Math.PI / 2, 0, 0);
      const holder = new THREE.Group();
      holder.position.set(cx, BASE_Y + 0.56, cz);
      holder.rotation.y = yaw;
      holder.add(pool);
      group.add(coping, holder);
    }
  }

  scene.add(group);
  return { group, colliders };
}

function buildTehranFeatures(scene) {
  if (GEO.city !== 'tehran') return null;
  const monument = (GEO.monuments || []).find((m) => m.id === 'azadi-tower');
  const azadi = monument ? buildAzadiTower(scene, monument) : null;
  return { airfield: buildAirfield(scene), azadiTower: azadi?.group || null, colliders: azadi?.colliders || [] };
}

export { buildTehranFeatures, buildAzadiTower };
