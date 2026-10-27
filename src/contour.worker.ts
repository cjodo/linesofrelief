import { MINOR, SIMPLIFY, TILE } from './config';
import {
  loadElevation,
  loadVector,
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
}

export interface SceneResult {
  type: 'scene';
  id: number;
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

function contour(k: Kernel, tiles: Float32Array[], cols: number, rows: number, ds: number) {
  const width = cols * TILE;
  const height = rows * TILE;
  // Stitch straight into wasm memory; views are re-created after each call
  // because memory growth detaches them.
  const ptr = k.input_ptr(width * height); // may grow memory: call before reading .buffer
  const grid = new Float32Array(k.memory.buffer, ptr, width * height);
  tiles.forEach((tile, n) => {
    const ox = (n % cols) * TILE;
    const oy = Math.floor(n / cols) * TILE;
    for (let y = 0; y < TILE; y++) {
      grid.set(tile.subarray(y * TILE, (y + 1) * TILE), (oy + y) * width + ox);
    }
  });

  k.run(width, height, ds, MINOR, SIMPLIFY);

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
async function nameAt({ id, z, x, y }: NameRequest): Promise<NameResult> {
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
  const { id, z, tx0, ty0, tx1, ty1, ds, features } = msg;
  const cols = tx1 - tx0 + 1;
  const rows = ty1 - ty0 + 1;
  const total = cols * rows * (features ? 2 : 1);
  let done = 0;
  const tick = <T>(v: T) => {
    done++;
    self.postMessage({ type: 'progress', id, done, total } satisfies SceneProgress);
    return v;
  };

  const coords = Array.from({ length: cols * rows }, (_, n) => ({
    x: tx0 + (n % cols),
    y: ty0 + Math.floor(n / cols),
  }));
  const [elevation, vector, k] = await Promise.all([
    Promise.all(coords.map(({ x, y }) => loadElevation(z, x, y).then(tick))),
    features ? Promise.all(coords.map(({ x, y }) => loadVector(z, x, y).then(tick))) : [],
    kernel,
  ]);

  const { levels, min, max } = contour(k, elevation, cols, rows, ds);

  const tiles: TileFeatures[] = [];
  const labels: Label[] = [];
  const seen = new Set<string>();
  vector.forEach(({ labels: tileLabels, ...geometry }, n) => {
    const ox = (n % cols) * TILE;
    const oy = Math.floor(n / cols) * TILE;
    tiles.push({ ...geometry, ox, oy });
    for (const l of tileLabels) {
      const key = `${l.kind}:${l.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      labels.push({ ...l, x: l.x + ox, y: l.y + oy });
    }
  });

  const result: SceneResult = {
    type: 'scene',
    id,
    originX: tx0 * TILE,
    originY: ty0 * TILE,
    width: cols * TILE,
    height: rows * TILE,
    min,
    max,
    levels,
    tiles,
    labels,
  };
  // Contour buffers are fresh copies; vector buffers stay cached, so they're cloned.
  self.postMessage(result, { transfer: levels.flatMap((l) => [l.coords.buffer, l.parts.buffer]) });
};
