/**
 * Favourite places: each one is pre-built into a single file at build time
 * (`make favorites` → public/favorites/<slug>.bin), so arriving there draws
 * straight away: no tiles to fetch, no PNGs to decode, no contours to trace.
 *
 * Add a place by adding a line. Coordinates are the centre of the view; the
 * pre-built area covers a large screen around it at the place's zoom.
 */

export interface Favorite {
  /** File name of the pre-built scene: public/favorites/<slug>.bin. */
  slug: string;
  name: string;
  lat: number;
  lon: number;
  /** Zoom it opens at (8 widest … 13 closest); defaults to the site's 12. */
  zoom?: number;
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
  { slug: 'sunshine-village', name: 'Sunshine Village', lat: 51.0895, lon: -115.7622 },
  { slug: 'mount-bachelor', name: 'Mount Bachelor', lat: 43.9794, lon: -121.6885 },
  { slug: 'black-tusk', name: 'The Black Tusk', lat: 49.9754, lon: -123.0427 },
  { slug: 'mount-st-helens', name: 'Mount St. Helens', lat: 46.1914, lon: -122.1955 },
  // Whole countries open at the widest scale.
  { slug: 'nepal', name: 'Nepal', lat: 28.378, lon: 84.0, zoom: 8 },
  { slug: 'ethiopia', name: 'Ethiopia', lat: 10.2117, lon: 38.6521, zoom: 8 },
];
