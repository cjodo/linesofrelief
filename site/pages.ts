/**
 * Build-time rendering for the static pages: the map at /, a landing page per
 * summit at /mountains/<slug>/ (the same app, arriving at that summit), the
 * /mountains/ index and /why/. Imported by vite.config.ts only.
 */
import { FAVORITES } from './favorites.ts';
import { detailOf, PEAKS, type Peak } from './peaks.ts';
import { WHY } from './why.ts';

export interface Page {
  path: string;
  /** Where search engines should look instead (a summit's map → its summary). */
  canonical?: string;
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

/** A summit's summary page (canonical) and its live map. */
export const peakPath = (p: Peak) => `/mountains/${p.slug}/`;
export const mapPath = (p: Peak) => `/mountains/${p.slug}/map/`;

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
      'Contour lines of the Three Sisters above Canmore, Alberta, drawn in teal, iris, rose and gold on a dark background',
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

/** The live map arriving at a summit; its summary is the canonical page. */
export function peakPage(p: Peak, hasImage: boolean, hasPrerender = false): Page {
  return {
    path: mapPath(p),
    canonical: peakPath(p),
    title: `${p.name} live contour map · ${SITE_NAME}`,
    description: summitDescription(p),
    image: hasImage ? `/og/${p.slug}.jpg` : '/og.jpg',
    imageAlt: `Contour lines of ${p.name}, drawn in teal, iris, rose and gold on a dark background`,
    spot: { name: p.name, lat: p.lat, lon: p.lon, detail: detailOf(p) },
    prerender: hasPrerender ? p.slug : undefined,
    jsonLd: [],
    about:
      `The live contour map of ${esc(p.name)}: drag to explore, or search for another summit. ` +
      `<a href="${peakPath(p)}">About ${esc(p.name)}</a>. ` +
      `Nearby: ${nearby(p).map(link).join(', ')}. <a href="/mountains/">All summits</a>.`,
  };
}

const summitDescription = (p: Peak) =>
  `${p.name} (${fmt.format(p.ele)} m), ${p.range}, ${p.country}: an artistic topographic map ` +
  'with contour lines every 50 m, coloured by elevation, plus rivers, lakes and nearby peaks.';

/** A summit's summary page: the canonical page for the peak. */
export function summaryPage(p: Peak, site: string, hasImage: boolean): Page {
  const url = `${site}${peakPath(p)}`;
  const description = summitDescription(p);
  const image = hasImage ? `/og/${p.slug}.jpg` : '/og.jpg';
  return {
    path: peakPath(p),
    title: `${p.name} contour map · ${fmt.format(p.ele)} m · ${SITE_NAME}`,
    description,
    image,
    imageAlt: `Contour lines of ${p.name}, drawn in teal, iris, rose and gold on a dark background`,
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

export function whyPage(site: string): Page {
  return {
    path: '/why/',
    title: `Why · ${SITE_NAME}`,
    description: WHY.lede,
    image: '/og.jpg',
    imageAlt: 'Contour lines drawn in teal, iris, rose and gold on a dark background',
    jsonLd: [
      {
        '@context': 'https://schema.org',
        '@type': 'AboutPage',
        name: `Why ${SITE_NAME}`,
        url: `${site}/why/`,
        description: WHY.lede,
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
  const url = `${site}${page.canonical ?? page.path}`;
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

// --- Analytics -------------------------------------------------------------

let tagId = '';
/**
 * Embed a Google tag in every page: a Tag Manager container (GTM-…) or a GA4
 * measurement ID (G-…); '' leaves it out entirely.
 */
export function useAnalytics(id: string) {
  tagId = id;
}

/**
 * The Google tag, behind a consent banner. Nothing from Google loads until the
 * visitor says yes; the answer is remembered per browser, and a "Cookies"
 * link (shown only when analytics is built in) reopens the question. Once
 * allowed, the script loads 1.5 s after the page, never delaying the map;
 * events queue in dataLayer until then. History changes (searches,
 * favourites) are page views through GA4's enhanced measurement.
 */
export function analyticsHtml(): string {
  if (!tagId) return '';
  const gtm = tagId.startsWith('GTM-');
  const src = gtm
    ? `https://www.googletagmanager.com/gtm.js?id=${tagId}`
    : `https://www.googletagmanager.com/gtag/js?id=${tagId}`;
  return `    <script>
      (function () {
        var KEY = 'topography:consent';
        window.dataLayer = window.dataLayer || [];
        window.gtag = function () { dataLayer.push(arguments); };
        gtag('js', new Date());
        ${gtm ? "window.topoAnalytics = 'gtm';" : `gtag('config', '${tagId}');`}
        document.documentElement.classList.add('consent');

        var loaded = false;
        function load() {
          if (loaded) return;
          loaded = true;
          var go = function () {
            setTimeout(function () {
              var s = document.createElement('script');
              s.async = true;
              s.src = '${src}';
              document.head.appendChild(s);
            }, 1500);
          };
          if (document.readyState === 'complete') go();
          else addEventListener('load', go);
        }
        function get() { try { return localStorage.getItem(KEY); } catch (e) { return null; } }
        function set(v) { try { localStorage.setItem(KEY, v); } catch (e) {} }
        function forget() {
          // Clear Google's first-party cookies (_ga, _ga_XXXX) on this host and its parent.
          document.cookie.split(';').forEach(function (c) {
            var name = c.split('=')[0].trim();
            if (!/^_ga/.test(name)) return;
            var host = location.hostname;
            [host, '.' + host, '.' + host.split('.').slice(-2).join('.')].forEach(function (d) {
              document.cookie = name + '=; Max-Age=0; path=/; domain=' + d;
            });
            document.cookie = name + '=; Max-Age=0; path=/';
          });
        }

        var card;
        function ask() {
          if (card) { card.classList.add('on'); return; }
          card = document.createElement('section');
          card.className = 'consent-card';
          card.setAttribute('role', 'region');
          card.setAttribute('aria-label', 'Cookie consent');
          card.innerHTML =
            '<h2>Cookies, briefly</h2>' +
            '<p>Topography would like to use Google Analytics to see which places people explore. ' +
            'It sets cookies only if you say yes, and you can change your mind any time from ' +
            '<em>Cookies</em> at the bottom of the page.</p>' +
            '<div class="consent-actions">' +
            '<button type="button" class="consent-yes">Allow analytics</button>' +
            '<button type="button" class="consent-no">No thanks</button></div>';
          card.querySelector('.consent-yes').addEventListener('click', function () {
            set('granted');
            close();
            load();
          });
          card.querySelector('.consent-no').addEventListener('click', function () {
            var was = get();
            set('denied');
            forget();
            close();
            if (was === 'granted' && loaded) location.reload(); // stop the running tag
          });
          document.body.appendChild(card);
          requestAnimationFrame(function () { requestAnimationFrame(function () { card.classList.add('on'); }); });
        }
        function close() { if (card) card.classList.remove('on'); }

        document.addEventListener('click', function (e) {
          var t = e.target.closest && e.target.closest('[data-consent]');
          if (!t) return;
          e.preventDefault();
          ask();
        });

        var choice = get();
        if (choice === 'granted') load();
        else if (choice !== 'denied') {
          // Ask a moment after the page (and the map) have appeared.
          var later = function () { setTimeout(ask, 1800); };
          if (document.readyState === 'complete') later();
          else addEventListener('load', later);
        }
      })();
    </script>`;
}

/**
 * The creator's favourites in the nav: a native disclosure, so it works without
 * script; on the map, picking one arrives there without a reload.
 */
export function favoritesNav(): string {
  const items = FAVORITES.map((f) => {
    const q = new URLSearchParams({ name: f.name, lat: String(f.lat), lon: String(f.lon) });
    if (f.zoom !== undefined) q.set('z', String(f.zoom));
    return `<li><a href="/?${esc(q.toString())}" data-favorite>${esc(f.name)}</a></li>`;
  }).join('');
  return `<details class="favs">
          <summary>Favourites</summary>
          <div class="favs-panel">
            <p>The creator's favourites</p>
            <ul>${items}</ul>
          </div>
        </details>`;
}

// --- Static pages (index, summaries): no app script, the server only serves files

/** Styles shared by the index and the summaries, on top of the site stylesheet. */
const PAGE_CSS = `
      /* Scroll like a document. The map's overflow: hidden and overscroll-behavior:
         none (no rubber-banding) would otherwise trap the wheel on these pages. */
      html, body { height: auto; overflow: visible; overscroll-behavior: auto; }
      body { padding: max(24px, 6vw) max(16px, 6vw) 96px; }
      .page { max-width: 920px; margin: 0 auto; }
      .page .nav { position: static; height: auto; flex-wrap: wrap; row-gap: 12px; }
      .page h1 { margin: 40px 0 16px; font: italic 400 clamp(3rem, 10vw, 6.5rem) / 0.92 var(--serif); }
      .page h2 {
        margin: 72px 0 18px; font: 400 0.68rem/1 var(--mono); letter-spacing: 0.24em;
        text-transform: uppercase; color: var(--subtle);
      }
      .page .lede { max-width: 46ch; font: italic 400 1.2rem/1.45 var(--serif); color: var(--subtle); }
      .page a { color: inherit; }
      .list { margin: 0; padding: 0; list-style: none; border-top: 1px solid var(--overlay); }
      .list li a {
        display: grid; grid-template-columns: 1fr auto; gap: 8px 24px; align-items: baseline;
        padding: 20px 0 18px; border-bottom: 1px solid var(--overlay); text-decoration: none;
      }
      .list .name { font: italic 400 clamp(1.5rem, 4vw, 2.1rem) / 1.05 var(--serif); transition: color 0.2s; }
      .list li a:hover .name, .list li a:focus-visible .name { color: var(--rose); }
      .list li a[aria-current] .name { color: var(--gold); }
      .list .ele { font: 400 0.8rem/1 var(--mono); letter-spacing: 0.08em; color: var(--subtle); font-variant-numeric: tabular-nums; }
      .list .bar {
        grid-column: 1 / -1; height: 2px; width: var(--w); border-radius: 1px;
        /* The full ramp spans the tallest summit; lower peaks show only its lower part. */
        background: linear-gradient(to right, #31748f, #9ccfd8, #c4a7e7, #ebbcba, #f6c177);
        background-size: calc(100% * 100 / var(--wn, 100)) 100%;
      }
      .list .where {
        grid-column: 1 / -1; font: 400 0.62rem/1.4 var(--mono); letter-spacing: 0.18em;
        text-transform: uppercase; color: var(--muted);
      }
      /* Summary */
      .hero { position: relative; margin: 32px calc(-1 * max(16px, 6vw)) 0; }
      .hero img { display: block; width: 100%; height: min(62vh, 560px); object-fit: cover; }
      .hero::after {
        content: ''; position: absolute; inset: 0; pointer-events: none;
        background: linear-gradient(to bottom, transparent 45%, var(--base) 98%);
      }
      .hero-text { position: relative; z-index: 1; margin-top: -9rem; text-shadow: 0 0 24px var(--base), 0 0 8px var(--base); }
      .hero-text .eyebrow, .facts dt, .page footer, .near .dist {
        font: 400 0.66rem/1.4 var(--mono); letter-spacing: 0.22em; text-transform: uppercase; color: var(--subtle);
      }
      .hero-text h1 { margin: 12px 0 10px; }
      .hero-text .detail { font: italic 400 1.35rem/1.3 var(--serif); color: var(--subtle); }
      .cta {
        display: inline-flex; align-items: center; gap: 10px; margin-top: 26px; padding: 13px 20px;
        border: 1px solid color-mix(in srgb, var(--rose) 45%, var(--overlay)); border-radius: 2px;
        background: color-mix(in srgb, var(--surface) 82%, transparent);
        font: 400 0.72rem/1 var(--mono); letter-spacing: 0.2em; text-transform: uppercase;
        color: var(--text); text-decoration: none; text-shadow: none; transition: color 0.2s, border-color 0.2s;
      }
      .cta:hover, .cta:focus-visible { color: var(--rose); border-color: var(--rose); outline: none; }
      .facts {
        display: grid; grid-template-columns: repeat(auto-fit, minmax(9.5rem, 1fr)); gap: 28px 32px;
        margin: 64px 0 0; padding: 28px 0; border-top: 1px solid var(--overlay); border-bottom: 1px solid var(--overlay);
      }
      .facts dd { margin: 10px 0 0; font: italic 400 1.45rem/1.15 var(--serif); }
      .facts dd small { display: block; margin-top: 6px; font: 400 0.66rem/1.3 var(--mono); letter-spacing: 0.08em; font-style: normal; color: var(--subtle); }
      .prose { max-width: 60ch; margin-top: 48px; }
      .prose p { margin: 0 0 1.1em; font: italic 400 1.3rem/1.5 var(--serif); color: color-mix(in srgb, var(--text) 88%, var(--subtle)); }
      .prose a { text-decoration-color: color-mix(in srgb, var(--rose) 60%, transparent); text-underline-offset: 3px; }
      /* /why/: the words on the left, the globe turning beside them (above, on phones). */
      .why { display: grid; gap: 8px; }
      .why-globe { margin: 24px 0 0; }
      .why-globe canvas { display: block; width: min(72vw, 320px); aspect-ratio: 1; margin: 0 auto; }
      /* Where the data comes from, and where to give back. */
      .sources { max-width: 60ch; margin-top: 64px; }
      .sources-intro { margin: 0 0 24px; font: italic 400 1.15rem/1.5 var(--serif); color: var(--subtle); }
      .sources ul { list-style: none; padding: 0; margin: 0; border-top: 1px solid var(--overlay); }
      .sources li { padding: 18px 0 20px; border-bottom: 1px solid var(--overlay); }
      .sources .name { font: italic 400 1.45rem/1.15 var(--serif); color: var(--text); text-decoration: none; }
      .sources .name:hover { text-decoration: underline; text-decoration-color: color-mix(in srgb, var(--rose) 60%, transparent); text-underline-offset: 3px; }
      .sources .use { margin: 6px 0 10px; font: 400 0.98rem/1.45 var(--serif); color: var(--subtle); }
      .sources .give { font: 400 0.62rem/1.4 var(--mono); letter-spacing: 0.14em; text-transform: uppercase; color: var(--gold); text-decoration: none; }
      .sources a.give:hover { text-decoration: underline; text-underline-offset: 3px; }
      .sources .give.none { margin: 0; color: var(--muted); }
      @media (min-width: 1000px) {
        .why { grid-template-columns: minmax(0, 60ch) 1fr; column-gap: 64px; align-items: start; }
        .why-globe { grid-column: 2; grid-row: 1; position: sticky; top: 96px; margin-top: 72px; }
        .why-globe canvas { width: min(100%, 460px); }
        .why-text { grid-column: 1; grid-row: 1; }
      }
      .near { margin: 0; padding: 0; list-style: none; display: grid; gap: 0; border-top: 1px solid var(--overlay); }
      .near li a {
        display: flex; justify-content: space-between; align-items: baseline; gap: 16px;
        padding: 16px 0; border-bottom: 1px solid var(--overlay); text-decoration: none;
      }
      .near .name { font: italic 400 1.4rem/1.1 var(--serif); transition: color 0.2s; }
      .near li a:hover .name { color: var(--rose); }
      .page footer { display: flex; flex-wrap: wrap; gap: 14px 28px; align-items: center; margin-top: 80px; padding-top: 28px; border-top: 1px solid var(--overlay); }
      .page footer a { text-decoration: none; color: var(--text); }
      .page footer a:hover { color: var(--rose); }
      .page footer .credits { flex-basis: 100%; color: var(--muted); letter-spacing: 0.08em; text-transform: none; }
`;

const CREDITS =
  'Elevation: AWS Terrain Tiles · Map data © OpenStreetMap contributors, © OpenMapTiles, via OpenFreeMap';

interface Shell {
  page: Page;
  site: string;
  stylesheet: string;
  favicon: string;
  version?: (path: string) => string | undefined;
  /** The nav's current item: the index, /why/, or a summit (with a link to its map). */
  current: 'summits' | 'why' | Peak;
  body: string;
}

function shell({ page, site, stylesheet, favicon, version, current, body }: Shell): string {
  const summit = typeof current === 'string' ? null : current;
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
    <style>${PAGE_CSS}    </style>
${analyticsHtml()}
  </head>
  <body>
    <main class="page">
      <nav class="nav" aria-label="Site">
        <a class="brand" href="/">Topography</a>
        <a href="/mountains/"${current === 'summits' ? ' aria-current="page"' : ''}>Summits</a>
        <a href="/why/"${current === 'why' ? ' aria-current="page"' : ''}>Why</a>
        ${favoritesNav()}
        ${summit ? `<a href="${mapPath(summit)}">Live map</a>` : ''}
      </nav>
${body}
      <footer>
        <a href="/">Search the whole world →</a>
        <a href="/mountains/">Summits</a>
        <a href="/why/">Why this map</a>
        ${summit ? `<a href="${mapPath(summit)}">${esc(summit.name)} on the live map</a>` : ''}
        <a href="#" class="consent-link" data-consent>Cookies</a>
        <span class="credits">${CREDITS}</span>
      </footer>
    </main>
  </body>
</html>
`;
}

/** One summit as a row: name, elevation, its share of the elevation ramp, where. */
function summitRow(p: Peak, max: number, current?: Peak) {
  const pct = ((p.ele / max) * 100).toFixed(1);
  return `
        <li>
          <a href="${peakPath(p)}"${p === current ? ' aria-current="page"' : ''}>
            <span class="name">${esc(p.name)}</span>
            <span class="ele">${fmt.format(p.ele)} m</span>
            <span class="bar" style="--w: ${pct}%; --wn: ${pct}"></span>
            <span class="where">${esc(p.range)} · ${esc(p.country)}</span>
          </a>
        </li>`;
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
  const rows = [...PEAKS].sort((a, b) => b.ele - a.ele).map((p) => summitRow(p, max)).join('');
  return shell({
    page,
    site,
    stylesheet,
    favicon,
    version,
    current: 'summits',
    body: `      <h1>Summits</h1>
      <p class="lede">${esc(page.description)}</p>
      <ol class="list" style="margin-top: 56px">${rows}
      </ol>`,
  });
}

/** The globe's pre-rendered world texture (scripts/globe.ts, `make globe`). */
const GLOBE_TEXTURE = '/globe.png';

/**
 * /why/: a line on why (the words live in site/why.ts) beside the Earth's
 * contours slowly turning. `script` is the globe's module (src/globe-page.ts,
 * bundled).
 */
export function whyHtml(
  site: string,
  stylesheet: string,
  favicon: string,
  script: string,
  version?: (path: string) => string | undefined,
): string {
  return shell({
    page: whyPage(site),
    site,
    stylesheet,
    favicon,
    version,
    current: 'why',
    body: `      <div class="why">
      <figure class="why-globe">
        <canvas class="globe" data-texture="${GLOBE_TEXTURE}" role="img"
          aria-label="The Earth's contours, coloured by height, slowly turning"></canvas>
      </figure>
      <div class="why-text">
      <h1>${esc(WHY.title)}</h1>
      <p class="lede">${esc(WHY.lede)}</p>
      <section class="sources">
        <h2>${esc(WHY.sources.heading)}</h2>
        <p class="sources-intro">${esc(WHY.sources.intro)}</p>
        <ul>${WHY.sources.list
          .map(
            (src) => `
          <li>
            <a class="name" href="${esc(src.url)}">${esc(src.name)}</a>
            <p class="use">${esc(src.use)}</p>
            ${
              src.donate
                ? `<a class="give" href="${esc(src.donate.url)}">${esc(src.donate.label)} ↗</a>`
                : `<p class="give none">${esc(src.note ?? '')}</p>`
            }
          </li>`,
          )
          .join('')}
        </ul>
      </section>
      </div>
      </div>
      <script type="module" src="${script}"></script>`,
  });
}

// --- Summary facts, from the data only -----------------------------------------

const ordinal = (n: number) => {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
};

function dms(value: number, pos: string, neg: string) {
  const a = Math.abs(value);
  const d = Math.floor(a);
  const m = Math.floor((a - d) * 60);
  const sec = Math.round(((a - d) * 60 - m) * 60);
  return `${d}° ${String(m).padStart(2, '0')}′ ${String(sec).padStart(2, '0')}″ ${value >= 0 ? pos : neg}`;
}

/** Initial compass bearing from a to b, as one of eight points. */
function bearing(a: Peak, b: Peak) {
  const rad = Math.PI / 180;
  const y = Math.sin((b.lon - a.lon) * rad) * Math.cos(b.lat * rad);
  const x =
    Math.cos(a.lat * rad) * Math.sin(b.lat * rad) -
    Math.sin(a.lat * rad) * Math.cos(b.lat * rad) * Math.cos((b.lon - a.lon) * rad);
  const deg = (Math.atan2(y, x) / rad + 360) % 360;
  return ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'][
    Math.round(deg / 45) % 8
  ];
}

/** A summit's summary: what it is, where, its neighbours, and the way back to the map. */
export function summaryHtml(
  p: Peak,
  site: string,
  stylesheet: string,
  favicon: string,
  version: ((path: string) => string | undefined) | undefined,
  hasImage: boolean,
  hasPrerender: boolean,
): string {
  const page = summaryPage(p, site, hasImage);
  const byHeight = [...PEAKS].sort((a, b) => b.ele - a.ele);
  const rank = byHeight.indexOf(p) + 1;
  const max = byHeight[0].ele;
  const peers = byHeight.filter((q) => q.range === p.range);
  const near = nearby(p);
  const closest = near[0];
  const km = (q: Peak) => fmt.format(Math.round(distanceKm(p, q)));

  const hero = hasPrerender
    ? `<picture>
          <source media="${PRERENDER.sm.media}" srcset="${prerenderSrc(p.slug, 'sm')}" />
          <img src="${prerenderSrc(p.slug, 'lg')}" alt="Contour map of ${esc(p.name)}" fetchpriority="high" />
        </picture>`
    : `<img src="/og/${p.slug}.jpg" alt="Contour map of ${esc(p.name)}" fetchpriority="high" />`;

  const body = `      <header>
        <div class="hero">
        ${hero}
        </div>
        <div class="hero-text">
          <p class="eyebrow">${esc(p.range)} · ${esc(p.country)}</p>
          <h1>${esc(p.name)}</h1>
          <p class="detail">${fmt.format(p.ele)} metres · ${fmt.format(toFeet(p.ele))} feet</p>
          <a class="cta" href="${mapPath(p)}">Open the live map →</a>
        </div>
      </header>

      <dl class="facts">
        <div><dt>Elevation</dt><dd>${fmt.format(p.ele)} m<small>${fmt.format(toFeet(p.ele))} ft</small></dd></div>
        <div><dt>Range</dt><dd>${esc(p.range)}</dd></div>
        <div><dt>Country</dt><dd>${esc(p.country)}</dd></div>
        <div><dt>Coordinates</dt><dd>${dms(p.lat, 'N', 'S')}<small>${dms(p.lon, 'E', 'W')} · ${p.lat.toFixed(4)}, ${p.lon.toFixed(4)}</small></dd></div>
        <div><dt>In this index</dt><dd>${ordinal(rank)} highest<small>of ${PEAKS.length} summits</small></dd></div>
      </dl>

      <section class="prose">
        <p>${esc(p.name)} stands ${fmt.format(p.ele)} metres above the sea, in the ${esc(p.range)} of ${esc(p.country)}:
        the ${ordinal(rank)} highest of the ${PEAKS.length} summits in this index. Its nearest neighbour here is
        <a href="${peakPath(closest)}">${esc(closest.name)}</a>, ${km(closest)} km to the ${bearing(p, closest)}.</p>
        <p>Topography draws it the way it draws everything: contour lines every 50 metres, coloured from teal
        valleys to a gold summit, with water, borders and names, and nothing else. No satellite imagery, no
        shaded relief, no zoom slider. A handful of fixed scales, and the lines.</p>
        <p><a href="${mapPath(p)}">Walk the contours of ${esc(p.name)} on the live map</a>, or
        <a href="/">search anywhere on Earth</a>.</p>
      </section>
${
  peers.length > 1
    ? `
      <h2>In the ${esc(p.range)}</h2>
      <ol class="list">${peers.map((q) => summitRow(q, max, p)).join('')}
      </ol>`
    : ''
}

      <h2>Nearby</h2>
      <ul class="near">${near
        .map(
          (q) => `
        <li><a href="${peakPath(q)}"><span class="name">${esc(q.name)}</span>
          <span class="dist">${km(q)} km ${bearing(p, q)} · ${fmt.format(q.ele)} m</span></a></li>`,
        )
        .join('')}
      </ul>

      <p style="margin-top: 56px"><a class="cta" href="${mapPath(p)}">Open ${esc(p.name)} on the live map →</a></p>`;

  return shell({ page, site, stylesheet, favicon, version, current: p, body });
}

export function sitemap(site: string, hasImage: (p: Peak) => boolean): string {
  const today = new Date().toISOString().slice(0, 10);
  const urls: { loc: string; image?: string }[] = [
    { loc: `${site}/`, image: `${site}/og.jpg` },
    { loc: `${site}/mountains/` },
    { loc: `${site}/why/` },
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
