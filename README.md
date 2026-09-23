# Elevation Shading

A static web map for reading terrain, modeled on CalTopo's shading tools.

## Features

- **Shade above**: the slider runs from the lowest to the highest elevation in the current view. At the minimum everything is shaded. Moving it up shades only terrain above that value, with a yellow-to-red ramp up to the highest point. The dot marks the highest point in view, and "Highest in view" zooms to it.
- **Sun exposure**: pick a date and drag the time slider, which runs from 20 minutes before sunrise to 20 minutes after sunset at the map center. Sunlit ground gets yellow diagonal hatching, so it stays readable on top of the elevation colors. Shadows cast by ridges are included. The play button steps through the day. Times are in the map location's time zone.
- **Slope direction**: drag the two dots on the compass to pick a range of directions, and slopes facing that way are shaded purple. Dragging inside the wedge rotates it, and Invert swaps to the other side. Ground flatter than 5° is left unshaded because it has no meaningful direction.
- Each of the three has its own on/off checkbox and opacity slider.
- **Tap or click the map** for a popup with coordinates, elevation, which way the slope faces, and hours of direct sun on the sun-exposure date. The sun hours account for the slope and for terrain up to 30 km away blocking the sun.
- **Search** (top left, minimizable) takes a street address, a place or peak name, or `lat, lng` coordinates.
- **Overlay bar** (right edge, slides out) toggles shade above, sun exposure, slope direction, hillshade, and roads and places with one tap each.
- Base maps: USGS Topo, OpenTopoMap, OpenStreetMap streets, Esri satellite. Hillshade has its own strength slider.
- The URL hash keeps the map position, so views can be bookmarked.

## Run locally

No build step. Serve the folder with any static server:

```sh
python3 -m http.server 8000
# open http://localhost:8000
```

`netlify.toml` publishes the repo root with no build, the same setup as Springo. Connect the repo in Netlify (Add new site → Import from Git) and every push deploys.

## Code

| File | What it does |
|---|---|
| `app.js` | Map setup, panel and overlay wiring |
| `dem.js` | Fetches and decodes elevation tiles, point sampling |
| `terrain.js` | WebGL2 shaders for sun exposure (ray-marched shadows) and slope direction (Horn's method, smoothed) |
| `sun.js` | Sun position and sunrise/sunset, adapted from SunCalc |
| `pointinfo.js` | Tap popup: elevation, slope, facing direction, sun hours with a terrain horizon |
| `search.js` | Geocoding |

## Data

- Elevation: [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) (Terrarium encoding, free, no API key).
- Rendering: [MapLibre GL JS](https://maplibre.org/) `hillshade` and `color-relief` layers plus WebGL2 canvas overlays.
- Geocoding: the [US Census Geocoder](https://geocoding.geo.census.gov/) for street addresses (called through JSONP because it sends no CORS headers), and [Photon](https://photon.komoot.io) for OpenStreetMap places. The Census geocoder covers rural county-road addresses that OpenStreetMap often lacks, but only in the US.
- Time zones: `@photostructure/tz-lookup`.

## Limitations

- The slider range and the highest point come from terrain tiles at a coarser zoom than the screen, so peaks can read slightly low when zoomed out (Mount Elbert shows about 14,350 ft at zoom 10 versus 14,440 ft actual).
- The sun overlay uses the sun position at the map center for the whole view, and its shadows only count terrain within about one tile beyond the view edge. The tap popup's sun hours look much farther (30 km).
- Census address matches are interpolated along the road segment, so the pin lands on the road near the house rather than on the house.
- OpenTopoMap, the OpenStreetMap tile server and Photon have usage policies aimed at light personal use.
