// tools/city/import-osm.mjs — convert a local OSM XML extract into the Overpass-JSON layer schema used by build.mjs.
// No network access or third-party packages are used. The source extract is read-only; outputs go to tools/data/<city>/.
// usage: node tools/city/import-osm.mjs <source.osm> [city=tehran] [--out-dir <path>]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCity, dataDir } from './config.mjs';

const ROAD_CLASSES = new Set([
  'motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'living_street',
  'service', 'pedestrian', 'motorway_link', 'trunk_link', 'primary_link', 'secondary_link', 'tertiary_link'
]);
const PARK_LEISURE = new Set(['park', 'garden', 'nature_reserve', 'common', 'playground', 'golf_course', 'village_green']);
const GREEN_LANDUSE = new Set(['recreation_ground', 'grass', 'meadow', 'forest', 'greenfield', 'orchard']);
const GREEN_NATURAL = new Set(['grassland', 'wood', 'scrub', 'heath']);
const isGreenArea = (t) => PARK_LEISURE.has(t.leisure) || GREEN_LANDUSE.has(t.landuse) || GREEN_NATURAL.has(t.natural);
const WATER_LANDUSE = new Set(['reservoir', 'basin']);
const ENFORCEMENT_TAGS = new Set(['red_light_camera', 'traffic_signals']);

function decodeXml(value = '') {
  return value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (all, code) => {
    const c = code.toLowerCase();
    if (c === 'amp') return '&';
    if (c === 'lt') return '<';
    if (c === 'gt') return '>';
    if (c === 'quot') return '"';
    if (c === 'apos') return "'";
    const point = c.startsWith('#x') ? parseInt(c.slice(2), 16) : parseInt(c.slice(1), 10);
    try { return Number.isFinite(point) ? String.fromCodePoint(point) : all; } catch { return all; }
  });
}

function attrs(source = '') {
  const out = {};
  const re = /([\w:.-]+)="([^"]*)"/g;
  let m;
  while ((m = re.exec(source))) out[m[1]] = decodeXml(m[2]);
  return out;
}

function childTags(body = '') {
  const tags = {};
  const re = /<tag\b([^>]*?)\/?\s*>/g;
  let m;
  while ((m = re.exec(body))) {
    const a = attrs(m[1]);
    if (a.k !== undefined && a.v !== undefined) tags[a.k] = a.v;
  }
  return tags;
}

function scanElements(xml, name, visitor) {
  const re = new RegExp(`<${name}\\b([^>]*?)(?:/\\s*>|>([\\s\\S]*?)<\\/${name}\\s*>)`, 'g');
  let m;
  while ((m = re.exec(xml))) visitor(attrs(m[1]), m[2] || '');
}

function bboxOf(points) {
  if (!points.length) return null;
  let south = Infinity, west = Infinity, north = -Infinity, east = -Infinity;
  for (const p of points) {
    if (!Number.isFinite(p.lat) || !Number.isFinite(p.lon)) continue;
    south = Math.min(south, p.lat); west = Math.min(west, p.lon);
    north = Math.max(north, p.lat); east = Math.max(east, p.lon);
  }
  return south === Infinity ? null : [south, west, north, east];
}

function intersects(a, b) {
  return !!a && a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
}

function tagSetMatches(tags, key, values) {
  return tags[key] !== undefined && values.has(tags[key]);
}

