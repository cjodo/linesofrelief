import {
  CACHE_NAME,
  MAX_CONCURRENT,
  MEMORY_TILES,
  PERSISTENT_TILES,
  TILE,
  STALE_CACHES,
  terrainUrl,
  vectorUrl,
} from './config';
import { decodeTile, type Feature } from './mvt';
import { settable } from './text';

// --- Web mercator ----------------------------------------------------------

export function lonLatToWorld(lon: number, lat: number, z: number) {
  const size = TILE * 2 ** z;
  const sin = Math.sin((lat * Math.PI) / 180);
  return {
    x: ((lon + 180) / 360) * size,
    y: (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * size,
  };
}

export function worldToLonLat(x: number, y: number, z: number) {
  const size = TILE * 2 ** z;
  const n = Math.PI - (2 * Math.PI * y) / size;
  return {
    lon: (x / size) * 360 - 180,
    lat: (180 / Math.PI) * Math.atan(Math.sinh(n)),
  };
}

// --- Layered caching ---------------------------------------------------------
//
//   1. memory  — decoded tiles, LRU (Map insertion order)
//   2. disk    — raw responses in Cache Storage, persists across visits
//   3. network — de-duplicated and concurrency-limited

let diskCache: Promise<Cache | null> | null = null;
function openDisk() {
  if (!diskCache && 'caches' in self) {
    for (const name of STALE_CACHES) caches.delete(name).catch(() => {});
  }
  diskCache ??= ('caches' in self ? caches.open(CACHE_NAME) : Promise.resolve(null)).catch(
    () => null,
  );
  return diskCache;
}

let active = 0;
const queue: (() => void)[] = [];
/**
 * Which tiles the newest request of each group still wants. A new request
 * restarts its group's set, so fetches queued for a superseded region (the
 * view has moved on) are skipped before they reach the network. Loads with
 * no group (naming, the minimap) always run.
 */
export type Group = 'detail' | 'preview';
const wanted: Record<Group, Set<string>> = { detail: new Set(), preview: new Set() };
export function startGroup(group: Group) {
  wanted[group] = new Set();
}

async function throttled<T>(fn: () => Promise<T>, key?: string, group?: Group): Promise<T> {
  if (active >= MAX_CONCURRENT) {
    await new Promise<void>((r) => queue.push(r));
    if (group && key && !wanted[group].has(key)) {
      queue.shift()?.(); // hand our turn to the next in line
      throw new Error(`superseded: ${key}`);
    }
  }
  active++;
  try {
    return await fn();
  } finally {
    active--;
    queue.shift()?.();
  }
}

let writesSincePrune = 0;
async function pruneDisk(cache: Cache) {
  const keys = await cache.keys();
  // Cache Storage keys come back in insertion order; drop the oldest.
  for (const req of keys.slice(0, Math.max(0, keys.length - PERSISTENT_TILES))) {
    await cache.delete(req);
  }
}

/** Fetch through the disk cache. */
/**
 * Fetch through the disk cache. Only a response of the expected type is
 * cached or returned: anything else (say, an HTML page a CDN served at a tile
 * URL) counts as a failure, so it's retried later instead of kept forever.
 */
async function fetchCached(url: string, type: string, group?: Group): Promise<Response | null> {
  const isTile = (r: Response) => r.ok && (r.headers.get('content-type') ?? '').startsWith(type);
  const cache = await openDisk();
  const hit = await cache?.match(url);
  if (hit && isTile(hit)) return hit;

  const res = await throttled(() => fetch(url), url, group);
  if (!isTile(res)) throw new Error(`unexpected response for ${url}`);
  if (cache) {
    await cache.put(url, res.clone()).catch(() => {});
    if (++writesSincePrune >= 100) {
      writesSincePrune = 0;
      pruneDisk(cache).catch(() => {});
    }
  }
  return res;
}

function memoize<T>(
  memory: Map<string, Promise<T>>,
  key: string,
  load: () => Promise<T>,
  fallback: T,
): Promise<T> {
  const cached = memory.get(key);
  if (cached) {
    memory.delete(key);
    memory.set(key, cached);
    return cached;
  }
  const p = load().catch(() => {
    memory.delete(key); // allow a retry later
    return fallback;
  });
  memory.set(key, p);
  while (memory.size > MEMORY_TILES) memory.delete(memory.keys().next().value!);
  return p;
}

/** Wrap x around the antimeridian; null when y is off the map. */
function normalize(z: number, x: number, y: number) {
  const n = 2 ** z;
  return y < 0 || y >= n ? null : { x: ((x % n) + n) % n, y };
}

// --- Elevation -------------------------------------------------------------

const elevations = new Map<string, Promise<Float32Array>>();
const flat = new Float32Array(TILE * TILE);

async function decodeElevation(blob: Blob): Promise<Float32Array> {
  const bitmap = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(TILE, TILE);
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  const px = ctx.getImageData(0, 0, TILE, TILE).data;
  const out = new Float32Array(TILE * TILE);
  for (let i = 0; i < out.length; i++) {
    const h = px[i * 4] * 256 + px[i * 4 + 1] + px[i * 4 + 2] / 256 - 32768;
    // Sea level is the floor: oceans stay quiet, coastlines come from vectors.
    out[i] = h > 0 ? h : 0;
  }
  return out;
}

/** Elevation in metres for a tile, row-major TILE×TILE. Never rejects. */
export function loadElevation(z: number, x: number, y: number, group?: Group): Promise<Float32Array> {
  const t = normalize(z, x, y);
  if (!t) return Promise.resolve(flat);
  const url = terrainUrl(z, t.x, t.y);
  if (group) wanted[group].add(url); // before the memo: a shared tile stays wanted
  return memoize(
    elevations,
    url,
    async () => {
      const res = await fetchCached(url, 'image/png', group);
      return res ? decodeElevation(await res.blob()) : flat;
    },
    flat,
  );
}

// --- Vector features (water, borders, names) ---------------------------------

/** Flat x,y pairs (tile pixels, 0..TILE) and the point count of each part. */
export interface Geometry {
  coords: Float32Array;
  parts: Uint32Array;
}

export type LabelKind = 'city' | 'peak' | 'water' | 'town' | 'village';

export interface Label {
  kind: LabelKind;
  name: string;
  /** Tile pixels. */
  x: number;
  y: number;
  /** Lower is more important. */
  rank: number;
  ele?: number;
  /** OpenMapTiles class, e.g. 'ocean' / 'sea' / 'lake' for water names. */
  cls?: string;
}

export interface VectorData {
  ocean: Geometry;
  lake: Geometry;
  river: Geometry;
  border: Geometry;
  labels: Label[];
}

class GeometryBuilder {
  private coords: number[] = [];
  private parts: number[] = [];
  add(ring: { x: number; y: number }[], scale: number) {
    if (ring.length < 2) return;
    this.parts.push(ring.length);
    for (const p of ring) this.coords.push(p.x * scale, p.y * scale);
  }
  build(): Geometry {
    return { coords: Float32Array.from(this.coords), parts: Uint32Array.from(this.parts) };
  }
}

const emptyGeometry = (): Geometry => ({ coords: new Float32Array(), parts: new Uint32Array() });
const emptyVector: VectorData = {
  ocean: emptyGeometry(),
  lake: emptyGeometry(),
  river: emptyGeometry(),
  border: emptyGeometry(),
  labels: [],
};

const LAKE_CLASSES = new Set(['lake', 'pond', 'river']);
const PLACE_KINDS: Record<string, LabelKind> = { city: 'city', town: 'town', village: 'village' };

function decodeVector(buf: ArrayBuffer): VectorData {
  const layers = decodeTile(buf);
  const ocean = new GeometryBuilder();
  const lake = new GeometryBuilder();
  const river = new GeometryBuilder();
  const border = new GeometryBuilder();
  const labels: Label[] = [];

  const each = (name: string, fn: (f: Feature, scale: number) => void) => {
    const layer = layers[name];
    if (!layer) return;
    const scale = TILE / layer.extent;
    for (const f of layer.features) fn(f, scale);
  };
  const nameOf = (p: Record<string, unknown>) =>
    // The first name the bundled faces can set (tiles often carry an empty
    // or mixed-script name:latin); none at all drops the label.
    [p['name:latin'], p['name:en'], p.name].find(
      (n): n is string => typeof n === 'string' && settable(n),
    );

  each('water', (f, s) => {
    const cls = f.properties.class as string;
    const target = cls === 'ocean' ? ocean : LAKE_CLASSES.has(cls) ? lake : null;
    if (target) for (const ring of f.loadGeometry()) target.add(ring, s);
  });
  each('waterway', (f, s) => {
    const cls = f.properties.class;
    if (cls === 'river' || cls === 'canal') for (const part of f.loadGeometry()) river.add(part, s);
  });
  each('boundary', (f, s) => {
    const p = f.properties;
    if (p.admin_level === 2 && !p.maritime) for (const part of f.loadGeometry()) border.add(part, s);
  });
  each('place', (f, s) => {
    const kind = PLACE_KINDS[f.properties.class as string];
    const name = nameOf(f.properties);
    const pt = f.loadGeometry()[0]?.[0];
    if (kind && name && pt) {
      labels.push({ kind, name, x: pt.x * s, y: pt.y * s, rank: Number(f.properties.rank ?? 99) });
    }
  });
  each('mountain_peak', (f, s) => {
    const p = f.properties;
    const name = nameOf(p);
    const pt = f.loadGeometry()[0]?.[0];
    if ((p.class === 'peak' || p.class === 'volcano') && name && pt && typeof p.ele === 'number') {
      labels.push({ kind: 'peak', name, x: pt.x * s, y: pt.y * s, rank: -p.ele, ele: p.ele });
    }
  });
  each('water_name', (f, s) => {
    const name = nameOf(f.properties);
    const part = f.loadGeometry()[0];
    const pt = part?.[Math.floor(part.length / 2)];
    if (name && pt) {
      labels.push({ kind: 'water', name, x: pt.x * s, y: pt.y * s, rank: Number(f.properties.rank ?? 99), cls: String(f.properties.class ?? '') });
    }
  });

  return { ocean: ocean.build(), lake: lake.build(), river: river.build(), border: border.build(), labels };
}

const vectors = new Map<string, Promise<VectorData>>();

/** Water, borders and names for a tile, in tile pixels. Never rejects. */
export function loadVector(z: number, x: number, y: number, group?: Group): Promise<VectorData> {
  const t = normalize(z, x, y);
  if (!t) return Promise.resolve(emptyVector);
  const url = vectorUrl(z, t.x, t.y);
  if (group) wanted[group].add(url);
  return memoize(
    vectors,
    url,
    async () => {
      const res = await fetchCached(url, 'application/x-protobuf', group);
      return res ? decodeVector(await res.arrayBuffer()) : emptyVector;
    },
    emptyVector,
  );
}
