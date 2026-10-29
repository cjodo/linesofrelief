/**
 * Pre-renders the globe's texture (public/globe.png): the whole Earth's
 * contours, equirectangular, in the map's own colours, for the spinning
 * globe on /why/ (src/globe.ts wraps it round a sphere).
 *
 * Elevation comes through the running server (BASE) at zoom 3, the same
 * Terrarium tiles the map uses. Lines every INTERVAL metres, coloured up the
 * map's ramp and brighter with height (as the map's wide views draw them),
 * coastlines in foam, the sea faintly tinted. Use `make globe`.
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
/** Colour steps up the ramp (the palette holds 3 + STEPS colours). */
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
const mix = (a: RGB, b: RGB, t: number): RGB => a.map((v, i) => Math.round(v + (b[i] - v) * t)) as RGB;

const base = hex(INK.base);
const palette: RGB[] = [
  base, // 0: land
  mix(base, hex(INK.water), 0.16), // 1: sea
  mix(base, hex(INK.shore), 0.75), // 2: coastline
];
const RAMP0 = palette.length;
for (let s = 0; s < STEPS; s++) {
  const t = s / (STEPS - 1);
  // Lowlands recede, high ground glows: the map's wide-view relief emphasis.
  palette.push(mix(base, css(ramp(t)), 0.3 + 0.7 * t));
}

// --- Lines -------------------------------------------------------------------------

/** Contour band of texel `i`; the sea (under half land) is its own band, below every line. */
const band = (i: number) => (land[i] < 0.5 ? -1 : Math.floor(Math.max(0, elev[i]) / INTERVAL));

const out = new Uint8Array(W * H);
for (let y = 0; y < H; y++) {
  const lat = 90 - ((y + 0.5) / H) * 180;
  if (Math.abs(lat) > MAX_LAT) {
    out.fill(lat < 0 ? 0 : 1, y * W, (y + 1) * W);
    continue;
  }
  for (let x = 0; x < W; x++) {
    const i = y * W + x;
    const e = elev[i];
    const b = band(i);
    // A line where this texel's band differs from its right or lower neighbour.
    const [ri, bi] = [y * W + ((x + 1) % W), y + 1 < H ? i + W : i];
    const [right, below] = [elev[ri], elev[bi]];
    const [br, bb] = [band(ri), band(bi)];
    if (b === br && b === bb) {
      out[i] = b < 0 ? 1 : 0;
    } else if (b < 0 || br < 0 || bb < 0) {
      out[i] = 2;
    } else {
      const top = Math.max(e, right, below);
      const t = Math.min(1, (Math.floor(top / INTERVAL) * INTERVAL) / PEAK);
      out[i] = RAMP0 + Math.round(t * (STEPS - 1));
    }
  }
}

const png = encodeIndexedPng(W, H, palette, out);
writeFileSync(OUT, png);
console.log(`wrote ${OUT}  ${W}×${H}, ${palette.length} colours, ${(png.length / 1024).toFixed(0)} KB`);
