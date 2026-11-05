import assert from 'node:assert/strict';
import test from 'node:test';
import { buildLayers, parseOsmXml } from '../tools/city/import-osm.mjs';

const FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<osm version="0.6" generator="test">
  <bounds minlat="35.65" minlon="51.23" maxlat="35.72" maxlon="51.35"/>
  <node id="1" lat="35.7000" lon="51.3300"/>
  <node id="2" lat="35.7000" lon="51.3310"/>
  <node id="3" lat="35.7010" lon="51.3310"/>
  <node id="4" lat="35.7010" lon="51.3300"/>
  <node id="5" lat="35.7005" lon="51.3305"><tag k="natural" v="tree"/></node>
  <way id="10"><nd ref="1"/><nd ref="2"/><tag k="highway" v="primary"/><tag k="name" v="Azadi &amp; West"/></way>
  <way id="11"><nd ref="1"/><nd ref="2"/><nd ref="3"/><nd ref="4"/><nd ref="1"/><tag k="building" v="yes"/></way>
  <relation id="20"><member type="way" ref="11" role="outer"/><tag k="type" v="multipolygon"/><tag k="leisure" v="park"/><tag k="name" v="Test Park"/></relation>
  <way id="12"><nd ref="1"/><nd ref="999"/><tag k="highway" v="residential"/></way>
  <way id="13"><nd ref="1"/><nd ref="2"/><tag k="aeroway" v="taxiway"/></way>
</osm>`;

test('OSM XML adapter preserves geometry, IDs and escaped tags in supported layers', () => {
  const parsed = parseOsmXml(FIXTURE);
  assert.deepEqual(parsed.metadata.declaredBounds, [35.65, 51.23, 35.72, 51.35]);
  assert.equal(parsed.metadata.counts.nodes, 5);
  assert.equal(parsed.metadata.counts.ways, 4);
  assert.equal(parsed.metadata.quality.incompleteWays, 1);
  assert.equal(parsed.metadata.quality.missingWayNodeRefs, 1);

  const { layers, report } = buildLayers(parsed, [35.65, 51.23, 35.72, 51.35]);
  assert.equal(layers.roads.length, 1, 'incomplete road way must not enter the network');
  assert.equal(layers.roads[0].nodes.length, 2);
  assert.deepEqual(layers.roads[0].geometry[0], { lat: 35.7, lon: 51.33 });
  assert.equal(layers.roads[0].tags.name, 'Azadi & West');
  assert.equal(layers.buildings.length, 1);
  assert.equal(layers.parks.length, 1);
  assert.equal(layers.parks[0].members[0].geometry.length, 5);
  assert.equal(layers.aeroways.length, 1);
  assert.equal(layers.aeroways[0].tags.aeroway, 'taxiway');
  assert.equal(layers.trees.length, 1);
  assert.equal(layers.trees[0].tags.natural, 'tree');
  assert.equal(report.layerCounts.roads, 1);
  assert.equal(report.incompleteAreaRelationCount, 0);
});

test('OSM XML adapter rejects unrelated XML and filters elements outside the requested box', () => {
  assert.throws(() => parseOsmXml('<root/>'), /OSM XML 0\.6/);
  const parsed = parseOsmXml(FIXTURE);
  const { layers } = buildLayers(parsed, [35.705, 51.23, 35.72, 51.35]);
  assert.equal(layers.roads.length, 0);
  assert.equal(layers.buildings.length, 0);
});
