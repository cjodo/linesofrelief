/**
 * Build-time rendering for the static pages: the map at /, a landing page per
 * summit at /mountains/<slug>/ (the same app, arriving at that summit), and
 * the /mountains/ index. Imported by vite.config.ts only.
 */
import { detailOf, PEAKS, type Peak } from './peaks.ts';

export interface Page {
  path: string;
  title: string;
  description: string;
  image: string;
  imageAlt: string;
  jsonLd: unknown[];
  /** Where the map arrives; written to data-* on <html>. */
  spot?: { name: string; lat: number; lon: number; detail?: string };
  /** Text for screen readers and crawlers (the map itself is a canvas). */
  about?: string;
  /** Key of the build-time map images in /prerender/, when they exist. */
  prerender?: string;
}

/**
 * Build-time renders of the map (scripts/prerender.ts), drawn at 1 px per
 * world px so they line up with the live canvas when centred. `sm` covers
 * phones and portrait tablets; `lg` covers desktops up to 1920×1200 (wider
 * screens see the live map fill in the outer edge).
 */
export const PRERENDER = {
  sm: { width: 900, height: 1200, media: '(max-width: 900px)' },
  lg: { width: 1920, height: 1200, media: '(min-width: 901px)' },
} as const;
export const prerenderSrc = (key: string, size: keyof typeof PRERENDER) =>
  `/prerender/${key}-${size}.webp`;

const SITE_NAME = 'Topography';
const fmt = new Intl.NumberFormat('en-US');
const toFeet = (m: number) => Math.round(m * 3.28084);

const esc = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export const peakPath = (p: Peak) => `/mountains/${p.slug}/`;

function distanceKm(a: Peak, b: Peak) {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
}

const nearby = (p: Peak, n = 4) =>
  PEAKS.filter((q) => q !== p)
    .sort((a, b) => distanceKm(p, a) - distanceKm(p, b))
    .slice(0, n);

const link = (p: Peak) => `<a href="${peakPath(p)}">${esc(p.name)}</a>`;

// --- Pages -------------------------------------------------------------------

export function rootPage(
  site: string,
  start: { name: string; lat: number; lon: number },
  hasPrerender = false,
): Page {
  const description =
    'An artistic, dark topographic map. Search any peak, lake, town or country and watch its terrain drawn as contour lines, with rivers, lakes, borders and peaks. Free, no sign-up.';
  return {
    path: '/',
    title: `${SITE_NAME} · Contour maps of any mountain on Earth`,
    description,
    image: '/og.jpg',
    imageAlt:
      'Contour lines of the Three Sisters volcanoes in Oregon, drawn in teal, iris, rose and gold on a dark background',
    spot: start,
    prerender: hasPrerender ? 'home' : undefined,
    jsonLd: [
      {
        '@context': 'https://schema.org',
        '@type': 'WebApplication',
        name: SITE_NAME,
        url: `${site}/`,
        description:
          'An artistic topographic map that draws any mountain or country on Earth as contour lines, with rivers, lakes, borders and peaks.',
        applicationCategory: 'ReferenceApplication',
        operatingSystem: 'Any',
        browserRequirements: 'Requires JavaScript and WebAssembly',
        image: `${site}/og.jpg`,
        offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
      },
    ],
    about:
      `${SITE_NAME} is an artistic topographic map. It draws the terrain of any place on Earth as contour ` +
      'lines every 50 metres, coloured by elevation, with oceans, lakes, rivers, national borders, cities ' +
      'and summits. Search for a mountain, volcano, range or country to travel there, drag to explore, and ' +
      `share a link to any view. <a href="/mountains/">Browse the index of summits</a>.`,
  };
}

export function peakPage(
  p: Peak,
  site: string,
  hasImage: boolean,
  hasPrerender = false,
): Page {
  const url = `${site}${peakPath(p)}`;
  const description =
    `${p.name} (${fmt.format(p.ele)} m), ${p.range}, ${p.country}: an artistic topographic map ` +
    'with contour lines every 50 m, coloured by elevation, plus rivers, lakes and nearby peaks.';
  const image = hasImage ? `/og/${p.slug}.jpg` : '/og.jpg';
  return {
    path: peakPath(p),
    title: `${p.name} contour map · ${fmt.format(p.ele)} m · ${SITE_NAME}`,
    description,
    image,
    imageAlt: `Contour lines of ${p.name}, drawn in teal, iris, rose and gold on a dark background`,
    spot: { name: p.name, lat: p.lat, lon: p.lon, detail: detailOf(p) },
    prerender: hasPrerender ? p.slug : undefined,
    jsonLd: [
      {
        '@context': 'https://schema.org',
        '@type': 'Mountain',
        name: p.name,
        description,
        url,
        image: `${site}${image}`,
        geo: { '@type': 'GeoCoordinates', latitude: p.lat, longitude: p.lon, elevation: p.ele },
        containedInPlace: p.country.split(' / ').map((name) => ({ '@type': 'Country', name })),
      },
      {
        '@context': 'https://schema.org',
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: SITE_NAME, item: `${site}/` },
          { '@type': 'ListItem', position: 2, name: 'Summits', item: `${site}/mountains/` },
          { '@type': 'ListItem', position: 3, name: p.name, item: url },
        ],
      },
    ],
    about:
      `${esc(p.name)} (${esc(p.range)}, ${esc(p.country)}) rises ${fmt.format(p.ele)} metres ` +
      `(${fmt.format(toFeet(p.ele))} ft). This map draws its terrain as contour lines every 50 metres, ` +
      'coloured from teal valleys to a gold summit, with rivers, lakes, borders and neighbouring peaks. ' +
      'Drag to explore, or search for another summit. ' +
      `Nearby: ${nearby(p).map(link).join(', ')}. <a href="/mountains/">All summits</a>.`,
  };
}

