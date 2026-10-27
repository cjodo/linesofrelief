/**
 * Summits that get their own landing page at /mountains/<slug>/.
 * Elevations are published heights in metres; coordinates are checked
 * against the elevation tiles by scripts/verify-peaks.ts.
 *
 * Antarctic summits are left out on purpose: the tiles' coverage there is
 * coarse enough to draw Vinson ~2,000 m too low.
 */

export interface Peak {
  slug: string;
  name: string;
  ele: number;
  range: string;
  country: string;
  lat: number;
  lon: number;
}

/** One line under a summit's name, e.g. "8,849 m · Himalaya · Nepal / China". */
export const detailOf = (p: Peak) =>
  `${new Intl.NumberFormat('en-US').format(p.ele)} m · ${p.range} · ${p.country}`;

export const PEAKS: Peak[] = [
  { slug: 'everest', name: 'Mount Everest', ele: 8849, range: 'Himalaya', country: 'Nepal / China', lat: 27.9881, lon: 86.925 },
  { slug: 'k2', name: 'K2', ele: 8611, range: 'Karakoram', country: 'Pakistan / China', lat: 35.8825, lon: 76.5133 },
  { slug: 'kangchenjunga', name: 'Kangchenjunga', ele: 8586, range: 'Himalaya', country: 'Nepal / India', lat: 27.7025, lon: 88.1475 },
  { slug: 'lhotse', name: 'Lhotse', ele: 8516, range: 'Himalaya', country: 'Nepal / China', lat: 27.9617, lon: 86.9333 },
  { slug: 'makalu', name: 'Makalu', ele: 8485, range: 'Himalaya', country: 'Nepal / China', lat: 27.8897, lon: 87.0889 },
  { slug: 'cho-oyu', name: 'Cho Oyu', ele: 8188, range: 'Himalaya', country: 'Nepal / China', lat: 28.0942, lon: 86.6608 },
  { slug: 'dhaulagiri', name: 'Dhaulagiri', ele: 8167, range: 'Himalaya', country: 'Nepal', lat: 28.6967, lon: 83.4875 },
  { slug: 'manaslu', name: 'Manaslu', ele: 8163, range: 'Himalaya', country: 'Nepal', lat: 28.5497, lon: 84.5597 },
  { slug: 'nanga-parbat', name: 'Nanga Parbat', ele: 8126, range: 'Himalaya', country: 'Pakistan', lat: 35.2375, lon: 74.5892 },
  { slug: 'annapurna', name: 'Annapurna', ele: 8091, range: 'Himalaya', country: 'Nepal', lat: 28.5961, lon: 83.8203 },
  { slug: 'ama-dablam', name: 'Ama Dablam', ele: 6812, range: 'Himalaya', country: 'Nepal', lat: 27.8617, lon: 86.8614 },
  { slug: 'kailash', name: 'Mount Kailash', ele: 6638, range: 'Gangdisê Mountains', country: 'China', lat: 31.0675, lon: 81.3119 },
  { slug: 'aconcagua', name: 'Aconcagua', ele: 6961, range: 'Andes', country: 'Argentina', lat: -32.6532, lon: -70.0109 },
  { slug: 'huascaran', name: 'Huascarán', ele: 6768, range: 'Cordillera Blanca', country: 'Peru', lat: -9.1219, lon: -77.6044 },
  { slug: 'chimborazo', name: 'Chimborazo', ele: 6263, range: 'Andes', country: 'Ecuador', lat: -1.4692, lon: -78.8175 },
  { slug: 'cotopaxi', name: 'Cotopaxi', ele: 5897, range: 'Andes', country: 'Ecuador', lat: -0.6838, lon: -78.4378 },
  { slug: 'fitz-roy', name: 'Fitz Roy', ele: 3405, range: 'Patagonian Andes', country: 'Argentina / Chile', lat: -49.2714, lon: -73.0431 },
  { slug: 'denali', name: 'Denali', ele: 6190, range: 'Alaska Range', country: 'United States', lat: 63.0695, lon: -151.0074 },
  { slug: 'mount-logan', name: 'Mount Logan', ele: 5959, range: 'Saint Elias Mountains', country: 'Canada', lat: 60.5672, lon: -140.4055 },
  { slug: 'pico-de-orizaba', name: 'Pico de Orizaba', ele: 5636, range: 'Trans-Mexican Volcanic Belt', country: 'Mexico', lat: 19.0303, lon: -97.2681 },
  { slug: 'mount-whitney', name: 'Mount Whitney', ele: 4421, range: 'Sierra Nevada', country: 'United States', lat: 36.5785, lon: -118.2923 },
  { slug: 'mount-rainier', name: 'Mount Rainier', ele: 4392, range: 'Cascade Range', country: 'United States', lat: 46.8529, lon: -121.7604 },
  { slug: 'mount-shasta', name: 'Mount Shasta', ele: 4322, range: 'Cascade Range', country: 'United States', lat: 41.4092, lon: -122.1949 },
  { slug: 'grand-teton', name: 'Grand Teton', ele: 4199, range: 'Teton Range', country: 'United States', lat: 43.741, lon: -110.8024 },
  { slug: 'mount-robson', name: 'Mount Robson', ele: 3954, range: 'Canadian Rockies', country: 'Canada', lat: 53.1105, lon: -119.1561 },
  { slug: 'mount-columbia', name: 'Mount Columbia', ele: 3747, range: 'Canadian Rockies', country: 'Canada', lat: 52.1471, lon: -117.4416 },
  { slug: 'mount-alberta', name: 'Mount Alberta', ele: 3619, range: 'Canadian Rockies', country: 'Canada', lat: 52.288, lon: -117.4764 },
  { slug: 'mount-assiniboine', name: 'Mount Assiniboine', ele: 3618, range: 'Canadian Rockies', country: 'Canada', lat: 50.87, lon: -115.6513 },
  { slug: 'mount-forbes', name: 'Mount Forbes', ele: 3612, range: 'Canadian Rockies', country: 'Canada', lat: 51.86, lon: -116.9319 },
  { slug: 'mount-temple', name: 'Mount Temple', ele: 3544, range: 'Canadian Rockies', country: 'Canada', lat: 51.3511, lon: -116.2065 },
  { slug: 'mount-athabasca', name: 'Mount Athabasca', ele: 3491, range: 'Canadian Rockies', country: 'Canada', lat: 52.1812, lon: -117.1999 },
  { slug: 'mount-victoria', name: 'Mount Victoria', ele: 3464, range: 'Canadian Rockies', country: 'Canada', lat: 51.3775, lon: -116.3077 },
  { slug: 'mount-joffre', name: 'Mount Joffre', ele: 3450, range: 'Canadian Rockies', country: 'Canada', lat: 50.5284, lon: -115.2069 },
  { slug: 'mount-edith-cavell', name: 'Mount Edith Cavell', ele: 3363, range: 'Canadian Rockies', country: 'Canada', lat: 52.6673, lon: -118.0572 },
  { slug: 'cascade-mountain', name: 'Cascade Mountain', ele: 2998, range: 'Canadian Rockies', country: 'Canada', lat: 51.229, lon: -115.5629 },
  { slug: 'mount-rundle', name: 'Mount Rundle', ele: 2949, range: 'Canadian Rockies', country: 'Canada', lat: 51.1246, lon: -115.4692 },
  { slug: 'mount-hood', name: 'Mount Hood', ele: 3429, range: 'Cascade Range', country: 'United States', lat: 45.3736, lon: -121.696 },
  { slug: 'three-sisters', name: 'Three Sisters', ele: 3157, range: 'Cascade Range', country: 'United States', lat: 44.135, lon: -121.772 },
  { slug: 'mount-st-helens', name: 'Mount St. Helens', ele: 2549, range: 'Cascade Range', country: 'United States', lat: 46.1914, lon: -122.1956 },
  { slug: 'half-dome', name: 'Half Dome', ele: 2694, range: 'Sierra Nevada', country: 'United States', lat: 37.7459, lon: -119.5332 },
  { slug: 'elbrus', name: 'Mount Elbrus', ele: 5642, range: 'Caucasus', country: 'Russia', lat: 43.3499, lon: 42.4453 },
  { slug: 'ararat', name: 'Mount Ararat', ele: 5137, range: 'Armenian Highlands', country: 'Turkey', lat: 39.7019, lon: 44.2983 },
  { slug: 'mont-blanc', name: 'Mont Blanc', ele: 4806, range: 'Alps', country: 'France / Italy', lat: 45.8326, lon: 6.8652 },
  { slug: 'matterhorn', name: 'Matterhorn', ele: 4478, range: 'Alps', country: 'Switzerland / Italy', lat: 45.9763, lon: 7.6586 },
  { slug: 'eiger', name: 'Eiger', ele: 3967, range: 'Alps', country: 'Switzerland', lat: 46.5776, lon: 8.0053 },
  { slug: 'zugspitze', name: 'Zugspitze', ele: 2962, range: 'Alps', country: 'Germany / Austria', lat: 47.4211, lon: 10.9853 },
  { slug: 'etna', name: 'Mount Etna', ele: 3357, range: 'Sicily', country: 'Italy', lat: 37.751, lon: 14.9934 },
  { slug: 'olympus', name: 'Mount Olympus', ele: 2918, range: 'Olympus Range', country: 'Greece', lat: 40.0859, lon: 22.3583 },
  { slug: 'ben-nevis', name: 'Ben Nevis', ele: 1345, range: 'Grampian Mountains', country: 'United Kingdom', lat: 56.7969, lon: -5.0036 },
  { slug: 'kilimanjaro', name: 'Kilimanjaro', ele: 5895, range: 'Eastern Rift', country: 'Tanzania', lat: -3.0758, lon: 37.3533 },
  { slug: 'mount-kenya', name: 'Mount Kenya', ele: 5199, range: 'Eastern Rift', country: 'Kenya', lat: -0.1521, lon: 37.3084 },
  { slug: 'table-mountain', name: 'Table Mountain', ele: 1085, range: 'Cape Fold Belt', country: 'South Africa', lat: -33.9628, lon: 18.4098 },
  { slug: 'mount-fuji', name: 'Mount Fuji', ele: 3776, range: 'Fuji Volcanic Zone', country: 'Japan', lat: 35.3606, lon: 138.7274 },
  { slug: 'puncak-jaya', name: 'Puncak Jaya', ele: 4884, range: 'Sudirman Range', country: 'Indonesia', lat: -4.0789, lon: 137.158 },
  { slug: 'aoraki', name: 'Aoraki / Mount Cook', ele: 3724, range: 'Southern Alps', country: 'New Zealand', lat: -43.595, lon: 170.1418 },
  { slug: 'kosciuszko', name: 'Mount Kosciuszko', ele: 2228, range: 'Snowy Mountains', country: 'Australia', lat: -36.4559, lon: 148.2636 },
];
