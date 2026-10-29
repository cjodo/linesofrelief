import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import { START } from './src/config';
import {
  headTags,
  htmlAttrs,
  analyticsHtml,
  favoritesNav,
  hubHtml,
  landmarkHtml,
  landmarksHubHtml,
  mapPath,
  peakPage,
  peakPath,
  PRERENDER,
  prerenderHtml,
  rootPage,
  sitemap,
  summaryHtml,
  useAnalytics,
  whyHtml,
  type Page,
} from './site/pages';
import { LANDMARKS, landmarkPath } from './site/landmarks';
import { PEAKS, type Peak } from './site/peaks';

/** Public origin of the site; override with SITE_URL=https://… at build time. */
// `||`, not `??`: the Dockerfile passes an empty SITE_URL when none is given,
// which would make canonical, share-image and sitemap URLs relative (and the
// sitemap invalid).
const SITE_URL = (process.env.SITE_URL || 'https://linesofrelief.ink').replace(/\/+$/, '');

/** /mountains/, /mountains/<slug>/ (summary) and /mountains/<slug>/map/ (live map). */
/**
 * The site's Google tag: Tag Manager container (GTM-…) or GA4 ID (G-…).
 * GA_ID overrides it (`off` disables); production builds only, never dev.
 */
const DEFAULT_TAG = 'GTM-T9ZSQXZK';
const TAG_ID = (process.env.GA_ID?.trim() || DEFAULT_TAG).toUpperCase();
const TAG_OK = /^(GTM|G)-[A-Z0-9]+$/.test(TAG_ID);
if (TAG_ID !== 'OFF' && !TAG_OK) {
  console.warn(`GA_ID "${TAG_ID}" isn't a Google tag ID (GTM-… or G-…); analytics left out.`);
}
useAnalytics(TAG_OK ? TAG_ID : '');

const ROUTE = /^\/mountains\/?(?:([a-z0-9-]+)\/?(map\/?)?)?$/;
const WHY_ROUTE = /^\/why\/?$/;
const LANDMARK_ROUTE = /^\/landmarks\/([a-z0-9-]+)\/?$/;
const LANDMARKS_ROUTE = /^\/landmarks\/?$/;
const faviconOf = (html: string) => html.match(/<link rel="icon"[^>]*>/)?.[0] ?? '';

const hasPrerender = (key: string) =>
  (Object.keys(PRERENDER) as (keyof typeof PRERENDER)[]).every((size) =>
    existsSync(resolve(__dirname, 'public/prerender', `${key}-${size}.webp`)),
  );
const root = () => rootPage(SITE_URL, START, hasPrerender('home'));
const summit = (p: Peak) => peakPage(p, hasImage(p), hasPrerender(p.slug));
const summary = (p: Peak, stylesheet: string, favicon: string) =>
  summaryHtml(p, SITE_URL, stylesheet, favicon, publicVersion, hasImage(p), hasPrerender(p.slug));