export function hubPage(site: string): Page {
  const top = [...PEAKS].sort((a, b) => b.ele - a.ele);
  return {
    path: '/mountains/',
    title: `Index of summits · ${SITE_NAME}`,
    description:
      `Contour maps of ${PEAKS.length} of the world's best-known mountains, from Everest and K2 to ` +
      'Mont Blanc, Kilimanjaro and Mount Fuji, drawn as artistic topographic maps.',
    image: '/og.jpg',
    imageAlt: 'Contour lines drawn in teal, iris, rose and gold on a dark background',
    jsonLd: [
      {
        '@context': 'https://schema.org',
        '@type': 'ItemList',
        name: 'Index of summits',
        itemListElement: top.map((p, i) => ({
          '@type': 'ListItem',
          position: i + 1,
          url: `${site}${peakPath(p)}`,
          name: p.name,
        })),
      },
    ],
  };
}

// --- HTML pieces -------------------------------------------------------------

/** Everything page-specific in <head>. */
/**
 * `version` returns a content hash for a public file: appended to the share
 * image URL so platforms that cache previews for weeks pick up re-renders.
 */
export function headTags(
  page: Page,
  site: string,
  version: (path: string) => string | undefined = () => undefined,
): string {
  const url = `${site}${page.path}`;
  const v = version(page.image);
  const image = `${site}${page.image}${v ? `?v=${v}` : ''}`;
  return [
    `<title>${esc(page.title)}</title>`,
    `<meta name="description" content="${esc(page.description)}" />`,
    `<link rel="canonical" href="${url}" />`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:site_name" content="${SITE_NAME}" />`,
    `<meta property="og:title" content="${esc(page.title)}" />`,
    `<meta property="og:description" content="${esc(page.description)}" />`,
    `<meta property="og:url" content="${url}" />`,
    `<meta property="og:image" content="${image}" />`,
    `<meta property="og:image:type" content="image/jpeg" />`,
    `<meta property="og:image:width" content="1200" />`,
    `<meta property="og:image:height" content="630" />`,
    `<meta property="og:image:alt" content="${esc(page.imageAlt)}" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<meta name="twitter:image" content="${image}" />`,
    `<meta name="twitter:image:alt" content="${esc(page.imageAlt)}" />`,
    // The pre-rendered map is the first paint; fetch it before anything else.
    ...(page.prerender
      ? (Object.keys(PRERENDER) as (keyof typeof PRERENDER)[]).map(
          (size) =>
            `<link rel="preload" as="image" type="image/webp" fetchpriority="high" ` +
            `href="${prerenderSrc(page.prerender!, size)}" media="${PRERENDER[size].media}" />`,
        )
      : []),
    ...page.jsonLd.map(
      // '<' escaped so no string in the data can close the script element.
      (d) => `<script type="application/ld+json">${JSON.stringify(d).replace(/</g, '\\u003c')}</script>`,
    ),
  ]
    .map((line) => `    ${line}`)
    .join('\n');
}

/** The pre-rendered map, centred where the live canvas will draw. */
export function prerenderHtml(page: Page): string {
  if (!page.prerender) return '';
  const { sm, lg } = PRERENDER;
  return [
    '<picture class="prerender" aria-hidden="true">',
    `  <source media="${sm.media}" srcset="${prerenderSrc(page.prerender, 'sm')}" width="${sm.width}" height="${sm.height}" />`,
    `  <img src="${prerenderSrc(page.prerender, 'lg')}" width="${lg.width}" height="${lg.height}" alt="" fetchpriority="high" />`,
    '</picture>',
  ]
    .map((l) => `    ${l}`)
    .join('\n');
}

