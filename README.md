# Elevation Shading

A static web map for reading terrain, modeled on CalTopo's shading tools.

## Features

- **Shade elevations**: a two-handle slider runs from the lowest to the highest elevation in the current view, and terrain between the handles is shaded with a yellow-to-red ramp. With the low handle at the bottom everything below the high handle is included, and with the high handle at the top there is no upper limit, so it also works as plain "shade above". Both ends can be typed in. The dot marks the highest point in view, and "Highest in view" zooms to it.
- **Sun exposure**: pick a date and drag the time slider; times and sun position are for the map center. Ground in shadow is darkened with a navy veil and sunlit ground is left clear, so the map and the elevation colors stay readable where the sun is. Slopes the sun only grazes fade in gradually. During golden hour (sun between 4° below and 6° above the horizon) sunlit ground glows gold. The time slider's track is colored by light phase (night, blue hour, golden hour, day) and the golden-hour times are listed under it. The slider runs from just before morning golden hour to just after evening golden hour. Shadows cast by ridges are included. The play button steps through the day. Times are in the map location's time zone.
- **Slope direction**: drag the two dots on the compass to pick a range of directions, and slopes facing that way are shaded purple. Dragging inside the wedge rotates it, and Invert swaps to the other side. Ground flatter than 5° is left unshaded because it has no meaningful direction.
- **Slope angle**: colors slopes by steepness in the usual avalanche-terrain classes (27–29° yellow, 30–31° amber, 32–34° orange, 35–45° red, 46–50° purple, 51–59° blue, 60°+ black, with greens below 27°). A two-handle slider limits it to a range, 27° to 60°+ by default. Angles read low when zoomed out because the terrain data is coarser there, and the panel says so below zoom 12.5.
- Each shading feature has its own on/off checkbox and opacity slider. Elevations, the time of day, compass angles and slope angles can also be typed in exactly.
- **Tap or click the map** for a popup with coordinates, elevation, which way the slope faces, and hours of direct sun on the sun-exposure date. The sun hours account for the slope and for terrain up to 30 km away blocking the sun.
- **Elevation profile** (chart button at the bottom of the overlay bar): in Draw mode, drag on the map to draw the route freehand, and tap to add a straight segment instead; each stroke or tap is one segment. Move map mode lets dragging pan again, and taps still add straight segments. Pinch zoom works while drawing. The profile appears in a sheet. Every point is numbered on the map and the chart, with a dashed line at each segment boundary, and each segment's length, gain and loss is listed. Hovering or dragging on the chart shows that spot on the map. Undo removes the last point.
- **Offline maps** (download button at the bottom of the overlay bar): saves USGS Topo and elevation data for the dashed box on screen, with a size estimate first. Standard detail saves topo to zoom 15 and elevation to zoom 14; Full saves one zoom further. Every shading tool, the tap popup (including sun hours) and the profile then work there without signal, and zooming past the saved detail scales up the saved tiles instead of going blank. A banner shows when the device is offline, saved areas are outlined, and the base map switches to USGS Topo. OpenStreetMap, OpenTopoMap and Esri tiles are never saved because their terms forbid bulk download, and search needs a connection.
- **Search** (top left, minimizable) takes a street address, a place or peak name, or `lat, lng` coordinates.
- **Overlay bar** (left side, slides out) drops down from the layers button and toggles shade elevations, sun exposure, slope direction, slope angle and hillshade with one tap each, plus the profile tool.
- Base maps: USGS Topo, OpenTopoMap, OpenStreetMap streets, Esri satellite. Hillshade has its own strength slider.
- The URL hash keeps the map position, so views can be bookmarked.

## Install on a phone

The site is an installable web app. In Chrome on Android, open the menu and choose **Install app** (or **Add to Home screen**). On iPhone, use Safari's Share button and **Add to Home Screen**. The app opens full screen at the last place you viewed, and it starts without signal: the map library is vendored and the service worker keeps every app file. Map tiles are only available offline inside saved areas.

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
| `terrain.js` | WebGL2 shaders for sun exposure (ray-marched shadows, drawn as a shadow veil), slope direction and slope angle (Horn's method, smoothed) |
| `dualrange.js` | Two-handle range slider |
| `sun.js` | Sun position and sunrise/sunset, adapted from SunCalc |
| `pointinfo.js` | Tap popup: elevation, slope, facing direction, sun hours with a terrain horizon |
| `search.js` | Geocoding |
| `profile.js` | Elevation profile sampling and chart |
| `offline.js` | Saved areas: tile lists, downloads, storage, and serving saved or scaled-up tiles |
| `sw.js`, `manifest.webmanifest`, `icons/` | Installable app: service worker (network-first, offline fallback), manifest and icons |
| `vendor/` | MapLibre GL JS 6.10.0 (BSD-3-Clause) and tz-lookup 11.7.0 (CC0), copied unchanged so the app starts offline |

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