/** Short content hash of a file in public/, if it exists. */
function publicVersion(path: string): string | undefined {
  const file = resolve(__dirname, 'public', path.replace(/^\//, ''));
  if (!existsSync(file)) return undefined;
  return createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 10);
}

/** A WebP's pixel size, from its header (lossy VP8, lossless VP8L or extended VP8X). */
function publicSize(path: string): { width: number; height: number } | undefined {
  const file = resolve(__dirname, 'public', path.replace(/^\//, ''));
  if (!existsSync(file)) return undefined;
  const b = readFileSync(file);
  if (b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WEBP') return undefined;
  const chunk = b.toString('ascii', 12, 16);
  if (chunk === 'VP8X') return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
  if (chunk === 'VP8 ') return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
  if (chunk === 'VP8L') {
    const bits = b.readUInt32LE(21);
    return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) };
  }
  return undefined;
}

const hasImage = (p: Peak) => existsSync(resolve(__dirname, 'public/og', `${p.slug}.jpg`));

/** Fill the template's marked regions for one page. */
function render(html: string, page: Page): string {
  const region = (src: string, name: string, content: string) =>
    src.replace(
      new RegExp(`<!-- ${name} -->[\\s\\S]*?<!-- /${name} -->`),
      () => `<!-- ${name} -->\n${content}\n    <!-- /${name} -->`,
    );
  let out = region(html, 'seo', headTags(page, SITE_URL, publicVersion));
  out = region(out, 'about', page.about ?? '');
  out = region(out, 'prerender', prerenderHtml(page));
  out = region(out, 'favorites', favoritesNav());
  out = region(out, 'analytics', analyticsHtml());
  return out.replace(/<html[^>]*>/, () => `<html lang="en"${htmlAttrs(page)}>`);
}

/**
 * The map at /; per summit a static summary at /mountains/<slug>/ and the live
 * map arriving there at /mountains/<slug>/map/; the /mountains/ index,
 * robots.txt and sitemap.xml.
 */
/** The /why/ globe's module: served as source in dev, bundled in a build. */
const GLOBE_ENTRY = 'src/globe-page.ts';

function sitePages(): Plugin {
  let building = false;
  let globeChunk = '';
  return {
    name: 'site-pages',
    // The dev server never sends analytics.
    config(_, { command }) {
      building = command === 'build';
      if (command === 'serve') useAnalytics('');
    },
    // The globe is the static pages' only script: a chunk of its own.
    buildStart() {
      if (building) {
        globeChunk = this.emitFile({ type: 'chunk', id: resolve(__dirname, GLOBE_ENTRY), name: 'globe' });
      }
    },
    // 'pre' so the dev server serves a filled-in root page too.
    transformIndexHtml: {
      order: 'pre',
      handler: (html) => render(html, root()),
    },
    // Dev has no generated files, so render /mountains/, its summits, the landmarks and /why/ on request.
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const path = (req.url ?? '').split('?')[0];
        if (WHY_ROUTE.test(path)) {
          const template = readFileSync(resolve(__dirname, 'index.html'), 'utf8');
          res.setHeader('Content-Type', 'text/html');
          res.end(whyHtml(SITE_URL, '/src/style.css', faviconOf(template), `/${GLOBE_ENTRY}`, publicVersion));
          return;
        }
        if (LANDMARKS_ROUTE.test(path)) {
          const template = readFileSync(resolve(__dirname, 'index.html'), 'utf8');
          res.setHeader('Content-Type', 'text/html');
          res.end(landmarksHubHtml(SITE_URL, '/src/style.css', faviconOf(template), publicVersion));
          return;
        }
        const landmark = LANDMARKS.find((l) => l.slug === path.match(LANDMARK_ROUTE)?.[1]);
        if (landmark) {
          const template = readFileSync(resolve(__dirname, 'index.html'), 'utf8');
          res.setHeader('Content-Type', 'text/html');
          res.end(landmarkHtml(landmark, SITE_URL, '/src/style.css', faviconOf(template), publicVersion, publicSize));
          return;
        }
        const match = path.match(ROUTE);
        if (!match) return next();
        try {
          const template = readFileSync(resolve(__dirname, 'index.html'), 'utf8');
          let html: string;
          const favicon = faviconOf(template);
          if (match[1]) {
            const peak = PEAKS.find((p) => p.slug === match[1]);
            if (!peak) return next();
            html = match[2]
              ? render(await server.transformIndexHtml(req.url!, template), summit(peak))
              : summary(peak, '/src/style.css', favicon);
          } else {
            html = hubHtml(SITE_URL, '/src/style.css', favicon, publicVersion);
          }
          res.setHeader('Content-Type', 'text/html');
          res.end(html);
        } catch (e) {
          next(e);
        }
      });
    },
    // 'post': Vite's own HTML plugin adds index.html to the bundle in this hook.
    generateBundle: {
      order: 'post',
      handler(_, bundle) {
        const index = bundle['index.html'];
        if (index?.type !== 'asset') return;
        const html = String(index.source);

        const stylesheet = html.match(/<link rel="stylesheet"[^>]*href="([^"]+)"/)?.[1] ?? '';
        const favicon = faviconOf(html);
        for (const p of PEAKS) {
          this.emitFile({
            type: 'asset',
            fileName: `${peakPath(p).slice(1)}index.html`,
            source: summary(p, stylesheet, favicon),
          });
          this.emitFile({
            type: 'asset',
            fileName: `${mapPath(p).slice(1)}index.html`,
            source: render(html, summit(p)),
          });
        }

        this.emitFile({
          type: 'asset',
          fileName: 'landmarks/index.html',
          source: landmarksHubHtml(SITE_URL, stylesheet, favicon, publicVersion),
        });
        for (const l of LANDMARKS) {
          this.emitFile({
            type: 'asset',
            fileName: `${landmarkPath(l).slice(1)}index.html`,
            source: landmarkHtml(l, SITE_URL, stylesheet, favicon, publicVersion, publicSize),
          });
        }

        this.emitFile({
          type: 'asset',
          fileName: 'mountains/index.html',
          source: hubHtml(SITE_URL, stylesheet, favicon, publicVersion),
        });
        this.emitFile({
          type: 'asset',
          fileName: 'why/index.html',
          source: whyHtml(SITE_URL, stylesheet, favicon, `/${this.getFileName(globeChunk)}`, publicVersion),
        });
        this.emitFile({
          type: 'asset',
          fileName: 'robots.txt',
          source: `User-agent: *\nAllow: /\n\nSitemap: ${SITE_URL}/sitemap.xml\n`,
        });
        this.emitFile({
          type: 'asset',
          fileName: 'sitemap.xml',
          source: sitemap(SITE_URL, hasImage),
        });
      },
    },
  };
}

/** The Rust server (crates/server) that proxies and caches tiles and search. */
const API = process.env.API_ORIGIN ?? 'http://localhost:8080';
const proxy = { '/tiles': API, '/api': API };

export default defineConfig({
  plugins: [sitePages()],
  server: { proxy },
  preview: { proxy },
  worker: { format: 'es' },
});
