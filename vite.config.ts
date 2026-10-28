import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import { START } from './src/config';
import {
  headTags,
  htmlAttrs,
  hubHtml,
  peakPage,
  peakPath,
  PRERENDER,
  prerenderHtml,
  rootPage,
  sitemap,
  type Page,
} from './site/pages';
import { PEAKS, type Peak } from './site/peaks';

/** Public origin of the site; override with SITE_URL=https://… at build time. */
// `||`, not `??`: the Dockerfile passes an empty SITE_URL when none is given,
// which would make canonical, share-image and sitemap URLs relative (and the
// sitemap invalid).
const SITE_URL = (process.env.SITE_URL || 'https://linesofrelief.ink').replace(/\/+$/, '');

const ROUTE = /^\/mountains\/?(?:([a-z0-9-]+)\/?)?$/;
const faviconOf = (html: string) => html.match(/<link rel="icon"[^>]*>/)?.[0] ?? '';

const hasPrerender = (key: string) =>
  (Object.keys(PRERENDER) as (keyof typeof PRERENDER)[]).every((size) =>
    existsSync(resolve(__dirname, 'public/prerender', `${key}-${size}.webp`)),
  );
const root = () => rootPage(SITE_URL, START, hasPrerender('home'));
const summit = (p: Peak) => peakPage(p, SITE_URL, hasImage(p), hasPrerender(p.slug));

/** Short content hash of a file in public/, if it exists. */
function publicVersion(path: string): string | undefined {
  const file = resolve(__dirname, 'public', path.replace(/^\//, ''));
  if (!existsSync(file)) return undefined;
  return createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 10);
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
  return out.replace(/<html[^>]*>/, () => `<html lang="en"${htmlAttrs(page)}>`);
}

/**
 * The map at /, a landing page per summit at /mountains/<slug>/ (the same app,
 * arriving at that summit), the /mountains/ index, robots.txt and sitemap.xml.
 */
function sitePages(): Plugin {
  return {
    name: 'site-pages',
    // 'pre' so the dev server serves a filled-in root page too.
    transformIndexHtml: {
      order: 'pre',
      handler: (html) => render(html, root()),
    },
    // Dev has no generated files, so render /mountains/ and its summits on request.
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const match = (req.url ?? '').split('?')[0].match(ROUTE);
        if (!match) return next();
        try {
          const template = readFileSync(resolve(__dirname, 'index.html'), 'utf8');
          let html: string;
          if (match[1]) {
            const peak = PEAKS.find((p) => p.slug === match[1]);
            if (!peak) return next();
            html = render(
              await server.transformIndexHtml(req.url!, template),
              summit(peak),
            );
          } else {
            html = hubHtml(SITE_URL, '/src/style.css', faviconOf(template, publicVersion));
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

        for (const p of PEAKS) {
          this.emitFile({
            type: 'asset',
            fileName: `${peakPath(p).slice(1)}index.html`,
            source: render(html, summit(p)),
          });
        }

        const stylesheet = html.match(/<link rel="stylesheet"[^>]*href="([^"]+)"/)?.[1] ?? '';
        const favicon = faviconOf(html);
        this.emitFile({
          type: 'asset',
          fileName: 'mountains/index.html',
          source: hubHtml(SITE_URL, stylesheet, favicon, publicVersion),
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
