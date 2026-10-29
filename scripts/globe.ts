/**
 * Pre-renders the globe's texture (public/globe.png): the whole Earth's
 * contours, equirectangular, in the map's own colours, for the spinning
 * wireframe globe on /why/ (src/globe.ts wraps it round a sphere).
 *
 * Elevation comes through the running server (BASE) at zoom 3, the same
 * Terrarium tiles the map uses. Lines only, on a transparent ground: contours
 * every INTERVAL metres up the map's ramp, stronger with height (as the map's
 * wide views draw them), coastlines in foam, and a faint graticule every
 * GRATICULE degrees. Use `make globe`.
 */
import { writeFileSync } from 'node:fs';
import { INK, terrainUrl } from '../src/config';
import { ramp } from '../src/render';
import { terrariumToElevation } from '../src/tiles';
import { decodePng, encodeIndexedPng } from './png';

const BASE = process.env.BASE ?? 'http://localhost:8080';
const OUT = 'public/globe.png';

/** Zoom 3: 8×8 tiles, a 2048 px square mercator world. */
const Z = 3;
const TILE = 256;
const SIDE = TILE * 2 ** Z;
/** Equirectangular texture: about one texel per screen pixel at the globe's size. */
const W = 2048;
const H = 1024;
/**
 * Lines are traced on elevation averaged over DOWNSAMPLE² texels: at globe
 * size full-detail lines read as speckle, so they follow the broad shape.
 */
const DOWNSAMPLE = 4;
/** Metres between contours; the ramp tops out at PEAK. */
const INTERVAL = 500;
const PEAK = 6000;
/** Degrees between the faint latitude and longitude lines. */
const GRATICULE = 30;
/** Colour steps up the ramp. */
const STEPS = 48;
/** Web mercator stops here: nearer the poles there's no data, so no lines
 * (Antarctica's plateau runs on as plain land, the Arctic as plain sea). */
const MAX_LAT = 85.0511;

async function tile(x: number, y: number): Promise<Float32Array> {
  const res = await fetch(BASE + terrainUrl(Z, x, y));
  if (!res.ok) throw new Error(`tile ${Z}/${x}/${y}: ${res.status}`);
  const png = decodePng(new Uint8Array(await res.arrayBuffer()));
  return terrariumToElevation(png.pixels, png.channels);
}

// The mercator world, one elevation per pixel (sea level floors it at 0).
const world = new Float32Array(SIDE * SIDE);
const n = 2 ** Z;
await Promise.all(
  Array.from({ length: n * n }, async (_, i) => {
    const [tx, ty] = [i % n, Math.floor(i / n)];
    const e = await tile(tx, ty);
    for (let row = 0; row < TILE; row++) {
      world.set(e.subarray(row * TILE, (row + 1) * TILE), (ty * TILE + row) * SIDE + tx * TILE);
    }
  }),
);

/** Elevation at (lon, lat) in degrees, bilinear from the mercator world. */
function elevation(lon: number, lat: number): number {
  const l = Math.max(-MAX_LAT, Math.min(MAX_LAT, lat)) * (Math.PI / 180);
  const fx = ((lon + 180) / 360) * SIDE - 0.5;
  const fy = (0.5 - Math.log(Math.tan(Math.PI / 4 + l / 2)) / (2 * Math.PI)) * SIDE - 0.5;
  const x0 = Math.floor(fx);
  const y0 = Math.max(0, Math.min(SIDE - 2, Math.floor(fy)));
  const [dx, dy] = [fx - x0, Math.max(0, Math.min(1, fy - y0))];
  const at = (x: number, y: number) => world[y * SIDE + ((x + SIDE) % SIDE)];
  const top = at(x0, y0) * (1 - dx) + at(x0 + 1, y0) * dx;
  const bottom = at(x0, y0 + 1) * (1 - dx) + at(x0 + 1, y0 + 1) * dx;
  return top * (1 - dy) + bottom * dy;
}

const full = new Float32Array(W * H);
for (let y = 0; y < H; y++) {
  const lat = 90 - ((y + 0.5) / H) * 180;
  for (let x = 0; x < W; x++) full[y * W + x] = elevation(((x + 0.5) / W) * 360 - 180, lat);
}

/**
 * `values` averaged over DOWNSAMPLE² blocks, then bilinear back up to full
 * size (wrapping east-west): the same field, smoothed.
 */
function smooth(values: Float32Array): Float32Array {
  const [cw, ch] = [W / DOWNSAMPLE, H / DOWNSAMPLE];
  const coarse = new Float32Array(cw * ch);
  for (let i = 0; i < W * H; i++) {
    const [x, y] = [i % W, Math.floor(i / W)];
    coarse[Math.floor(y / DOWNSAMPLE) * cw + Math.floor(x / DOWNSAMPLE)] += values[i] / DOWNSAMPLE ** 2;
  }
  const at = (cx: number, cy: number) => coarse[cy * cw + ((cx + cw) % cw)];
  const out = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    const fy = Math.max(0, Math.min(ch - 1, (y + 0.5) / DOWNSAMPLE - 0.5));
    const y0 = Math.min(ch - 2, Math.floor(fy));
    const dy = fy - y0;
    for (let x = 0; x < W; x++) {
      const fx = (x + 0.5) / DOWNSAMPLE - 0.5;
      const x0 = Math.floor(fx);
      const dx = fx - x0;
      const top = at(x0, y0) * (1 - dx) + at(x0 + 1, y0) * dx;
      const bottom = at(x0, y0 + 1) * (1 - dx) + at(x0 + 1, y0 + 1) * dx;
      out[y * W + x] = top * (1 - dy) + bottom * dy;
    }
  }
  return out;
}

