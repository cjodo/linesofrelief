// Opinionated parameters: a handful of scales and one look.

/** Where every visit begins: the Three Sisters above Canmore, Alberta (centred on the group). */
export const START = { name: 'Three Sisters', lat: 51.0208, lon: -115.3409 };

/**
 * The web-mercator zooms the view steps through (one tile pixel is one CSS
 * pixel at each); every visit starts at DEFAULT_ZOOM.
 */
export const ZOOMS = [8, 9, 10, 11, 12, 13];
export const DEFAULT_ZOOM = 12;
export const TILE = 256;

/** Grid downsampling before contouring; keeps contouring fast and lines smooth. */
export const DS = 2;

/**
 * How much detail each zoom fetches. `ds`: screen px per elevation sample, so
 * elevation comes log2(ds) zooms coarser (×4 fewer tiles per step). `vectorDrop`:
 * how many zooms coarser the map tiles come. Close in, the full resolution the
 * screen can show; far out, a few basic tiles: the widest views use about a
 * sixteenth of the elevation requests and their contours stay smooth, because
 * the intervals there are hundreds of metres.
 */
export const DETAIL: Record<number, { ds: number; vectorDrop: number }> = {
  13: { ds: 2, vectorDrop: 0 },
  12: { ds: 2, vectorDrop: 0 },
  11: { ds: 2, vectorDrop: 1 },
  10: { ds: 4, vectorDrop: 1 },
  9: { ds: 4, vectorDrop: 2 },
  // Wide views keep enough elevation detail for ranges to read as ranges.
  8: { ds: 4, vectorDrop: 2 },
};

/**
 * Contour interval in metres at each zoom; every INDEX_EVERY-th is an index
 * line. It doubles per step near the default, then grows more gently: the
 * coarse elevation behind the widest views smooths summits, so strict
 * doubling would leave them nearly bare.
 */
export const INTERVALS: Record<number, number> = { 8: 200, 9: 150, 10: 100, 11: 100, 12: 50, 13: 25 };
export const INDEX_EVERY = 5;
/**
 * At and below this zoom, contour lines brighten with altitude (relief
 * emphasis), so mountain ranges stand out from the lowlands at a glance.
 */
export const RELIEF_BELOW = 10;
/** The colour ramp's ends snap to this, at every zoom (fine enough for wide views). */
export const RAMP_STEP = 250;

/** Contour simplification tolerance, in downsampled cells. */
export const SIMPLIFY = 0.12;

/** Rosé Pine ramp, low → high: pine, foam, iris, rose, gold. */
export const RAMP = ['#31748f', '#9ccfd8', '#c4a7e7', '#ebbcba', '#f6c177'];

/** Everything that isn't contours: water, borders, names. Rosé Pine. */
export const INK = {
  base: '#191724',
  text: '#e0def4',
  subtle: '#908caa',
  muted: '#6e6a86',
  water: '#31748f',
  shore: '#9ccfd8',
  border: '#eb6f92',
};

export const SERIF = '"Instrument Serif", Georgia, serif';
export const MONO = '"JetBrains Mono", ui-monospace, monospace';

// Everything external goes through the site's own server (crates/server),
// which caches it in Redis for every visitor: AWS Terrain Tiles (elevation),
// OpenFreeMap (water, borders, names) and Photon (search).
/**
 * Bumping this re-keys every tile URL, bypassing CDN and browser caches that
 * hold bad copies. (v2: a CDN cached the old static site's HTML at tile URLs.)
 */
export const TILE_VERSION = 2;
export const terrainUrl = (z: number, x: number, y: number) =>
  `/tiles/terrain/${z}/${x}/${y}.png?v=${TILE_VERSION}`;
export const vectorUrl = (z: number, x: number, y: number) =>
  `/tiles/vector/${z}/${x}/${y}.pbf?v=${TILE_VERSION}`;
export const SEARCH_URL = '/api/search';
/** Museums per map tile, read by the server from deeper tiles (crates/server). */
export const museumUrl = (z: number, x: number, y: number) =>
  `/api/museums/${z}/${x}/${y}.json?v=${TILE_VERSION}`;
/** Map-tile zooms that carry museums: view zooms 12 and 13 (see DETAIL). */
export const MUSEUM_MIN_ZOOM = 12;
/** Wider than this view zoom, museums show only on the towns that are drawn. */
export const MUSEUM_ICON_ZOOM = 12;

// Caching: tiles are effectively immutable, so they're kept as long as storage allows.
export const CACHE_NAME = 'tiles-v3';
/** Earlier caches keyed by upstream URLs; cleared on first use. */
export const STALE_CACHES = ['tiles-v1', 'tiles-v2'];
/** Max tiles (elevation PNG + vector PBF) kept in persistent Cache Storage. */
export const PERSISTENT_TILES = 6000;
/** Max decoded tiles of each kind held in worker memory. */
export const MEMORY_TILES = 400;
/** Max simultaneous network requests to the tile host. */
export const MAX_CONCURRENT = 6;
