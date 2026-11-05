// js/geodata.js
// The simulated city's geography: Tehran (js/tehran-geodata.js, built by tools/city/build.mjs), or another city built by
// the same tool (js/<id>-geodata.js) when the page names it as ?city=<id> (outside a browser, the CITY environment
// variable). Only the chosen city's data is loaded.

const DEFAULT_CITY = 'tehran';
const requested = globalThis.location
  ? new URLSearchParams(globalThis.location.search).get('city')
  : globalThis.process?.env?.CITY;
let CITY_ID = DEFAULT_CITY;
let GEO = (await import(`./${DEFAULT_CITY}-geodata.js`)).GEO;
if (requested && requested !== DEFAULT_CITY) {
  try {
    if (!/^[a-z0-9-]+$/.test(requested)) throw new Error('not a city id');
    GEO = (await import(`./${requested}-geodata.js`)).GEO;
    CITY_ID = requested;
  } catch (e) {
    console.error(`[geodata] no city "${requested}" (js/${requested}-geodata.js): ${e.message}; ${GEO.name} instead`);
  }
}

export { GEO, CITY_ID };
