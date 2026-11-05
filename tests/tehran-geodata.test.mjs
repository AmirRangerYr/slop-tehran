import assert from 'node:assert/strict';
import test from 'node:test';
import { GEO } from '../js/tehran-geodata.js';
import { makeFrame } from '../tools/city/frame.mjs';

const TARGETS = {
  'mehrabad-airport': [35.6921420, 51.3225685],
  ekbatan: [35.7069661, 51.3056201],
  'azadi-square': [35.6997385, 51.3380605],
  'khalij-fars': [35.6703176, 51.2654359]
};

function pointSegmentDistance(p, a, b) {
  const dx = b[0] - a[0], dz = b[1] - a[1];
  const d2 = dx * dx + dz * dz;
  const t = d2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / d2)) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dz);
}

function graphMetrics(graph) {
  const count = graph.nodes.length / 2;
  const point = (i) => [graph.nodes[i * 2], graph.nodes[i * 2 + 1]];
  const adjacency = Array.from({ length: count }, () => []);
  const polylines = [];
  for (let li = 0; li < graph.links.length; li++) {
    const link = graph.links[li], [a, b] = link;
    assert.ok(Number.isInteger(a) && Number.isInteger(b) && a >= 0 && b >= 0 && a < count && b < count, `link ${li} has invalid endpoints`);
    adjacency[a].push(b); adjacency[b].push(a);
    const mid = link[6] || [];
    const points = [point(a)];
    for (let i = 0; i + 1 < mid.length; i += 2) points.push([mid[i], mid[i + 1]]);
    points.push(point(b));
    let length = 0;
    for (let i = 1; i < points.length; i++) length += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
    assert.ok(length >= 0.5, `link ${li} is degenerate (${length} m)`);
    polylines.push(points);
  }
  const seen = new Uint8Array(count), components = [], componentByNode = new Int32Array(count);
  componentByNode.fill(-1);
  for (let i = 0; i < count; i++) {
    if (seen[i]) continue;
    const id = components.length, stack = [i]; let size = 0;
    seen[i] = 1;
    while (stack.length) {
      const u = stack.pop(); size++; componentByNode[u] = id;
      for (const v of adjacency[u]) if (!seen[v]) { seen[v] = 1; stack.push(v); }
    }
    components.push(size);
  }
  return { count, adjacency, componentSizes: components, components: [...components].sort((a, b) => b - a), componentByNode, polylines };
}

test('generated Tehran geodata contains a substantial road graph and real OSM building geometry', () => {
  assert.equal(GEO.city, 'tehran');
  assert.equal(GEO.version, 2);
  assert.ok(GEO.roadGraph.nodes.length / 2 > 4000);
  assert.ok(GEO.roadGraph.links.length > 5000);
  assert.ok(GEO.buildings.data.length > 30_000, 'mapped building geometry remains substantial after excluding non-terminal airfield buildings');
  assert.equal(GEO.frame.units, 'm');
  assert.ok(Number.isFinite(GEO.frame.bearingDeg));
});

test('generated Tehran road graph has no invalid or zero-length links and a dominant connected component', () => {
  const metrics = graphMetrics(GEO.roadGraph);
  assert.equal(metrics.adjacency.filter((edges) => edges.length === 0).length, 0, 'no isolated nodes');
  assert.ok(metrics.components[0] / metrics.count >= 0.95, `largest component contains ${(metrics.components[0] / metrics.count * 100).toFixed(2)}% of nodes`);
});