const elev = smooth(full);
// The coast from how much of each block is land, not from heights: the sea
// is a flat 0, so averaged heights near shore would trace the block grid.
const land = smooth(full.map((e) => (e > 0 ? 1 : 0)));

// --- Palette ---------------------------------------------------------------------

type RGB = [number, number, number];
const hex = (h: string): RGB => {
  const v = parseInt(h.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
};
const css = (c: string): RGB => c.match(/\d+/g)!.slice(0, 3).map(Number) as RGB;

// Colours and their opacity: the ground is clear, so only lines show. Each
// colour comes in COVER strengths, for the soft edges of anti-aliased lines.
/** Coverage levels per colour: a line's edge fades over these. */
const COVER = 4;
/** Lines are this many texels across (their soft edge adds about one more). */
const LINE = 1.1;

const palette: RGB[] = [hex(INK.base)]; // 0: nothing (transparent)
const alphas = [0];
/** Add a colour at full strength `alpha` (0-1); returns its first index. */
function colour(rgb: RGB, alpha: number) {
  const first = palette.length;
  for (let q = 1; q <= COVER; q++) {
    palette.push(rgb);
    alphas.push(Math.round(255 * alpha * (q / COVER)));
  }
  return first;
}
const GRID = colour(css(ramp(0.5)), 0.3);
const COAST = colour(hex(INK.shore), 0.92);
const RAMP0 = palette.length;
for (let s = 0; s < STEPS; s++) {
  const t = s / (STEPS - 1);
  // Lowlands recede, high ground glows: the map's wide-view relief emphasis.
  colour(css(ramp(t)), 0.35 + 0.65 * t);
}

// --- Lines -------------------------------------------------------------------------
//
// Each texel's coverage comes from its distance to the nearest line, measured
// in texels (a field's distance from a level, over the field's gradient), so
// lines have soft edges rather than stair-stepped ones.

/** How much a line `d` texels away covers this texel. */
const cover = (d: number) => Math.max(0, Math.min(1, LINE / 2 + 0.5 - d));

/** Gradient length of `f` at texel (x, y), per texel (wrapping east-west). */
function gradient(f: Float32Array, x: number, y: number) {
  const row = y * W;
  const gx = (f[row + ((x + 1) % W)] - f[row + ((x - 1 + W) % W)]) / 2;
  const gy = (f[Math.min(H - 1, y + 1) * W + x] - f[Math.max(0, y - 1) * W + x]) / 2;
  return Math.hypot(gx, gy);
}

/** Texels from (lat or lon) `deg` to the nearest graticule line, at `texel` degrees per texel. */
const toGrid = (deg: number, texel: number) =>
  (Math.abs(deg / GRATICULE - Math.round(deg / GRATICULE)) * GRATICULE) / texel;

const out = new Uint8Array(W * H);
for (let y = 0; y < H; y++) {
  const lat = 90 - ((y + 0.5) / H) * 180;
  const parallel = cover(toGrid(lat, 180 / H));
  const polar = Math.abs(lat) > MAX_LAT;
  for (let x = 0; x < W; x++) {
    const i = y * W + x;
    const lon = ((x + 0.5) / W) * 360 - 180;
    const grid = Math.max(parallel, cover(toGrid(lon, 360 / W)));
    let first = GRID;
    let c = grid;
    if (!polar) {
      // The coast: where the land share crosses half.
      const coast = cover(Math.abs(land[i] - 0.5) / Math.max(1e-6, gradient(land, x, y)));
      // Contours: inland, the nearest level above sea.
      let contour = 0;
      let level = 0;
      if (land[i] >= 0.5) {
        level = Math.max(INTERVAL, Math.round(elev[i] / INTERVAL) * INTERVAL);
        contour = cover(Math.abs(elev[i] - level) / Math.max(1e-6, gradient(elev, x, y)));
      }
      // Coast over contours over the graticule.
      if (coast > 0) [first, c] = [COAST, coast];
      else if (contour > 0) {
        const t = Math.min(1, level / PEAK);
        [first, c] = [RAMP0 + Math.round(t * (STEPS - 1)) * COVER, contour];
      }
    }
    const q = Math.round(c * COVER);
    out[i] = q === 0 ? 0 : first + q - 1;
  }
}

const png = encodeIndexedPng(W, H, palette, out, alphas);
writeFileSync(OUT, png);
console.log(`wrote ${OUT}  ${W}×${H}, ${palette.length} colours, ${(png.length / 1024).toFixed(0)} KB`);
