# Elevation Shading

A static web map that shades terrain above a chosen elevation, similar to CalTopo's elevation shading.

- The slider runs from the lowest to the highest elevation in the current view. At the minimum everything is shaded. Moving it up shades only terrain above that value, with a yellow-to-red ramp up to the highest point.
- The dot marks the highest point in view. Click "Highest in view" to zoom to it.
- Base maps: USGS Topo, OpenTopoMap, OpenStreetMap streets, Esri satellite.
- Overlays: elevation shading, hillshade, roads and place labels.
- The URL hash keeps the map position, so views can be bookmarked.

## Run locally

No build step. Serve the folder with any static server:

```sh
python3 -m http.server 8000
# open http://localhost:8000
```

`netlify.toml` publishes the repo root with no build, the same setup as Springo. Connect the repo in Netlify (Add new site → Import from Git) and every push deploys.

## Data

- Elevation: [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) (Terrarium encoding, free, no API key).
- Rendering: [MapLibre GL JS](https://maplibre.org/) `hillshade` and `color-relief` layers.

The slider range and the highest point are computed by scanning terrain tiles at a coarser zoom than the screen, so peaks can read slightly low when zoomed out (Mount Elbert shows about 14,350 ft at zoom 10 versus 14,440 ft actual). Zoom in for exact values.

OpenTopoMap and the OpenStreetMap tile server have usage policies aimed at light personal use.