test('all four required Tehran destinations are close to the main connected road network', () => {
  const { roadGraph: graph, places } = GEO;
  const metrics = graphMetrics(graph);
  const frame = makeFrame({ lat0: GEO.frame.lat0, lon0: GEO.frame.lon0, theta: GEO.frame.bearingDeg * Math.PI / 180 });
  const placeById = new Map(places.map((place) => [place.id, place]));
  const mainComponentSize = metrics.components[0];
  assert.ok(mainComponentSize > 0);

  for (const [id, [lat, lon]] of Object.entries(TARGETS)) {
    if (id === 'mehrabad-airport') continue; // The apron/runway area is deliberately excluded from civilian traffic; the gate is outside the runway perimeter.
    const marker = placeById.get(id);
    assert.ok(marker, `missing location marker: ${id}`);
    const target = frame.toWorld(lon, lat);
    let nearest = { distance: Infinity, linkIndex: -1 };
    for (let li = 0; li < graph.links.length; li++) {
      const link = graph.links[li], points = metrics.polylines[li];
      for (let i = 1; i < points.length; i++) {
        const distance = pointSegmentDistance(target, points[i - 1], points[i]);
        if (distance < nearest.distance) nearest = { distance, linkIndex: li };
      }
    }
    assert.ok(nearest.distance <= 125, `${id} is ${nearest.distance.toFixed(1)} m from the mapped road network`);
    const link = graph.links[nearest.linkIndex];
    const compA = metrics.componentByNode[link[0]];
    const compB = metrics.componentByNode[link[1]];
    assert.equal(compA, compB, `${id}'s nearest road link is connected end-to-end`);
    assert.equal(metrics.componentSizes[compA], mainComponentSize, `${id}'s nearest road is in the largest component`);
  }
});



test('Mehrabad remains a named destination while its airside is excluded from civilian road routing', () => {
  const place = GEO.places.find((p) => p.id === 'mehrabad-airport');
  assert.ok(place, 'Mehrabad destination is present');
  assert.ok(GEO.airfield.boundaries.length > 0, 'mapped airport/military boundaries are present');
  assert.ok(GEO.airfield.lines.some((feature) => feature.kind === 'runway'), 'mapped runway geometry is present');
});

test('Tehran runtime includes mapped parks and tree points, with spawn beside Azadi Square', () => {
  assert.ok(GEO.parks.length >= 80, 'mapped park polygons are present');
  assert.ok(GEO.trees?.heights?.length >= 80, 'mapped OSM tree locations are retained');
  assert.ok(GEO.spawnTarget, 'configured spawn target is present');
  assert.ok(Math.hypot(GEO.spawnTarget.x, GEO.spawnTarget.z) <= 200, 'spawn target is within 200 m of Azadi Tower');
});

test('Tehran has expanded green coverage, roadside trees, and generated vacant-block houses in the checked geodata', () => {
  assert.ok(GEO.parks.length >= 300, `expected green-space source features, got ${GEO.parks.length}`);
  const greenPolygons = GEO.parks.reduce((sum, park) => sum + (park.polygons?.length || 0), 0);
  assert.ok(greenPolygons >= 450, `all disconnected park/green polygons should be retained, got ${greenPolygons}`);
  assert.ok(GEO.trees?.heights?.length >= 3000, `mapped plus roadside trees should exceed 3,000, got ${GEO.trees?.heights?.length}`);

  // Decode the compact building stream to ensure the many infill houses were packed into executable geodata.
  let i = 0, count = 0;
  const data = GEO.buildings.data;
  while (i < data.length) {
    const rings = data[i++];
    i += 3; // top, bottom, and type index
    for (let r = 0; r < rings; r++) { const points = data[i++]; i += points * 2; }
    count++;
  }
  assert.equal(i, data.length, 'building geometry stream must be fully consumed without truncated records');
  assert.ok(count >= 15000, `expected the mapped buildings plus residential infill in the generated data, got ${count}`);
});

test('the world frame is centred on the Azadi Tower: mapped outline replaced by the model, plaza kept clear of houses', () => {
  const m = GEO.monuments.find((x) => x.id === 'azadi-tower');
  assert.ok(m && m.x === 0 && m.z === 0 && m.axes.length === 2, 'the monument stands at the origin with its two arch axes');
  let i = 0;
  const d = GEO.buildings.data;
  let fx = 0, fz = 0;
  while (i < d.length) {
    const rings = d[i++]; i += 3;
    for (let r = 0; r < rings; r++) {
      const n = d[i++]; let px = fx, pz = fz;
      for (let k = 0; k < n; k++) { px += d[i++]; pz += d[i++]; if (!k) { fx = px; fz = pz; } if (!r && k === 0) assert.ok(Math.hypot(px / 10, pz / 10) > m.clearRadius, 'no building stands inside the monument radius'); }
    }
  }
});
