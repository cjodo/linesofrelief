/**
 * Favourite places: each one is pre-built into a single file at build time
 * (`make favorites` → public/favorites/<slug>.bin), so arriving there draws
 * straight away: no tiles to fetch, no PNGs to decode, no contours to trace.
 *
 * Add a place by adding a line. Coordinates are the centre of the view; the
 * pre-built area covers a large screen around it at the default zoom.
 */

export interface Favorite {
  /** File name of the pre-built scene: public/favorites/<slug>.bin. */
  slug: string;
  name: string;
  lat: number;
  lon: number;
  /** Why it's on the list. Not shown anywhere; just for you. */
  note?: string;
}

export const FAVORITES: Favorite[] = [
  {
    slug: 'three-sisters',
    name: 'Three Sisters',
    lat: 51.0208,
    lon: -115.3409,
    note: 'Where every visit begins: above Canmore.',
  },
  { slug: 'lake-louise', name: 'Lake Louise', lat: 51.4115, lon: -116.229 },
  { slug: 'moraine-lake', name: 'Moraine Lake', lat: 51.3216, lon: -116.186 },
  { slug: 'peyto-lake', name: 'Peyto Lake', lat: 51.7252, lon: -116.5223 },
  { slug: 'lake-ohara', name: "Lake O'Hara", lat: 51.3558, lon: -116.3308 },
  { slug: 'mount-assiniboine', name: 'Mount Assiniboine', lat: 50.87, lon: -115.6513 },
];
