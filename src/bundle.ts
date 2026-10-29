import { DEFAULT_ZOOM, DS, INTERVALS, TILE } from './config';
import type { SceneRequest, SceneResult, TileFeatures } from './scene-build';
import type { Geometry, Label } from './tiles';
import { lonLatToWorld } from './tiles';
import { FAVORITES, type Favorite } from '../site/favorites';

/**
 * Favourite places, pre-built: one finished scene per place, made at build
 * time (scripts/favorites.ts) by the same pipeline the browser runs. Arriving
 * at a favourite fetches one small file and draws it: no tile fetches, no PNG
 * decoding, no contour tracing.
 */

/** The screen a bundle is built for (larger screens fill their edges live). */
const VIEW_W = 1920;
const VIEW_H = 1200;
/** Drawn beyond that screen on every side, as live regions are. */
const MARGIN = 256;

export const bundleUrl = (f: Favorite) => `/favorites/${f.slug}.bin`;

/** The region a favourite's bundle covers, as a request for the default zoom. */
export function favoriteRequest(f: Favorite): SceneRequest {
  const { x, y } = lonLatToWorld(f.lon, f.lat, DEFAULT_ZOOM);
  return {
    id: 0,
    z: DEFAULT_ZOOM,
    ds: DS,
    interval: INTERVALS[DEFAULT_ZOOM],
    features: true,
    tx0: Math.floor((x - VIEW_W / 2 - MARGIN) / TILE),
    tx1: Math.floor((x + VIEW_W / 2 + MARGIN) / TILE),
    ty0: Math.floor((y - VIEW_H / 2 - MARGIN) / TILE),
    ty1: Math.floor((y + VIEW_H / 2 + MARGIN) / TILE),
  };
}

/**
 * The favourite whose bundle covers a w×h view centred on (lat, lon) at the
 * default zoom, with `spare` pixels to spare on every side; null if none does.
 */
export function favoriteFor(lat: number, lon: number, w: number, h: number, spare: number) {
  const { x, y } = lonLatToWorld(lon, lat, DEFAULT_ZOOM);
  return (
    FAVORITES.find((f) => {
      const r = favoriteRequest(f);
      return (
        x - w / 2 >= r.tx0 * TILE + spare &&
        y - h / 2 >= r.ty0 * TILE + spare &&
        x + w / 2 <= (r.tx1 + 1) * TILE - spare &&
        y + h / 2 <= (r.ty1 + 1) * TILE - spare
      );
    }) ?? null
  );
}

// --- The file format ---------------------------------------------------------
//
//   "TOPO" · u8 version · 3 pad · u32 header length · header JSON (padded to 4)
//   then, for every geometry in header order: u32 part counts, then i16 x/y
//   deltas of the coordinates quantised to 1/Q unit. Little-endian throughout.
//   Deltas keep consecutive values tiny, which is what compresses well.

const MAGIC = 0x4f504f54; // "TOPO"
const VERSION = 1;
/** Quantisation: 1/16 of a grid cell or tile pixel (≤ 0.125 screen px). */
const Q = 16;

type GeoKey = 'ocean' | 'lake' | 'river' | 'border';
const GEO_KEYS: GeoKey[] = ['ocean', 'lake', 'river', 'border'];

interface Header {
  z: number;
  interval: number;
  originX: number;
  originY: number;
  width: number;
  height: number;
  min: number;
  max: number;
  levels: { value: number; parts: number; points: number }[];
  tiles: ({ ox: number; oy: number; scale: number } & Record<GeoKey, [number, number]>)[];
  labels: Label[];
}

const counts = (g: Geometry): [number, number] => [g.parts.length, g.coords.length / 2];

export function encodeScene(r: SceneResult): Uint8Array {
  const header: Header = {
    z: r.z,
    interval: r.interval,
    originX: r.originX,
    originY: r.originY,
    width: r.width,
    height: r.height,
    min: r.min,
    max: r.max,
    levels: r.levels.map((l) => ({ value: l.value, parts: l.parts.length, points: l.coords.length / 2 })),
    tiles: r.tiles.map((t) => ({
      ox: t.ox,
      oy: t.oy,
      scale: t.scale,
      ocean: counts(t.ocean),
      lake: counts(t.lake),
      river: counts(t.river),
      border: counts(t.border),
    })),
    labels: r.labels,
  };
  const geometries: Geometry[] = [...r.levels, ...r.tiles.flatMap((t) => GEO_KEYS.map((k) => t[k]))];

  const json = new TextEncoder().encode(JSON.stringify(header));
  const jsonPadded = Math.ceil(json.length / 4) * 4;
  const body = geometries.reduce((n, g) => n + g.parts.length * 4 + g.coords.length * 2, 0);
  const out = new Uint8Array(12 + jsonPadded + body);
  const view = new DataView(out.buffer);
  view.setUint32(0, MAGIC, true);
  view.setUint8(4, VERSION);
  view.setUint32(8, json.length, true);
  out.set(json, 12);

  let at = 12 + jsonPadded;
  for (const g of geometries) {
    for (const n of g.parts) {
      view.setUint32(at, n, true);
      at += 4;
    }
    let px = 0;
    let py = 0;
    for (let i = 0; i < g.coords.length; i += 2) {
      const x = Math.round(g.coords[i] * Q);
      const y = Math.round(g.coords[i + 1] * Q);
      const dx = x - px;
      const dy = y - py;
      if (Math.abs(dx) > 32767 || Math.abs(dy) > 32767) throw new Error('coordinate delta out of range');
      view.setInt16(at, dx, true);
      view.setInt16(at + 2, dy, true);
      at += 4;
      px = x;
      py = y;
    }
  }
  return out;
}

export function decodeScene(buf: ArrayBuffer, id: number): SceneResult {
  const view = new DataView(buf);
  if (view.getUint32(0, true) !== MAGIC || view.getUint8(4) !== VERSION) {
    throw new Error('not a scene bundle');
  }
  const jsonLength = view.getUint32(8, true);
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 12, jsonLength))) as Header;

  let at = 12 + Math.ceil(jsonLength / 4) * 4;
  const read = (parts: number, points: number): Geometry => {
    const p = new Uint32Array(parts);
    for (let i = 0; i < parts; i++, at += 4) p[i] = view.getUint32(at, true);
    const c = new Float32Array(points * 2);
    let x = 0;
    let y = 0;
    for (let i = 0; i < c.length; i += 2, at += 4) {
      x += view.getInt16(at, true);
      y += view.getInt16(at + 2, true);
      c[i] = x / Q;
      c[i + 1] = y / Q;
    }
    return { coords: c, parts: p };
  };

  const levels = header.levels.map((l) => ({ value: l.value, ...read(l.parts, l.points) }));
  const tiles: TileFeatures[] = header.tiles.map((t) => {
    const [ocean, lake, river, border] = GEO_KEYS.map((k) => read(t[k][0], t[k][1]));
    return { ox: t.ox, oy: t.oy, scale: t.scale, ocean, lake, river, border };
  });
  return {
    type: 'scene',
    id,
    z: header.z,
    interval: header.interval,
    originX: header.originX,
    originY: header.originY,
    width: header.width,
    height: header.height,
    min: header.min,
    max: header.max,
    levels,
    tiles,
    labels: header.labels,
  };
}
