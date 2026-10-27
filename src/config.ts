// Opinionated, fixed parameters. The map has one scale and one look.

/** Where every visit begins: the Three Sisters, Oregon Cascades. */
export const START = { name: 'Three Sisters', lat: 44.135, lon: -121.772 };

/** Fixed web-mercator zoom: one tile pixel is one CSS pixel. */
export const ZOOM = 12;
export const TILE = 256;

/** Grid downsampling before contouring; keeps contouring fast and lines smooth. */
export const DS = 2;

/** Contour intervals in metres. */
export const MINOR = 50;
export const MAJOR = 250;

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
