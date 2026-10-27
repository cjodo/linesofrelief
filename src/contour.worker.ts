import { MINOR, SIMPLIFY, TILE } from './config';
import { loadElevation, loadVector, type Label, type VectorData } from './tiles';
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

self.onmessage = async (e: MessageEvent<SceneRequest>) => {
  const { id, z, tx0, ty0, tx1, ty1, ds, features } = e.data;
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
