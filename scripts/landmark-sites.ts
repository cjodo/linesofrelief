/**
 * The ground around each landmark (site/landmarks.ts), for its site model in
 * scripts/landmarks.py: building footprints with their heights, a terrain
 * grid and a water mask, in metres east and north of the landmark, within a
 * radius. Written to .cache/landmarks/<slug>.json (regenerated, not kept).
 *
 * Tiles come through the running server (BASE): OpenFreeMap's z14 vector
 * tiles (the OpenMapTiles building and water layers) and z15 terrain.
 * Use `make landmark-sites` (optionally SLUGS="eiffel-tower"); it bundles
 * this script first, since src/ imports are written for the browser build.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { LANDMARKS, type Landmark } from '../site/landmarks';
import { TILE, terrainUrl, vectorUrl } from '../src/config';
import { decodeTile, type Ring } from '../src/mvt';
import { lonLatToWorld, terrariumToElevation, worldToLonLat } from '../src/tiles';
import { decodePng } from './png';

const BASE = process.env.BASE ?? 'http://localhost:8080';
const OUT = '.cache/landmarks';
const ONLY = process.argv.slice(2);
const VECTOR_Z = 14;
const TERRAIN_Z = 15;
/** The terrain grid's spacing, metres. */
const STEP = 4;
/** How far each site reaches from its landmark, metres: enough for its neighbourhood, not so far it shrinks. */
const RADIUS: Record<string, number> = {
  'eiffel-tower': 560,
  'great-pyramid-of-giza': 600,
  'taj-mahal': 380,
  colosseum: 420,
  'burj-khalifa': 700,
  'sydney-opera-house': 480,
};
/** A building with no height in the tiles. */
const DEFAULT_HEIGHT = 8;

async function get(path: string, type: string): Promise<ArrayBuffer> {
  const res = await fetch(BASE + path);
  const got = res.headers.get('content-type') ?? '';
  if (!res.ok || !got.startsWith(type)) throw new Error(`${path}: ${res.status} ${got}`);
  return res.arrayBuffer();
}

/** Metres east and north of the landmark, near enough flat over a site. */
function local(l: Landmark) {
  const kx = 111_320 * Math.cos((l.lat * Math.PI) / 180);
  const ky = 110_540;
  return {
    fromLonLat: (lon: number, lat: number): [number, number] => [(lon - l.lon) * kx, (lat - l.lat) * ky],
    toLonLat: (x: number, y: number) => ({ lon: l.lon + x / kx, lat: l.lat + y / ky }),
  };
}

/** The tiles at zoom z covering a site. */
function tilesOver(l: Landmark, r: number, z: number) {
  const { toLonLat } = local(l);
  const a = toLonLat(-r, r);
  const b = toLonLat(r, -r);
  const p = lonLatToWorld(a.lon, a.lat, z);
  const q = lonLatToWorld(b.lon, b.lat, z);
  const out: [number, number][] = [];
  for (let x = Math.floor(p.x / TILE); x <= Math.floor(q.x / TILE); x++) {
    for (let y = Math.floor(p.y / TILE); y <= Math.floor(q.y / TILE); y++) out.push([x, y]);
  }
  return out;
}

const area = (ring: [number, number][]) =>
  ring.reduce((s, [x, y], i) => {
    const [x2, y2] = ring[(i + 1) % ring.length];
    return s + x * y2 - x2 * y;
  }, 0) / 2;

/** Group a polygon feature's rings into polygons: each outer ring with its holes. */
function polygons(rings: [number, number][][]) {
  const out: [number, number][][][] = [];
  for (const ring of rings) {
    if (ring.length < 4) continue;
    // Tile y runs down, so MVT's clockwise outer rings come out counter-clockwise here.
    if (area(ring) > 0 || !out.length) out.push([ring]);
    else out[out.length - 1].push(ring);
  }
  return out;
}

