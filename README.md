# Slop Tehran — اسلوپ تهران

**▶ Play: [sloptehran.amirrangeryr.workers.dev](https://sloptehran.amirrangeryr.workers.dev)**

An open-world 3D city simulation of western Tehran, running in the browser. Walk, drive, cycle or fly a helicopter
through the Azadi Tower and square, Ekbatan, Mehrabad Airport and Khalij Fars, with traffic, pedestrians, a day/night
cycle, a street map and teleports.

شبیه‌سازی سه‌بعدی و جهان‌باز غرب تهران در مرورگر: برج و میدان آزادی، شهرک اکباتان، فرودگاه مهرآباد و شهرک خلیج فارس.
پیاده، با خودرو، دوچرخه یا هلی‌کوپتر شهر را بگردید.

## Features

- Real streets, parks and buildings from OpenStreetMap, plus houses and apartment blocks generated along the streets
- A hand-modelled **Azadi Tower** (two crossing 63 m arches, domed crown, plaza and pools) at its true location
- Mehrabad Airport with runways, taxiways, aprons, fences and perimeter walls
- Traffic and pedestrians spread by road length, a street map, and teleports to the four places
- Persian (RTL) interface

## Run locally

You need a browser with WebGPU (or WebGL 2) and an internet connection (three.js is loaded from a CDN). Serve the folder
over HTTP, either with the launchers (`start-game.bat` on Windows, `start-game.sh` on macOS/Linux) or:

```sh
python3 -m http.server 8000     # then open http://localhost:8000/
```

## Project layout

| Path | What it is |
| --- | --- |
| `js/tehran-geodata.js` | The generated city: roads, blocks, buildings, parks, trees, airfield, monuments |
| `js/tehran-features.js` | The Azadi Tower and plaza, and Mehrabad's runways and walls |
| `js/city-grid.js`, `js/open-city-*.js` | Ground, parks, buildings, trees and street details |
| `tools/city/` | The data pipeline (`build.mjs`, street-frontage housing in `infill.mjs`) |
| `tools/data/tehran/` | The processed OpenStreetMap layers the pipeline reads |
| `tests/` | Tests: `node --test tests/<file>` (run each file separately) |

## Rebuild the city data

```sh
node --max-old-space-size=8192 tools/city/build.mjs tehran     # writes js/tehran-geodata.js (~15 s)
node tools/city/preview.mjs tehran previews/tehran.png --mpp 8 # a 2D map of the result
```

City settings (frame, neighbourhoods, places, monument) are in `tools/city/cities/tehran.mjs`.

## Credits and license

This project is a fork of [mrdoob/slop-newyork](https://github.com/mrdoob/slop-newyork) by Mr.doob, used with the
author's permission, and rebuilt around Tehran. It is built with [three.js](https://threejs.org/).

Code is released under the [MIT License](LICENSE) (copyright of the original author and of the Slop Tehran changes).
Map data © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright), available under the
[ODbL](https://opendatacommons.org/licenses/odbl/).
