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

const elev = new Float32Array(W * H);
for (let y = 0; y < H; y++) {
  const lat = 90 - ((y + 0.5) / H) * 180;
  for (let x = 0; x < W; x++) elev[y * W + x] = elevation(((x + 0.5) / W) * 360 - 180, lat);
}

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

/** Contour band of a height; the sea is its own band, below every line. */
const band = (e: number) => (e <= 0 ? -1 : Math.floor(e / INTERVAL));

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
    const b = band(e);
    // A line where this texel's band differs from its right or lower neighbour.
    const right = elev[y * W + ((x + 1) % W)];
    const below = y + 1 < H ? elev[i + W] : e;
    const [br, bb] = [band(right), band(below)];
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
