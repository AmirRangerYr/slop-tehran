import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

// js/geodata.js picks the city when it loads (from CITY outside a browser), so each run gets its own process
function inCity(city, body) {
  const script = `
    const config = await import('./js/city-config.js');
    const { buildRoadNetwork } = await import('./js/road-network.js');
    const out = await (async () => { ${body} })();
    process.stdout.write(JSON.stringify(out));
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: root, encoding: 'utf8', env: { ...process.env, CITY: city }, timeout: 120000
  });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

test('Tehran is the default city; an unknown ?city falls back to it', () => {
  assert.equal(inCity('', 'return config.CITY.id;'), 'tehran');
  assert.equal(inCity('atlantis', 'return config.CITY.id;'), 'tehran', 'an unknown city falls back to the default');
});

test('Tehran serves the whole city-config.js interface', () => {
  const out = inCity('tehran', `
    const names = Object.keys(config).sort();
    const { SPAWN } = config;
    return {
      missing: names.filter((k) => config[k] === undefined),
      city: (({ vehicles, ...c }) => c)(config.CITY),
      blocks: config.BLOCKS.length,
      roads: config.ROADS.length,
      land: config.LAND_REGIONS.length,
      spawnInBlock: !!config.blockAt(SPAWN.x, SPAWN.z),
      label: config.getLocationLabel(SPAWN.x, SPAWN.z),
      teleports: Object.entries(config.TELEPORT_LOCATIONS).map(([id, t]) => ({ id, inBlock: !!config.blockAt(t.x, t.z), heading: t.heading }))
    };
  `);
  assert.deepEqual(out.missing, []);
  assert.equal(out.city.id, 'tehran');
  assert.equal(out.city.open, true);
  assert.equal(out.city.driveSide, 'right');
  assert.ok(out.blocks > 500 && out.roads > 500 && out.land > 0);
  assert.equal(out.spawnInBlock, false, 'the start is on a street');
  assert.equal(out.teleports.length, 4, 'a teleport to each of the four places');
  for (const t of out.teleports) {
    assert.equal(t.inBlock, false, `${t.id} arrives on a street`);
    assert.ok(Number.isFinite(t.heading));
  }
});

test("every building style a city's neighbourhoods name is one buildings.js builds", async () => {
  const buildings = fs.readFileSync(new URL('../js/buildings.js', import.meta.url), 'utf8');
  const styles = buildings.match(/const OPEN_STYLES = \{([^]*?)\n  \};/)[1];
  for (const file of fs.readdirSync(new URL('../tools/city/cities/', import.meta.url))) {
    const city = (await import(new URL(`../tools/city/cities/${file}`, import.meta.url).href)).default;
    for (const d of city.districts || []) assert.match(styles, new RegExp(`(^|\\s|')${d.style}'?:`), `${city.id}: ${d.name} (${d.style})`);
  }
});

test("Tehran's streets drive as one network", () => {
  // the curbs city-grid.js bounds the roads with in an open city: rectangular blocks, the outlines of irregular ones
  // with lots (medians & traffic islands bound none)
  const out = inCity('tehran', `
    const sidewalks = [];
    for (const b of config.BLOCKS) {
      if (b.median) continue;
      if (b.rect) sidewalks.push({ minX: b.minX, maxX: b.maxX, minZ: b.minZ, maxZ: b.maxZ });
      else if (b.rects.length) sidewalks.push({ minX: b.minX, maxX: b.maxX, minZ: b.minZ, maxZ: b.maxZ, poly: b.poly });
    }
    console.info = () => {};
    const net = buildRoadNetwork(sidewalks, []);
    const uturns = net.edges.reduce((n, e) => n + e.moves.filter((m) => m.uturn).length, 0);
    return { edges: net.edges.length, uturns, signals: net.nodes.filter((n) => n.signal).length };
  `);
  assert.ok(out.edges > 3000, `${out.edges} connected edges`);
  assert.ok(out.uturns > 0, 'dead ends turn round');
});


test('Tehran spawn is beside Azadi and Mehrabad teleports to a public street outside the fenced airside', () => {
  const out = inCity('tehran', `
    const { GEO } = await import('./js/geodata.js');
    const { SPAWN, TELEPORT_LOCATIONS } = config;
    const ptInRing = (x, z, flat) => {
      let inside = false;
      for (let i = 0, j = flat.length / 2 - 1; i < flat.length / 2; j = i++) {
        const xi = flat[i * 2], zi = flat[i * 2 + 1], xj = flat[j * 2], zj = flat[j * 2 + 1];
        if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
      }
      return inside;
    };
    const airport = TELEPORT_LOCATIONS['mehrabad-airport'];
    return { spawn: SPAWN, airport, towerDistance: Math.hypot(SPAWN.x, SPAWN.z), airportInsideAirside: !!airport && GEO.airfield.boundaries.some((b) => ptInRing(airport.x, airport.z, b.ring)) };
  `);
  assert.ok(out.towerDistance < 200, `spawn is ${out.towerDistance.toFixed(1)} m from Azadi Tower`);
  assert.ok(out.airport, 'the airport remains an available teleport destination');
  assert.equal(out.airportInsideAirside, false, 'the airport arrival is on a public street outside the fenced airside');
  assert.ok(Number.isFinite(out.airport.heading));
});

test("no street lies under a block's slab: enclosed roads are holes in the block around them", () => {
  const out = inCity('tehran', `
    const { GEO } = await import('./js/geodata.js');
    const rg = GEO.roadGraph;
    let samples = 0, covered = 0;
    for (const l of rg.links) {
      if (l[8] !== 0) continue; // at grade
      const pts = [[rg.nodes[l[0] * 2], rg.nodes[l[0] * 2 + 1]]];
      for (let k = 0; k < l[6].length; k += 2) pts.push([l[6][k], l[6][k + 1]]);
      pts.push([rg.nodes[l[1] * 2], rg.nodes[l[1] * 2 + 1]]);
      for (let i = 0; i + 1 < pts.length; i++) for (const t of [0.2, 0.5, 0.8]) {
        samples++;
        if (config.blockAt(pts[i][0] + (pts[i + 1][0] - pts[i][0]) * t, pts[i][1] + (pts[i + 1][1] - pts[i][1]) * t)) covered++;
      }
    }
    return { samples, covered, holes: config.BLOCKS.reduce((n, b) => n + b.holes.length, 0) };
  `);
  assert.ok(out.samples > 20000);
  assert.ok(out.holes > 0, 'the large blocks have holes');
  assert.equal(out.covered, 0, `${out.covered} street points lie inside a block (its slab would hide them)`);
});
