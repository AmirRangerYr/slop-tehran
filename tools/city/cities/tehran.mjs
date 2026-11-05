// Western Tehran — Mehrabad Airport, Ekbatan, Azadi Square and Khalij Fars.
// Coordinates and anchors below are taken from the supplied OpenStreetMap extract (map.osm).
// The Khalij Fars point is a known OSM point inside the neighbourhood, not a claimed neighbourhood centroid:
// its boundary relation (OSM relation 8321782) has missing member ways in the supplied extract.
//
// The world frame is centred on the Azadi Tower itself (the centroid of its mapped X-shaped footprint, OSM relation
// 7814369). Phase D/F centred it on OSM's "Meydan-e Azadi" place node, which sits on the square's western approach road
// ~490 m from the monument; the hand-modelled tower was therefore standing in the street instead of on the plaza.
export default {
  id: 'tehran',
  name: 'Tehran',
  short: 'TH',
  // The Azadi Tower (centre of the mapped monument footprint); the local world frame is centred here.
  origin: { lat: 35.6997385, lon: 51.3380605, label: 'برج آزادی' },
  // Begin on the street nearest the tower (the ring road around the square).
  spawnAt: [35.6997385, 51.3380605],
  // Hand-modelled monuments (js/tehran-features.js). Mapped building outlines within `clearRadius` m of `at` are left
  // out (the OSM tower is an X-shaped outline of parts that would stand inside the model); `axes` are the true compass
  // bearings (degrees, clockwise from north) of the two crossing arches, read off the mapped footprint's arms.
  monuments: [
    { id: 'azadi-tower', name: 'برج آزادی', at: [35.6997385, 51.3380605], clearRadius: 58, axes: [27.7, 149.9], span: 63, height: 45 }
  ],
  bearing: 'auto', // Align the world frame with the dominant road bearing in the selected area.
  // [south, west, north, east]. Bounds include the mapped Mehrabad aerodrome geometry and all four target areas.
  detail: [35.6535000, 51.2335000, 35.7182000, 51.3495000],
  margin: 0.004, // Context outside the playable detail boundary for complete edge blocks.
  sidewalk: 4.5,
  strip: 5,
  // Tehran's larger detail area is rasterised at 2 m for procedural blocks/lots; mapped roads and buildings retain
  // their source geometry and the road graph remains in metre-scale world coordinates. Other cities keep 1 m.
  blockResolution: 2,
  // This map uses actual OSM building footprints; procedural lots add no geographic value here and are prohibitively
  // expensive across the airport's large open blocks. Re-enable after a city-specific land-use pass is available.
  generateLots: false,
  generateLawns: false,
  driveSide: 'right',

  // Existing procedural styles only; mapped building footprints remain the source of truth where available.
  districts: [
    { name: 'شهرک اکباتان', at: [35.7069661, 51.3056201], r: 700, style: 'housing' },
    { name: 'مهرآباد', at: [35.6880754, 51.3136278], r: 550, style: 'lowrise' },
    { name: 'میدان آزادی', at: [35.6997385, 51.3380605], r: 450, style: 'midrise' },
    // Anchor from OSM node 4854493321, named Police Station 179 Khalij Fars.
    { name: 'شهرک خلیج فارس', at: [35.6703176, 51.2654359], r: 450, style: 'lowrise' }
  ],

  // The player arrives at the nearest suitable at-grade street to each geographic anchor.
  places: [
    // OSM node 4558200196: Mehrabad Airport Terminals 1 & 2.
    { id: 'mehrabad-airport', name: 'فرودگاه بین‌المللی مهرآباد', sub: 'غرب تهران', at: [35.6921420, 51.3225685] },
    // OSM node 5637867567: Ekbatan Town.
    { id: 'ekbatan', name: 'شهرک اکباتان', sub: 'غرب تهران', at: [35.7069661, 51.3056201] },
    // The centre of Azadi Square: the Azadi Tower (OSM relation 7814369). OSM node 2169732950 (the square's name label)
    // lies on its western approach road.
    { id: 'azadi-square', name: 'میدان آزادی', sub: 'برج آزادی', at: [35.6997385, 51.3380605] },
    // OSM node 4854493321 lies within the neighbourhood; the incomplete boundary relation is not used as a centroid.
    { id: 'khalij-fars', name: 'شهرک خلیج فارس', sub: 'نقطهٔ مرجع OpenStreetMap', at: [35.6703176, 51.2654359] }
  ],

  labels: [
    { name: 'فرودگاه مهرآباد', at: [35.6921420, 51.3225685], kind: 2 },
    { name: 'شهرک اکباتان', at: [35.7069661, 51.3056201], kind: 2 },
    { name: 'میدان آزادی', at: [35.6997500, 51.3325863], kind: 2 },
    { name: 'برج آزادی', at: [35.6997385, 51.3380605], kind: 2 },
    { name: 'شهرک خلیج فارس', at: [35.6703176, 51.2654359], kind: 2 }
  ]
};