/** data-* attributes on <html> telling the app where this page arrives. */
export function htmlAttrs(page: Page): string {
  const s = page.spot;
  if (!s) return '';
  const attrs: Record<string, string> = { name: s.name, lat: String(s.lat), lon: String(s.lon) };
  if (s.detail) attrs.detail = s.detail;
  return Object.entries(attrs)
    .map(([k, v]) => ` data-${k}="${esc(v)}"`)
    .join('');
}

/** The /mountains/ index: a typographic list, tallest first. */
export function hubHtml(
  site: string,
  stylesheet: string,
  favicon: string,
  version?: (path: string) => string | undefined,
): string {
  const page = hubPage(site);
  const max = Math.max(...PEAKS.map((p) => p.ele));
  const items = [...PEAKS]
    .sort((a, b) => b.ele - a.ele)
    .map((p) => {
      const pct = ((p.ele / max) * 100).toFixed(1);
      return `
        <li>
          <a href="${peakPath(p)}">
            <span class="name">${esc(p.name)}</span>
            <span class="ele">${fmt.format(p.ele)} m</span>
            <span class="bar" style="--w: ${pct}%; --wn: ${pct}"></span>
            <span class="where">${esc(p.range)} · ${esc(p.country)}</span>
          </a>
        </li>`;
    })
    .join('');
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="theme-color" content="#191724" />
${headTags(page, site, version)}
    ${favicon}
    <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
    <link rel="stylesheet" href="${stylesheet}" />
    <script>
      try {
        var t = Number(localStorage.getItem('topography:text-scale'));
        if ([1.1, 1.2, 1.3].indexOf(t) >= 0) document.documentElement.style.setProperty('--text-scale', t);
      } catch (e) {}
    </script>
    <style>
      html, body { height: auto; overflow: auto; }
      body { padding: max(24px, 6vw) max(16px, 6vw) 96px; }
      .hub { max-width: 920px; margin: 0 auto; }
      .hub .nav { position: static; height: auto; }
      .hub h1 { margin: 40px 0 16px; font: italic 400 clamp(3rem, 10vw, 6.5rem) / 0.92 var(--serif); }
      .hub .lede { max-width: 46ch; font: italic 400 1.2rem/1.45 var(--serif); color: var(--subtle); }
      .hub ol { margin: 56px 0 0; padding: 0; list-style: none; border-top: 1px solid var(--overlay); }
      .hub li a {
        display: grid; grid-template-columns: 1fr auto; gap: 8px 24px; align-items: baseline;
        padding: 20px 0 18px; border-bottom: 1px solid var(--overlay);
        color: inherit; text-decoration: none;
      }
      .hub .name { font: italic 400 clamp(1.5rem, 4vw, 2.1rem) / 1.05 var(--serif); transition: color 0.2s; }
      .hub li a:hover .name, .hub li a:focus-visible .name { color: var(--rose); }
      .hub .ele { font: 400 0.8rem/1 var(--mono); letter-spacing: 0.08em; color: var(--subtle); font-variant-numeric: tabular-nums; }
      .hub .bar {
        grid-column: 1 / -1; height: 2px; width: var(--w); border-radius: 1px;
        /* The full ramp spans the tallest summit; lower peaks show only its lower part. */
        background: linear-gradient(to right, #31748f, #9ccfd8, #c4a7e7, #ebbcba, #f6c177);
        background-size: calc(100% * 100 / var(--wn, 100)) 100%;
      }
      .hub .where {
        grid-column: 1 / -1; font: 400 0.62rem/1.4 var(--mono); letter-spacing: 0.18em;
        text-transform: uppercase; color: var(--muted);
      }
    </style>
  </head>
  <body>
    <main class="hub">
      <nav class="nav" aria-label="Site">
        <a class="brand" href="/">Topography</a>
        <a href="/mountains/" aria-current="page">Summits</a>
      </nav>
      <h1>Summits</h1>
      <p class="lede">${esc(page.description)}</p>
      <ol>${items}
      </ol>
    </main>
  </body>
</html>
`;
}

export function sitemap(site: string, hasImage: (p: Peak) => boolean): string {
  const today = new Date().toISOString().slice(0, 10);
  const urls: { loc: string; image?: string }[] = [
    { loc: `${site}/`, image: `${site}/og.jpg` },
    { loc: `${site}/mountains/` },
    ...PEAKS.map((p) => ({
      loc: `${site}${peakPath(p)}`,
      image: hasImage(p) ? `${site}/og/${p.slug}.jpg` : undefined,
    })),
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">
${urls
  .map(
    (u) =>
      `  <url><loc>${u.loc}</loc><lastmod>${today}</lastmod>` +
      (u.image ? `<image:image><image:loc>${u.image}</image:loc></image:image>` : '') +
      '</url>',
  )
  .join('\n')}
</urlset>
`;
}
