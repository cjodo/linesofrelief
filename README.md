# Topography

**An opinionated contour line map.** Live at [linesofrelief.ink](https://linesofrelief.ink).

The whole Earth, drawn the one way it should be: contour lines, coloured by
elevation, on a dark page. Search a peak, a lake, a town or a country and the
map takes you there. Drag to wander. That's it.

## The opinions

- **Contours, and nothing else.** No satellite imagery, no shaded relief, no
  roads to speak of. Water, borders and names are there to orient you; the
  lines do the rest.
- **One palette.** [Rosé Pine](https://rosepinetheme.com), on a dark page.
  Valleys are pine and foam; summits are rose and gold. There is no light
  mode, no theme picker.
- **A handful of scales.** Six steps, from a whole region (z8) to a single
  ridge (z13). Never a zoom slider. Contours sit every 25 to 300 m depending
  on the step, so the page is never empty and never black with ink.
- **Discovery over menus.** Reach a summit that matters at your scale and the
  map says so. Cross into a new state, country or ocean and it says that too.
- **The visitor's machine does the work.** Contours are traced in the
  browser, from raw elevation tiles, by a small Rust kernel compiled to
  WebAssembly. The server only caches things.
- **Small.** About 47 KB of code, styles and fonts on a cold visit, plus one
  pre-rendered first frame so the map is there before anything loads.

## How it works

```
elevation tiles ─┐                       ┌─ contours (Rust → wasm, in a worker)
  (AWS Terrain)  ├─ Rust server ─ Redis ─┤
map tiles ───────┤   (one origin,        ├─ water, borders, names (in-house MVT decoder)
  (OpenFreeMap)  │    shared cache)      │
search ──────────┘                       └─ labels, discovery, minimap, export (canvas)
  (Photon)
```

- **Browser** (`src/`): Vite and plain TypeScript, no framework.
  - A worker stitches elevation tiles, runs the contour kernel (`crates/contour`), and decodes map tiles.
  - The main thread draws on a canvas, places labels, names places, and runs discovery, the minimap and PNG export.
- **Server** (`crates/server`): one small axum binary.
  - It serves the built site and proxies elevation tiles, map tiles, search and reverse lookups.
  - Everything it proxies goes through a Redis cache shared by every visitor, so each upstream object is fetched once, not once per person.
  - Without Redis it still works, just uncached.
- **Pages** (`site/`): generated at build time, as static HTML.
  - Each of the 56 summits gets two pages: a summary at `/mountains/<slug>/` and its live map at `/mountains/<slug>/map/`.
  - There's also an index at `/mountains/`, plus a sitemap, share images and pre-rendered first frames.

## Favourites

`site/favorites.ts` is the creator's list of favourite places: typed, one line
each. They appear under **Favourites** in the nav, and each is pre-built by
`make favorites` into a single file holding the finished scene: contours,
water, borders and names, made by the same code the browser runs. Arriving at
a favourite fetches that one file (about 0.5 MB compressed) instead of about 85 tiles,
and skips decoding and contour tracing entirely. Pan off its edge, or change
the zoom, and the map carries on live.

## Run it

You need Node 22+, and Rust if you change the kernel or the server.

```sh
make dev       # Vite + the Rust server it proxies to (Redis optional)
make serve     # production build, served by the Rust server on :8080
```

Or as one image, which is how it ships:

```sh
docker build -t topography .
docker run -p 8080:8080 -e PORT=8080 -e REDIS_URL=redis://host:6379 topography
```

| Variable | Default | |
| --- | --- | --- |
| `PORT` | `8080` | Server port; the next free one is used if it's taken. |
| `REDIS_URL` | `redis://127.0.0.1:6379` | The shared cache. Optional. |
| `STATIC_DIR` | `dist` | What the server serves. |
| `SITE_URL` | `https://linesofrelief.ink` | Public origin, used for canonical links, share images and the sitemap. Set it at build time when deploying elsewhere. |
| `API_ORIGIN` | `http://localhost:8080` | Where Vite's dev server proxies `/tiles` and `/api`. |

## Make targets

| Target | |
| --- | --- |
| `make wasm` | Rebuild the contour kernel. The `.wasm` is committed, so normal builds don't need Rust. |
| `make verify` | Check every summit in `site/peaks.ts` against the elevation tiles. |
| `make og` | Render share images (`public/og*.jpg`). |
| `make prerender` | Render the pre-rendered first frames (`public/prerender/*.webp`). |
| `make favorites` | Pre-build every place in `site/favorites.ts` into `public/favorites/*.bin`. |

`og` and `prerender` drive a headless Chromium. Set `CHROMIUM=/path/to/chrome`
if Playwright can't find one, and `SLUGS="everest k2"` to render just those.
Fonts are subset with `scripts/subset-fonts.sh`, which needs fonttools.

## Deploy

[Railway](https://railway.com), from the `Dockerfile`, with a separate Redis
service: set `REDIS_URL=${{Redis.REDIS_URL}}` on the web service. Cloudflare
in front is fine: hashed assets are immutable, pages revalidate, and tile
URLs are versioned (`?v=`), so a bad cached copy can always be stepped past.

## Layout

```
src/            the browser app (main.ts wires it together)
  contour.worker.ts   tiles → contours (wasm), water, borders, names
  render.ts           scenes, the colour ramp, drawing
  features.ts         water, lines and labels
  tiles.ts, mvt.ts    tile loading, layered caching, the vector-tile decoder
  discovery.ts        the atlas of summits, discovery cards
  minimap.ts, legend.ts, search.ts, export.ts, banner.ts, …
site/           build-time pages: peaks.ts (the summits), pages.ts (HTML)
crates/contour  the contour kernel (no_std Rust → wasm)
crates/server   the server (axum, Redis, reqwest)
scripts/        verify peaks, render share images and first frames, subset fonts
```

## Data and credits

- Elevation: [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) (Terrarium).
- Map data: © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors,
  © [OpenMapTiles](https://www.openmaptiles.org/), served by [OpenFreeMap](https://openfreemap.org).
- Search and reverse lookup: [Photon](https://photon.komoot.io) by komoot.
- Type: [Instrument Serif](https://fonts.google.com/specimen/Instrument+Serif) and
  [JetBrains Mono](https://www.jetbrains.com/lp/mono/), self-hosted and subset.

## License

The code's license hasn't been chosen yet. The map data and fonts keep their
own licenses and attribution requirements, listed above.
