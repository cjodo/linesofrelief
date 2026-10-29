/** The words of /why/, kept apart from the markup (site/pages.ts) so they can be edited freely. */

export interface Source {
  name: string;
  url: string;
  /** What the map takes from it. */
  use: string;
  /** Where to give back, when there's someone to give to. */
  donate?: { label: string; url: string };
  /** Said instead, when there isn't. */
  note?: string;
}

export const WHY = {
  title: 'Why',
  lede: 'Most maps try to show you everything. This one shows you the shape of the ground, and almost nothing else.',
  sources: {
    heading: 'Built on open data',
    intro: 'Every line on this map comes from people who share their work freely. If it is useful to you, give back to them.',
    list: [
      {
        name: 'OpenStreetMap',
        url: 'https://www.openstreetmap.org/',
        use: 'Water, borders, place names and museums, mapped by volunteers.',
        donate: { label: 'Donate to the OpenStreetMap Foundation', url: 'https://supporting.openstreetmap.org/' },
      },
      {
        name: 'OpenFreeMap',
        url: 'https://openfreemap.org/',
        use: 'Hosts those map tiles free of charge, in the OpenMapTiles schema.',
        donate: { label: 'Sponsor OpenFreeMap', url: 'https://github.com/sponsors/hyperknot' },
      },
      {
        name: 'Photon',
        url: 'https://github.com/komoot/photon',
        use: 'Search: open source, run by komoot, maintained by Sarah Hoffmann.',
        donate: { label: 'Sponsor its maintainer', url: 'https://github.com/sponsors/lonvia' },
      },
      {
        name: 'Wikipedia and Wikimedia Commons',
        url: 'https://www.wikipedia.org/',
        use: "The museums' write-ups and photographs.",
        donate: { label: 'Donate to Wikimedia', url: 'https://donate.wikimedia.org/' },
      },
      {
        name: 'Terrain Tiles',
        url: 'https://registry.opendata.aws/terrain-tiles/',
        use: 'Every contour: elevation from USGS (SRTM, 3DEP, GMTED2010) and NOAA (ETOPO1), tiled by Mapzen.',
        note: 'Public data from government surveys, free to all.',
      },
    ] satisfies Source[],
  },
};
