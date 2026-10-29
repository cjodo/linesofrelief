import { TILE } from './config';
import { buildRegion, type Kernel, type SceneRequest } from './scene-build';
import {
  loadElevation,
  loadMuseums,
  loadVector,
  startGroup,
  worldToLonLat,
  type Geometry,
  type Label,
  type VectorData,
  withMuseums,
} from './tiles';
import wasmUrl from './wasm/contour.wasm?url';

export type { ContourLevel, SceneRequest, SceneResult, TileFeatures } from './scene-build';

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

/** Things the legend can find: label kinds, named lakes, and line features. */
export type FindKind =
  | 'city'
  | 'town'
  | 'village'
  | 'peak'
  | 'museum'
  | 'lake'
  | 'ocean'
  | 'river'
  | 'border';

/** "Where is the nearest …?" from a point in world pixels at zoom `z`. */
export interface NearestRequest {
  type: 'nearest';
  id: number;
  kind: FindKind;
  z: number;
  x: number;
  y: number;
  /** Ignore anything closer than this (world px): it's already in view. */
  min: number;
  /** Names already visited: the next nearest instead. */
  skip: string[];
}

export interface NearestResult {
  type: 'nearest';
  id: number;
  kind: FindKind;
  /** World px at the request's zoom; null when nothing is within reach. */
  found: { x: number; y: number; name?: string; ele?: number } | null;
}

export interface SceneProgress {
  type: 'progress';
  id: number;
  done: number;
  total: number;
}

const kernel: Promise<Kernel> = WebAssembly.instantiateStreaming(fetch(wasmUrl))
  .catch(async () => WebAssembly.instantiate(await (await fetch(wasmUrl)).arrayBuffer()))
  .then(({ instance }) => instance.exports as unknown as Kernel);

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

/** Rings of tiles searched around the start: 9×9 tiles at most. */
const NEAREST_RINGS = 4;
const LINES = { ocean: 'ocean', river: 'river', border: 'border' } as const;

/** Every point of `kind` in a tile: line vertices, or label anchors. */
function eachOf(kind: FindKind, v: VectorData, visit: (x: number, y: number, l?: Label) => void) {
  if (kind === 'ocean' || kind === 'river' || kind === 'border') {
    const { coords } = v[LINES[kind]];
    for (let i = 0; i < coords.length; i += 2) visit(coords[i], coords[i + 1]);
    return;
  }
  for (const l of v.labels) {
    if (kind === 'lake' ? l.kind === 'water' && l.cls === 'lake' : l.kind === kind) visit(l.x, l.y, l);
  }
}

/**
 * Search outward a ring of tiles at a time (the tiles the view loads, so
 * mostly cached). After ring r everything within r tiles is covered, so a
 * find that close is the nearest.
 */
async function nearest({ id, kind, z, x, y, min, skip }: NearestRequest): Promise<NearestResult> {
  const skipped = new Set(skip);
  const [cx, cy] = [Math.floor(x / TILE), Math.floor(y / TILE)];
  const best: { d: number; found: NearestResult['found'] } = { d: Infinity, found: null };
  for (let r = 0; r <= NEAREST_RINGS; r++) {
    const ring: [number, number][] = [];
    for (let ty = cy - r; ty <= cy + r; ty++) {
      for (let tx = cx - r; tx <= cx + r; tx++) {
        if (Math.max(Math.abs(tx - cx), Math.abs(ty - cy)) === r) ring.push([tx, ty]);
      }
    }
    await Promise.all(
      ring.map(async ([tx, ty]) => {
        const [v, m] = await Promise.all([
          loadVector(z, tx, ty),
          kind === 'museum' ? loadMuseums(z, tx, ty) : [],
        ]);
        eachOf(kind, withMuseums(v, m), (lx, ly, l) => {
          const [px, py] = [tx * TILE + lx, ty * TILE + ly];
          const d = Math.hypot(px - x, py - y);
          if (d < min || d >= best.d || (l && skipped.has(l.name))) return;
          best.d = d;
          best.found = { x: px, y: py, name: l?.name, ele: l?.ele };
        });
      }),
    );
    if (best.d <= r * TILE) break;
  }
  return { type: 'nearest', id, kind, found: best.found };
}

// Track the last AbortController to cancel previous requests
let lastAbortController = new AbortController();

self.onmessage = async (e: MessageEvent<SceneRequest | NameRequest | NearestRequest>) => {
  // Cancel the previous request
  lastAbortController.abort();
  lastAbortController = new AbortController();
  const signal = lastAbortController.signal;
  
  const msg = e.data;
  if ('type' in msg) {
    try {
      const result = msg.type === 'nearest' ? await nearest(msg) : await nameAt(msg);
      if (!signal.aborted) {
        self.postMessage(result);
      }
    } catch (e) {
      if (e.name !== 'AbortError') {
        throw e;
      }
    }
    return;
  }
  // This request replaces the last of its kind: tiles queued only for that one
  // are skipped (the view has moved on), tiles both want are kept.
  const group = msg.features ? 'detail' : 'preview';
  startGroup(group);
  try {
    const result = await buildRegion(
      msg,
      kernel,
      {
        elevation: (z, x, y) => loadElevation(z, x, y, group, signal),
        vector: (z, x, y) =>
          Promise.all([
            loadVector(z, x, y, group, signal),
            loadMuseums(z, x, y, group, signal),
          ]).then(([v, m]) => withMuseums(v, m)),
      },
      (done, total) => {
        if (!signal.aborted) {
          self.postMessage({ type: 'progress', id: msg.id, done, total } satisfies SceneProgress);
        }
      },
    );
    if (!signal.aborted) {
      // Contour buffers are fresh copies; vector buffers stay cached, so they're cloned.
      self.postMessage(result, {
        transfer: result.levels.flatMap((l) => [l.coords.buffer, l.parts.buffer]),
      });
    }
  } catch (e) {
    if (e.name !== 'AbortError') {
      throw e;
    }
  }
};
