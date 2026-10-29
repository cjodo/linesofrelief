/**
 * Famous buildings: a badge on the map at each, leading to a page at
 * /landmarks/<slug>/ with its clay render (scripts/landmarks.py, in Blender).
 * Heights are published heights in metres, to the tip.
 */

export interface Landmark {
  slug: string;
  name: string;
  city: string;
  country: string;
  lat: number;
  lon: number;
  height: number;
  /** Completed, as it's usually given (a year, or a span). */
  built: string;
  /** Who designed or ordered it. */
  by: string;
  /** A few sentences on what the render shows. */
  about: string;
}

export const landmarkPath = (l: Landmark) => `/landmarks/${l.slug}/`;
export const landmarkRender = (l: Landmark) => `/landmarks/${l.slug}.webp`;
export const landmarkImage = (l: Landmark) => `/og/landmarks/${l.slug}.jpg`;

export const LANDMARKS: Landmark[] = [
  {
    slug: 'eiffel-tower',
    name: 'Eiffel Tower',
    city: 'Paris',
    country: 'France',
    lat: 48.8584,
    lon: 2.2945,
    height: 330,
    built: '1889',
    by: 'Gustave Eiffel',
    about:
      'Four curved legs rise from a 125-metre square, meet at the second floor and run on as one shaft to the top. The great arches under the first floor are decoration: the iron would stand without them.',
  },
  {
    slug: 'great-pyramid-of-giza',
    name: 'Great Pyramid of Giza',
    city: 'Giza',
    country: 'Egypt',
    lat: 29.9792,
    lon: 31.1342,
    height: 139,
    built: 'c. 2560 BC',
    by: 'Pharaoh Khufu',
    about:
      'Built 146.6 metres tall and now 138.5, its sides 230 metres at the base and set within a few arcminutes of north. The three small queens’ pyramids stand in a row along its east side.',
  },
  {
    slug: 'taj-mahal',
    name: 'Taj Mahal',
    city: 'Agra',
    country: 'India',
    lat: 27.1751,
    lon: 78.0421,
    height: 73,
    built: '1653',
    by: 'Shah Jahan',
    about:
      'A mausoleum on a square plinth: chamfered corners, a great pointed iwan on every face, four chhatris round an onion dome on its drum, and a minaret at each corner of the plinth.',
  },
  {
    slug: 'colosseum',
    name: 'Colosseum',
    city: 'Rome',
    country: 'Italy',
    lat: 41.8902,
    lon: 12.4922,
    height: 48,
    built: 'AD 80',
    by: 'Vespasian and Titus',
    about:
      'An ellipse 189 by 156 metres: three storeys of eighty arches under a windowed attic. On the south side the outer ring has fallen, leaving the second ring standing behind it, and the arena floor is open to the hypogeum beneath.',
  },
  {
    slug: 'burj-khalifa',
    name: 'Burj Khalifa',
    city: 'Dubai',
    country: 'United Arab Emirates',
    lat: 25.1972,
    lon: 55.2744,
    height: 828,
    built: '2010',
    by: 'Adrian Smith, at SOM',
    about:
      'Three wings round a hexagonal core, each stepping back in turn so the tower spirals as it narrows, until only the core remains and runs on into the spire.',
  },
  {
    slug: 'sydney-opera-house',
    name: 'Sydney Opera House',
    city: 'Sydney',
    country: 'Australia',
    lat: -33.8568,
    lon: 151.2153,
    height: 65,
    built: '1973',
    by: 'Jørn Utzon',
    about:
      'Two rows of shells on a granite podium, the Concert Hall’s and the Joan Sutherland Theatre’s, with the restaurant’s small pair beside the steps. Every shell is cut from the same sphere.',
  },
];