async function site(l: Landmark) {
  const r = RADIUS[l.slug] ?? 500;
  const { fromLonLat } = local(l);
  const toLocal = (tx: number, ty: number, extent: number) => (ring: Ring) =>
    ring.map(({ x, y }) => {
      const { lon, lat } = worldToLonLat((tx + x / extent) * TILE, (ty + y / extent) * TILE, VECTOR_Z);
      const [mx, my] = fromLonLat(lon, lat);
      return [Math.round(mx * 10) / 10, Math.round(my * 10) / 10] as [number, number];
    });

  const buildings: { rings: [number, number][][]; h: number; min: number }[] = [];
  const water: [number, number][][][] = [];
  for (const [tx, ty] of tilesOver(l, r, VECTOR_Z)) {
    const layers = decodeTile(await get(vectorUrl(VECTOR_Z, tx, ty), 'application/x-protobuf'));
    const building = layers.building;
    for (const f of building?.features ?? []) {
      if (f.type !== 3 || f.properties.hide_3d) continue;
      const h = Number(f.properties.render_height ?? DEFAULT_HEIGHT) || DEFAULT_HEIGHT;
      const min = Number(f.properties.render_min_height ?? 0) || 0;
      // One feature holds every building of a height in the tile: take them one by one.
      const tilePx = f.loadGeometry().map((ring) => ring.map(({ x, y }) => [x, y] as [number, number]));
      for (const poly of polygons(tilePx)) {
        const outer = poly[0];
        const [px, py] = outer.reduce(([a, b], [x, y]) => [a + x / outer.length, b + y / outer.length], [0, 0]);
        // A building over a tile edge is in both tiles, clipped: the one holding its middle keeps it.
        if (px < 0 || py < 0 || px >= building.extent || py >= building.extent) continue;
        const rings = poly.map((ring) => toLocal(tx, ty, building.extent)(ring.map(([x, y]) => ({ x, y }))));
        const [cx, cy] = rings[0].reduce(([a, b], [x, y]) => [a + x / outer.length, b + y / outer.length], [0, 0]);
        if (Math.hypot(cx, cy) <= r) buildings.push({ rings, h, min });
      }
    }
    const w = layers.water;
    for (const f of w?.features ?? []) {
      if (f.type !== 3) continue;
      water.push(...polygons(f.loadGeometry().map(toLocal(tx, ty, w.extent))));
    }
  }

  // Terrain: z15 elevation, sampled at each grid point.
  const tiles = new Map<string, Float32Array>();
  for (const [tx, ty] of tilesOver(l, r, TERRAIN_Z)) {
    const png = decodePng(new Uint8Array(await get(terrainUrl(TERRAIN_Z, tx, ty), 'image/png')));
    tiles.set(`${tx}/${ty}`, terrariumToElevation(png.pixels, png.channels));
  }
  const { toLonLat } = local(l);
  const elevation = (x: number, y: number) => {
    const { lon, lat } = toLonLat(x, y);
    const p = lonLatToWorld(lon, lat, TERRAIN_Z);
    const at = (wx: number, wy: number) => {
      const t = tiles.get(`${Math.floor(wx / TILE)}/${Math.floor(wy / TILE)}`);
      if (!t) return 0;
      const px = Math.min(TILE - 1, Math.max(0, Math.floor(wx) % TILE));
      const py = Math.min(TILE - 1, Math.max(0, Math.floor(wy) % TILE));
      return t[py * TILE + px];
    };
    // Bilinear, across tile edges.
    const x0 = Math.floor(p.x - 0.5);
    const y0 = Math.floor(p.y - 0.5);
    const fx = p.x - 0.5 - x0;
    const fy = p.y - 0.5 - y0;
    return (
      at(x0, y0) * (1 - fx) * (1 - fy) + at(x0 + 1, y0) * fx * (1 - fy) +
      at(x0, y0 + 1) * (1 - fx) * fy + at(x0 + 1, y0 + 1) * fx * fy
    );
  };
  const ground = elevation(0, 0);
  const n = Math.ceil((2 * r) / STEP) + 1;
  const heights: number[] = [];
  const wet: number[] = [];
  const at = (i: number) => -r + i * STEP;
  for (let j = 0; j < n; j++) {
    const y = at(j);
    // Water: even-odd spans of each polygon along this row, any polygon wets a point.
    const row = new Uint8Array(n);
    for (const poly of water) {
      const xs: number[] = [];
      for (const ring of poly) {
        for (let k = 0; k < ring.length - 1; k++) {
          const [x1, y1] = ring[k];
          const [x2, y2] = ring[k + 1];
          if (y1 > y !== y2 > y) xs.push(x1 + ((y - y1) / (y2 - y1)) * (x2 - x1));
        }
      }
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        for (let i = Math.max(0, Math.ceil((xs[k] + r) / STEP)); i < n && at(i) <= xs[k + 1]; i++) row[i] = 1;
      }
    }
    for (let i = 0; i < n; i++) {
      heights.push(Math.round((elevation(at(i), y) - ground) * 10) / 10);
      wet.push(row[i]);
    }
  }
  return { slug: l.slug, radius: r, step: STEP, n, ground, heights, water: wet.join(''), buildings };
}

mkdirSync(OUT, { recursive: true });
for (const l of LANDMARKS) {
  if (ONLY.length && !ONLY.includes(l.slug)) continue;
  const t0 = Date.now();
  const s = await site(l);
  writeFileSync(`${OUT}/${l.slug}.json`, JSON.stringify(s));
  console.log(
    `wrote ${OUT}/${l.slug}.json  ${s.buildings.length} buildings, ${s.n}² grid, ` +
      `${[...s.water].filter((c) => c === '1').length} wet points, ${Date.now() - t0} ms`,
  );
}
