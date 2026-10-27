import { settable } from './text';

/**
 * The address bar mirrors the view, so any URL is a shareable link:
 *   /?name=Kilimanjaro&lat=-3.0758&lon=37.3533
 * `name` is optional; without it the view is titled by its coordinates.
 *
 * Generated pages (/, /mountains/<slug>/) carry their own place in data-*
 * on <html>; while the view stays there the URL is just the page's path.
 */

export interface Spot {
  name?: string;
  lat: number;
  lon: number;
  /** One line under the title, e.g. "8,849 m · Himalaya · Nepal / China". */
  detail?: string;
}

const MAX_NAME = 80;
/** Web mercator stops short of the poles. */
const MAX_LAT = 85;

export function readSpot(search = location.search): Spot | null {
  const p = new URLSearchParams(search);
  const lat = Number(p.get('lat'));
  const lon = Number(p.get('lon'));
  if (!p.has('lat') || !p.has('lon') || !Number.isFinite(lat) || !Number.isFinite(lon)) {
    return null;
  }
  if (Math.abs(lat) > MAX_LAT || Math.abs(lon) > 180) return null;
  // A name the fonts can't set (or an old link carrying one) is re-resolved.
  const raw = p.get('name')?.trim().slice(0, MAX_NAME);
  const name = raw && settable(raw) ? raw : undefined;
  return { name, lat, lon };
}

/** The place this HTML page was generated for, if any. */
export const pageSpot: Spot | null = (() => {
  const d = document.documentElement.dataset;
  const lat = Number(d.lat);
  const lon = Number(d.lon);
  if (!d.lat || !d.lon || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { name: d.name || undefined, lat, lon, detail: d.detail || undefined };
})();

/** Elsewhere is always expressed from the root, so links don't inherit a summit's path. */
export function spotUrl({ name, lat, lon }: Spot): string {
  const p = new URLSearchParams();
  if (name) p.set('name', name);
  // 4 decimals ≈ 11 m: finer than a pixel at the fixed zoom.
  p.set('lat', lat.toFixed(4));
  p.set('lon', lon.toFixed(4));
  return `${import.meta.env.BASE_URL}?${p}`;
}