// Parse complete node, way and relation objects. Geometry comes from the source node table; ways with missing
// coordinates are explicitly excluded from layer outputs so node IDs cannot become misaligned with geometry points.
export function parseOsmXml(xml) {
  if (!/<osm\b[^>]*\bversion="0\.6"/.test(xml)) throw new Error('input does not look like an OSM XML 0.6 document');
  const nodes = new Map();
  const waysRaw = [];
  const relationsRaw = [];
  let declaredBounds = null;
  const boundsMatch = /<bounds\b([^>]*)\/?\s*>/.exec(xml);
  if (boundsMatch) {
    const b = attrs(boundsMatch[1]);
    if (['minlat', 'minlon', 'maxlat', 'maxlon'].every((k) => b[k] !== undefined)) {
      declaredBounds = [Number(b.minlat), Number(b.minlon), Number(b.maxlat), Number(b.maxlon)];
    }
  }

  scanElements(xml, 'node', (a, body) => {
    const lat = Number(a.lat), lon = Number(a.lon), id = a.id;
    if (!id || !Number.isFinite(lat) || !Number.isFinite(lon)) return;
    nodes.set(id, { id: Number(id), lat, lon, tags: childTags(body) });
  });

  let missingWayNodeRefs = 0;
  let incompleteWays = 0;
  scanElements(xml, 'way', (a, body) => {
    const id = Number(a.id);
    if (!Number.isFinite(id)) return;
    const refs = [];
    const ndRe = /<nd\b([^>]*?)\/?\s*>/g;
    let nd;
    while ((nd = ndRe.exec(body))) {
      const ref = attrs(nd[1]).ref;
      if (ref !== undefined) refs.push(ref);
    }
    const geometry = [];
    let missing = 0;
    for (const ref of refs) {
      const p = nodes.get(ref);
      if (p) geometry.push({ lat: p.lat, lon: p.lon });
      else { missing++; missingWayNodeRefs++; }
    }
    if (missing) incompleteWays++;
    waysRaw.push({ type: 'way', id, nodes: refs.map(Number), tags: childTags(body), geometry, _incomplete: missing > 0 });
  });

  const wayById = new Map(waysRaw.map((w) => [String(w.id), w]));
  let missingRelationWayMembers = 0;
  scanElements(xml, 'relation', (a, body) => {
    const id = Number(a.id);
    if (!Number.isFinite(id)) return;
    const members = [];
    const memRe = /<member\b([^>]*?)\/?\s*>/g;
    let mm;
    while ((mm = memRe.exec(body))) {
      const m = attrs(mm[1]);
      if (!m.type || m.ref === undefined) continue;
      const member = { type: m.type, ref: Number(m.ref), role: m.role || '' };
      if (m.type === 'way') {
        const w = wayById.get(m.ref);
        if (w && !w._incomplete && w.geometry.length) member.geometry = w.geometry;
        else missingRelationWayMembers++;
      } else if (m.type === 'node') {
        const n = nodes.get(m.ref);
        if (n) { member.lat = n.lat; member.lon = n.lon; }
      }
      members.push(member);
    }
    relationsRaw.push({ type: 'relation', id, tags: childTags(body), members });
  });

  const completeWays = waysRaw.filter((w) => !w._incomplete).map(({ _incomplete, ...w }) => w);
  const wayByIdComplete = new Map(completeWays.map((w) => [String(w.id), w]));
  // Rebind relation geometries using the complete-way map, ensuring relations never reference partially mapped chains.
  for (const r of relationsRaw) {
    for (const m of r.members || []) {
      if (m.type !== 'way') continue;
      const w = wayByIdComplete.get(String(m.ref));
      if (w?.geometry?.length) m.geometry = w.geometry;
      else delete m.geometry;
    }
  }
  return {
    metadata: {
      declaredBounds,
      actualNodeBounds: bboxOf([...nodes.values()]),
      counts: { nodes: nodes.size, ways: waysRaw.length, completeWays: completeWays.length, relations: relationsRaw.length },
      quality: { missingWayNodeRefs, incompleteWays, missingRelationWayMembers }
    },
    nodes,
    ways: completeWays,
    relations: relationsRaw,
    allWays: waysRaw
  };
}

function elementBounds(e) {
  if (e.type === 'way') return bboxOf(e.geometry || []);
  if (e.type === 'relation') {
    const points = [];
    for (const m of e.members || []) {
      if (m.geometry) points.push(...m.geometry);
      else if (Number.isFinite(m.lat) && Number.isFinite(m.lon)) points.push({ lat: m.lat, lon: m.lon });
    }
    return bboxOf(points);
  }
  if (Number.isFinite(e.lat) && Number.isFinite(e.lon)) return [e.lat, e.lon, e.lat, e.lon];
  return null;
}

export function buildLayers(parsed, box) {
  const layerArrays = { roads: [], coast: [], water: [], parks: [], buildings: [], aeroways: [], fences: [], trees: [], enforcement: [] };
  let outsideBox = 0;
  const incompleteAreaRelations = new Map();
  const addIfInside = (layer, e) => {
    if (intersects(elementBounds(e), box)) layerArrays[layer].push(e);
    else outsideBox++;
  };
  for (const w of parsed.ways) {
    const t = w.tags || {};
    if (ROAD_CLASSES.has(t.highway) && t.area !== 'yes') addIfInside('roads', w);
    if (t.natural === 'coastline') addIfInside('coast', w);
    if (t.natural === 'water' || t.waterway === 'riverbank' || WATER_LANDUSE.has(t.landuse)) addIfInside('water', w);
    if (isGreenArea(t)) addIfInside('parks', w);
    if (t.building !== undefined || t['building:part'] !== undefined) addIfInside('buildings', w);
    if (t.aeroway !== undefined) addIfInside('aeroways', w);
    if (t.barrier === 'fence' || t.barrier === 'wall' || t.landuse === 'military' || t.military === 'airfield') addIfInside('fences', w);
    if (t.highway === 'toll_gantry') addIfInside('enforcement', w);
  }
  for (const r of parsed.relations) {
    const t = r.tags || {};
    if (t.natural === 'water' || t.waterway === 'riverbank' || WATER_LANDUSE.has(t.landuse)) addIfInside('water', r);
    if (isGreenArea(t)) addIfInside('parks', r);
    if (t.building !== undefined || t['building:part'] !== undefined) addIfInside('buildings', r);
    const isArea = t.type === 'multipolygon' || t.type === 'boundary' || t.building !== undefined || t['building:part'] !== undefined ||
      t.natural === 'water' || t.waterway === 'riverbank' || WATER_LANDUSE.has(t.landuse) || isGreenArea(t);
    const missing = (r.members || []).filter((m) => m.type === 'way' && !m.geometry);
    if (isArea && missing.length && intersects(elementBounds(r), box)) {
      incompleteAreaRelations.set(r.id, { id: r.id, name: t.name || '', type: t.type || '', tags: t, missingWayMembers: missing.length, missingOuterMembers: missing.filter((m) => m.role === 'outer').length, missingInnerMembers: missing.filter((m) => m.role === 'inner').length });
    }
    if (ENFORCEMENT_TAGS.has(t.enforcement)) addIfInside('enforcement', r);
  }
  for (const n of parsed.nodes.values()) {
    const t = n.tags || {};
    if (t.highway === 'toll_gantry' || t.highway === 'speed_camera') addIfInside('enforcement', { type: 'node', id: n.id, lat: n.lat, lon: n.lon, tags: t });
    if (t.aeroway !== undefined) addIfInside('aeroways', { type: 'node', id: n.id, lat: n.lat, lon: n.lon, tags: t });
    if (t.natural === 'tree') addIfInside('trees', { type: 'node', id: n.id, lat: n.lat, lon: n.lon, tags: t });
  }
  const quality = {
    sourceDeclaredBounds: parsed.metadata.declaredBounds,
    sourceActualNodeBounds: parsed.metadata.actualNodeBounds,
    sourceCounts: parsed.metadata.counts,
    sourceQuality: parsed.metadata.quality,
    importBounds: box,
    layerCounts: Object.fromEntries(Object.entries(layerArrays).map(([k, v]) => [k, v.length])),
    incompleteAreaRelations: [...incompleteAreaRelations.values()],
    incompleteAreaRelationCount: incompleteAreaRelations.size,
    outsideBoxElements: outsideBox,
    note: 'Derived locally from the supplied OSM XML; source file was not modified. OSM data © OpenStreetMap contributors, ODbL 1.0.'
  };
  return { layers: layerArrays, report: quality };
}

