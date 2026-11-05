import assert from 'node:assert/strict';
import test from 'node:test';
import { loadCity } from '../tools/city/config.mjs';

const TARGETS = {
  'mehrabad-airport': [35.6921420, 51.3225685],
  ekbatan: [35.7069661, 51.3056201],
  'azadi-square': [35.6997385, 51.3380605],
  'khalij-fars': [35.6703176, 51.2654359]
};

test('Tehran city configuration follows the existing OSM-city schema', async () => {
  const city = await loadCity('tehran');
  assert.equal(city.id, 'tehran');
  assert.equal(city.name, 'Tehran');
  assert.equal(city.short, 'TH');
  assert.equal(city.driveSide, 'right');
  assert.equal(city.blockResolution, 2, 'the larger Tehran detail area uses the city-scoped 2 m procedural block raster');
  assert.equal(city.generateLots, false, 'Tehran uses its mapped building footprints instead of procedural lot rectangles');
  assert.equal(city.generateLawns, false, 'Tehran does not allocate the extra property-line lawn raster during the initial data build');
  assert.equal(city.bearing, 'auto');
  assert.deepEqual(city.detail.length, 4);

  const [south, west, north, east] = city.detail;
  assert.ok(south < city.origin.lat && city.origin.lat < north, 'origin latitude is inside detail bounds');
  assert.ok(west < city.origin.lon && city.origin.lon < east, 'origin longitude is inside detail bounds');

  const places = new Map(city.places.map((place) => [place.id, place]));
  assert.deepEqual([...places.keys()].sort(), Object.keys(TARGETS).sort());
  for (const [id, [lat, lon]] of Object.entries(TARGETS)) {
    assert.deepEqual(places.get(id).at, [lat, lon], `${id} keeps its verified OSM anchor`);
    assert.ok(lat > south && lat < north, `${id} latitude is inside detail bounds`);
    assert.ok(lon > west && lon < east, `${id} longitude is inside detail bounds`);
  }
  assert.ok(city.detail[1] < 51.2413888, 'detail boundary contains the western edge of the mapped Khalij Fars relation');
  assert.ok(city.detail[3] > 51.3425139, 'detail boundary contains the eastern edge of the mapped Mehrabad aerodrome way');
});
