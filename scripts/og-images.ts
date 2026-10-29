/**
 * Renders the 1200×630 social preview for / and each summit page into
 * public/og.jpg and public/og/<slug>.jpg, from a running `vite preview`.
 * Use `make og` rather than running this directly; `make og SLUGS="k2 eiger"`
 * re-renders just those summits ("home" is the front page).
 */
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright-core';
import { PEAKS } from '../site/peaks.ts';

const BASE = process.env.BASE ?? 'http://localhost:4173';
const OUT = new URL('../public/', import.meta.url).pathname;
const ONLY = process.argv.slice(2);

const fmt = new Intl.NumberFormat('en-US');
mkdirSync(`${OUT}og`, { recursive: true });

const browser = await chromium.launch(
  process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {},
);
const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });

async function shoot(path: string, eyebrow: string, title: string, file: string) {
  await page.goto(`${BASE}${path}`);
  await page.waitForFunction(() => document.body.classList.contains('loaded'), null, {
    timeout: 120_000,
  });
  await page.waitForTimeout(3500); // let the cross-fade finish
  await page.addStyleTag({
    content: `
      .nav, .discovery, .legend, .search, .share, .locator, .loading-bar { display: none !important; }
      .og { position: fixed; left: 64px; right: 64px; bottom: 56px;
            text-shadow: 0 0 30px #191724, 0 0 10px #191724; }
      .og p { margin: 0; font: 300 15px/1 "JetBrains Mono"; letter-spacing: .26em;
              text-transform: uppercase; color: #908caa; }
      .og h1 { margin: 14px 0 0; font: italic 400 96px/0.95 "Instrument Serif"; color: #e0def4; }`,
  });
  await page.evaluate(
    ([e, t]) => {
      document.querySelector('.og')?.remove();
      const el = document.createElement('div');
      el.className = 'og';
      el.innerHTML = '<p></p><h1></h1>';
      el.querySelector('p')!.textContent = e;
      el.querySelector('h1')!.textContent = t;
      document.body.append(el);
    },
    [eyebrow, title],
  );
  await page.waitForTimeout(200);
  await page.screenshot({ path: file, type: 'jpeg', quality: 86 });
  console.log('wrote', file.replace(OUT, 'public/'));
}

if (!ONLY.length || ONLY.includes('home')) {
  await shoot('/', 'Contour maps of any mountain on Earth', 'Topography', `${OUT}og.jpg`);
}
for (const p of PEAKS) {
  if (ONLY.length && !ONLY.includes(p.slug)) continue;
  await shoot(
    `/mountains/${p.slug}/map/`,
    `Topography · ${fmt.format(p.ele)} m · ${p.range}`,
    p.name,
    `${OUT}og/${p.slug}.jpg`,
  );
}
await browser.close();
