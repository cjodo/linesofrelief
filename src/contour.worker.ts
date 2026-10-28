import { SIMPLIFY, TILE } from './config';
import {
  loadElevation,
  loadVector,
  startGroup,
  worldToLonLat,
  type Geometry,
  type Label,
  type VectorData,
} from './tiles';
import wasmUrl from './wasm/contour.wasm?url';

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
  /** Take map tiles one zoom coarser (zoomed-out views: a quarter of the requests). */
  coarseVectors?: boolean;
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
  /** Tile zoom and contour interval it was built with. */
  z: number;
  interval: number;
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

/** "What is this place called?" for a point in world pixels at zoom `z`. */
export interface NameRequest {
  type: 'name';
  id: number;
  z: number;
  x: number;
  y: number;
  /** Only answer if the point is at sea (the ocean's name); null on land. */
  oceanOnly?: boolean;
}

export interface NameResult {
  type: 'named';
  id: number;
  name: string | null;
  ele?: number;
}

export interface SceneProgress {
  type: 'progress';
  id: number;
  done: number;
  total: number;
}

interface Kernel {
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

const kernel: Promise<Kernel> = WebAssembly.instantiateStreaming(fetch(wasmUrl))
  .catch(async () => WebAssembly.instantiate(await (await fetch(wasmUrl)).arrayBuffer()))
  .then(({ instance }) => instance.exports as unknown as Kernel);

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

/** Summits within this distance can name a view; the highest one wins. */
const NAME_RADIUS_M = 8000;
const PLACE_ORDER: Label['kind'][] = ['city', 'town', 'village', 'water'];
/** Below this a summit is a hill; a nearby settlement names the view instead. */
const MOUNTAIN_M = 500;
/** Low zooms where oceans and seas carry labels: tried in order, widening. */
const OCEAN_ZOOMS = [5, 3];

/** Even-odd point-in-polygon over every ring (holes included). */
function inside({ coords, parts }: Geometry, px: number, py: number) {
  let hit = false;
  let k = 0;
  for (const n of parts) {
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const [xi, yi] = [coords[k + 2 * i], coords[k + 2 * i + 1]];
      const [xj, yj] = [coords[k + 2 * j], coords[k + 2 * j + 1]];
      if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) hit = !hit;
    }
    k += 2 * n;
  }
  return hit;
}

/** For a point out at sea, the ocean or sea it's in; null on land. */
async function oceanName(z: number, x: number, y: number): Promise<string | null> {
  for (const [i, oz] of OCEAN_ZOOMS.entries()) {
    const k = 2 ** (z - oz);
    const [px, py] = [x / k, y / k];
    const [tx, ty] = [Math.floor(px / TILE), Math.floor(py / TILE)];
    const { ocean, labels } = await loadVector(oz, tx, ty);
    if (i === 0 && !inside(ocean, px - tx * TILE, py - ty * TILE)) return null;
    const d = (l: Label) => Math.hypot(tx * TILE + l.x - px, ty * TILE + l.y - py);
    // Widest zoom: only an ocean is safe; the nearest gulf may be another sea.
    // (The tiles class oceans as 'sea', so match the name.)
    const ok = (l: Label) => l.kind === 'water' && (i === 0 || /\bocean\b/i.test(l.name));
    const water = labels.filter(ok).sort((a, b) => d(a) - d(b))[0];
    if (water) return water.name;
  }
  return null;
}

/**
 * Name a point from the map tiles around it (the same tiles the view loads):
 * the highest summit nearby, else the most important nearby settlement, else
 * a water name. Null when the tiles have nothing (open ocean, empty land).
 */
