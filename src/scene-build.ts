import { SIMPLIFY, TILE } from './config';
import type { Label, VectorData } from './tiles';

/**
 * Building a scene: tiles in, contours + water + borders + names out. Shared
 * by the browser's worker and the build-time favourites script, so a
 * pre-built favourite is exactly what the browser would have made.
 */

export interface SceneRequest {
  id: number;
  z: number;
  tx0: number;
  ty0: number;
  tx1: number;
  ty1: number;
  /** Grid downsampling before contouring. */
  ds: number;
  /** Contour interval in metres. */
  interval: number;
  /** Take map tiles this many zooms coarser (wide views: ×4 fewer requests per step). */
  vectorDrop?: number;
  /** Also load water, borders and names. Off for the coarse preview. */
  features: boolean;
}

export interface ContourLevel {
  value: number;
  /** Flat x,y pairs in downsampled grid units. */
  coords: Float32Array;
  /** Point count of each polyline, in order. */
  parts: Uint32Array;
}

export interface TileFeatures extends Omit<VectorData, 'labels'> {
  /** Tile origin relative to the scene origin, in world pixels. */
  ox: number;
  oy: number;
  /** Scene pixels per tile pixel: 2 when the tile is one zoom coarser. */
  scale: number;
}

export interface SceneResult {
  type: 'scene';
  id: number;
  /** Tile zoom, contour interval and grid downsampling it was built with. */
  z: number;
  interval: number;
  ds: number;
  /** World-pixel origin and size of the region. */
  originX: number;
  originY: number;
  width: number;
  height: number;
  min: number;
  max: number;
  levels: ContourLevel[];
  tiles: TileFeatures[];
  /** Positions relative to the scene origin. */
  labels: Label[];
}

/** The contour kernel's exports (crates/contour). */
export interface Kernel {
  memory: WebAssembly.Memory;
  input_ptr(len: number): number;
  run(width: number, height: number, ds: number, interval: number, epsilon: number): void;
  coords_ptr(): number;
  coords_len(): number;
  meta_ptr(): number;
  meta_len(): number;
  min_value(): number;
  max_value(): number;
}

/** Where tiles come from: the browser's caches, or the network at build time. */
export interface Loaders {
  elevation(z: number, x: number, y: number): Promise<Float32Array>;
  vector(z: number, x: number, y: number): Promise<VectorData>;
}

function contour(
  k: Kernel,
  tiles: Float32Array[],
  cols: number,
  rows: number,
  ds: number,
  interval: number,
) {
  // Stitch and downsample (ds×ds averages) in one pass, straight into wasm
  // memory: the kernel's input is then ds² smaller than the raw tiles.
  const cell = TILE / ds;
  const width = cols * cell;
  const height = rows * cell;
  const norm = 1 / (ds * ds);
  // Views are re-created after each call because memory growth detaches them.
  const ptr = k.input_ptr(width * height); // may grow memory: call before reading .buffer
  const grid = new Float32Array(k.memory.buffer, ptr, width * height);
  tiles.forEach((tile, n) => {
    const ox = (n % cols) * cell;
    const oy = Math.floor(n / cols) * cell;
    for (let y = 0; y < cell; y++) {
      const out = (oy + y) * width + ox;
      for (let x = 0; x < cell; x++) {
        let sum = 0;
        for (let dy = 0; dy < ds; dy++) {
          const row = (y * ds + dy) * TILE + x * ds;
          for (let dx = 0; dx < ds; dx++) sum += tile[row + dx];
        }
        grid[out + x] = sum * norm;
      }
    }
  });

  k.run(width, height, 1, interval, SIMPLIFY);

  const meta = new Uint32Array(k.memory.buffer, k.meta_ptr(), k.meta_len());
  const coords = new Float32Array(k.memory.buffer, k.coords_ptr(), k.coords_len());
  const levels: ContourLevel[] = [];
  let m = 0;
  let c = 0;
  while (m < meta.length) {
    const value = meta[m];
    const count = meta[m + 1];
    const parts = meta.slice(m + 2, m + 2 + count);
    const points = parts.reduce((a, b) => a + b, 0);
    levels.push({ value, parts, coords: coords.slice(c, c + points * 2) });
    m += 2 + count;
    c += points * 2;
  }
  return { levels, min: k.min_value(), max: k.max_value() };
}

/** Build the scene a request describes. `onTile` reports progress (done, total). */
export async function buildRegion(
  req: SceneRequest,
  kernel: Kernel | Promise<Kernel>,
  load: Loaders,
  onTile: (done: number, total: number) => void = () => {},
): Promise<SceneResult> {
  const { id, z, tx0, ty0, tx1, ty1, ds, features, interval, vectorDrop = 0 } = req;

  // Elevation log2(ds) zooms coarser does the downsampling for free: one
  // elevation pixel per grid cell, from 1/ds² of the tiles. `ef` is scene px
  // per elevation-tile px; the region snaps outward to whole coarse tiles.
  const ef = Math.min(ds, 2 ** z);
  const ez = z - Math.log2(ef);
  const ex0 = Math.floor(tx0 / ef);
  const ey0 = Math.floor(ty0 / ef);
  const ecols = Math.floor(tx1 / ef) - ex0 + 1;
  const erows = Math.floor(ty1 / ef) - ey0 + 1;
  const originX = ex0 * TILE * ef;
  const originY = ey0 * TILE * ef;

  // Map tiles: the scene's own zoom, or one coarser when zoomed out.
  const vf = 2 ** Math.min(vectorDrop, z);
  const vz = z - Math.log2(vf);
  const vx0 = Math.floor(tx0 / vf);
  const vy0 = Math.floor(ty0 / vf);
  const vcols = Math.floor(tx1 / vf) - vx0 + 1;
  const vrows = Math.floor(ty1 / vf) - vy0 + 1;

  const total = ecols * erows + (features ? vcols * vrows : 0);
  let done = 0;
  const tick = <T>(v: T) => {
    onTile(++done, total);
    return v;
  };
  const grid = (x0: number, y0: number, cols: number, rows: number) =>
    Array.from({ length: cols * rows }, (_, n) => ({ x: x0 + (n % cols), y: y0 + Math.floor(n / cols) }));

  const [elevation, vector, k] = await Promise.all([
    Promise.all(grid(ex0, ey0, ecols, erows).map(({ x, y }) => load.elevation(ez, x, y).then(tick))),
    features
      ? Promise.all(grid(vx0, vy0, vcols, vrows).map(({ x, y }) => load.vector(vz, x, y).then(tick)))
      : [],
    kernel,
  ]);

  const { levels, min, max } = contour(k, elevation, ecols, erows, ds / ef, interval);

  const tiles: TileFeatures[] = [];
  const labels: Label[] = [];
  const seen = new Set<string>();
  vector.forEach(({ labels: tileLabels, ...geometry }, n) => {
    const ox = (vx0 + (n % vcols)) * TILE * vf - originX;
    const oy = (vy0 + Math.floor(n / vcols)) * TILE * vf - originY;
    tiles.push({ ...geometry, ox, oy, scale: vf });
    for (const l of tileLabels) {
      const key = `${l.kind}:${l.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      labels.push({ ...l, x: l.x * vf + ox, y: l.y * vf + oy });
    }
  });

  return {
    type: 'scene',
    id,
    z,
    interval,
    ds,
    originX,
    originY,
    width: ecols * TILE * ef,
    height: erows * TILE * ef,
    min,
    max,
    levels,
    tiles,
    labels,
  };
}