export async function importOsmFile(inputPath, cityId = 'tehran', outDir) {
  const city = await loadCity(cityId);
  const sourcePath = path.resolve(inputPath);
  const targetDir = path.resolve(outDir || dataDir(city));
  if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) throw new Error(`OSM input file not found: ${sourcePath}`);
  const xml = fs.readFileSync(sourcePath, 'utf8');
  const parsed = parseOsmXml(xml);
  const [south, west, north, east] = city.detail;
  const m = city.margin || 0;
  const box = [south - m, west - m, north + m, east + m];
  const { layers, report } = buildLayers(parsed, box);
  fs.mkdirSync(targetDir, { recursive: true });
  for (const [name, elements] of Object.entries(layers)) {
    const file = path.join(targetDir, `osm_${name}.json`);
    const payload = { version: 0.6, generator: 'Slop Tehran local OSM XML adapter', elements };
    fs.writeFileSync(file, `${JSON.stringify(payload)}\n`);
  }
  report.sourceFile = path.basename(sourcePath);
  report.sourceSizeBytes = fs.statSync(sourcePath).size;
  report.outputDir = targetDir;
  report.city = city.id;
  fs.writeFileSync(path.join(targetDir, 'import-report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`[osm-import] source: ${sourcePath} (${(report.sourceSizeBytes / 1024 / 1024).toFixed(2)} MiB)`);
  console.log(`[osm-import] source elements: ${report.sourceCounts.nodes} nodes, ${report.sourceCounts.ways} ways (${report.sourceCounts.completeWays} complete), ${report.sourceCounts.relations} relations`);
  console.log(`[osm-import] declared bounds: ${JSON.stringify(report.sourceDeclaredBounds)}; actual node bounds: ${JSON.stringify(report.sourceActualNodeBounds)}`);
  console.log(`[osm-import] import bbox (S,W,N,E): ${JSON.stringify(box)}`);
  console.log(`[osm-import] output: ${targetDir}`);
  for (const [layer, count] of Object.entries(report.layerCounts)) console.log(`[osm-import] ${layer}: ${count} elements`);
  console.log(`[osm-import] quality: ${report.sourceQuality.incompleteWays} ways had missing node refs (${report.sourceQuality.missingWayNodeRefs} refs); ${report.incompleteAreaRelationCount} in-bounds area relations have missing member-way geometry`);
  for (const relation of report.incompleteAreaRelations) console.log(`[osm-import] warning: relation ${relation.id} (${relation.name || relation.type || 'area'}) has ${relation.missingOuterMembers} missing outer and ${relation.missingInnerMembers} missing inner way members`);
  return report;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const args = process.argv.slice(2);
  const input = args.find((a) => !a.startsWith('--'));
  const city = args.filter((a) => !a.startsWith('--'))[1] || 'tehran';
  const oi = args.indexOf('--out-dir');
  const outDir = oi >= 0 ? args[oi + 1] : undefined;
  if (!input) throw new Error('usage: node tools/city/import-osm.mjs <source.osm> [city=tehran] [--out-dir <path>]');
  await importOsmFile(input, city, outDir);
}