async function nameAt({ id, z, x, y, oceanOnly }: NameRequest): Promise<NameResult> {
  if (oceanOnly) return { type: 'named', id, name: await oceanName(z, x, y) };
  const { lat } = worldToLonLat(x, y, z);
  const mpp = (40_075_016.686 * Math.cos((lat * Math.PI) / 180)) / (TILE * 2 ** z);
  const r = NAME_RADIUS_M / mpp;
  const near: (Label & { d: number })[] = [];
  const loads: Promise<void>[] = [];
  for (let ty = Math.floor((y - r) / TILE); ty <= Math.floor((y + r) / TILE); ty++) {
    for (let tx = Math.floor((x - r) / TILE); tx <= Math.floor((x + r) / TILE); tx++) {
      loads.push(
        loadVector(z, tx, ty).then(({ labels }) => {
          for (const l of labels) {
            const d = Math.hypot(tx * TILE + l.x - x, ty * TILE + l.y - y);
            if (d <= r) near.push({ ...l, d });
          }
        }),
      );
    }
  }
  await Promise.all(loads);

  const peak = near
    .filter((l) => l.kind === 'peak')
    .sort((a, b) => (b.ele ?? 0) - (a.ele ?? 0))[0];
  const place = near
    .filter((l) => PLACE_ORDER.includes(l.kind))
    .sort((a, b) => PLACE_ORDER.indexOf(a.kind) - PLACE_ORDER.indexOf(b.kind) || a.d - b.d)[0];
  // A city outranks a park hill: summits name the view in mountain country.
  if (peak && ((peak.ele ?? 0) >= MOUNTAIN_M || !place)) {
    return { type: 'named', id, name: peak.name, ele: peak.ele };
  }
  return { type: 'named', id, name: place?.name ?? (await oceanName(z, x, y)) };
}

self.onmessage = async (e: MessageEvent<SceneRequest | NameRequest>) => {
  const msg = e.data;
  if ('type' in msg) {
    self.postMessage(await nameAt(msg));
    return;
  }
  const { id, z, tx0, ty0, tx1, ty1, ds, features, interval, coarseVectors } = msg;

  // Elevation one zoom coarser does the kernel's 2×2 averaging for free: the
  // same contour grid from a quarter of the tiles. `ef` is scene px per
  // elevation-tile px; the region snaps outward to whole coarse tiles.
  const ef = ds >= 2 ? 2 : 1;
  const ez = z - Math.log2(ef);
  const ex0 = Math.floor(tx0 / ef);
  const ey0 = Math.floor(ty0 / ef);
  const ecols = Math.floor(tx1 / ef) - ex0 + 1;
  const erows = Math.floor(ty1 / ef) - ey0 + 1;
  const originX = ex0 * TILE * ef;
  const originY = ey0 * TILE * ef;

  // Map tiles: the scene's own zoom, or one coarser when zoomed out.
  const vf = coarseVectors ? 2 : 1;
  const vz = z - Math.log2(vf);
  const vx0 = Math.floor(tx0 / vf);
  const vy0 = Math.floor(ty0 / vf);
  const vcols = Math.floor(tx1 / vf) - vx0 + 1;
  const vrows = Math.floor(ty1 / vf) - vy0 + 1;

  const total = ecols * erows + (features ? vcols * vrows : 0);
  let done = 0;
  const tick = <T>(v: T) => {
    done++;
    self.postMessage({ type: 'progress', id, done, total } satisfies SceneProgress);
    return v;
  };
  const grid = (x0: number, y0: number, cols: number, rows: number) =>
    Array.from({ length: cols * rows }, (_, n) => ({ x: x0 + (n % cols), y: y0 + Math.floor(n / cols) }));

  // This request replaces the last of its kind: tiles queued only for that one
  // are skipped (the view has moved on), tiles both want are kept.
  const group = features ? 'detail' : 'preview';
  startGroup(group);
  const [elevation, vector, k] = await Promise.all([
    Promise.all(
      grid(ex0, ey0, ecols, erows).map(({ x, y }) => loadElevation(ez, x, y, group).then(tick)),
    ),
    features
      ? Promise.all(
          grid(vx0, vy0, vcols, vrows).map(({ x, y }) => loadVector(vz, x, y, group).then(tick)),
        )
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

  const result: SceneResult = {
    type: 'scene',
    id,
    z,
    interval,
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
  // Contour buffers are fresh copies; vector buffers stay cached, so they're cloned.
  self.postMessage(result, { transfer: levels.flatMap((l) => [l.coords.buffer, l.parts.buffer]) });
};
