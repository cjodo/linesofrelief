/**
 * Renders the first frame for / and each summit page: the fully loaded map
 * canvas (no interface) at each PRERENDER size, as WebP, into
 * public/prerender/<key>-<size>.webp. The pages ship these as their first
 * paint. Use `make prerender` (optionally SLUGS="home everest k2").
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright-core';
import { PRERENDER } from '../site/pages.ts';
import { PEAKS } from '../site/peaks.ts';

const BASE = process.env.BASE ?? 'http://localhost:4173';
const OUT = new URL('../public/prerender/', import.meta.url).pathname;
const QUALITY = Number(process.env.QUALITY ?? 0.7);
const ONLY = process.argv.slice(2);

mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch(
  process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {},
);
// One context: tiles cached by the first size are reused by the second.
const context = await browser.newContext({ deviceScaleFactor: 1 });
const page = await context.newPage();

const pages = [
  ...(!ONLY.length || ONLY.includes('home') ? [{ key: 'home', path: '/' }] : []),
  ...PEAKS.filter((p) => !ONLY.length || ONLY.includes(p.slug)).map((p) => ({
    key: p.slug,
    path: `/mountains/${p.slug}/map/`,
  })),
];

for (const { key, path } of pages) {
  for (const [size, { width, height }] of Object.entries(PRERENDER)) {
    await page.setViewportSize({ width, height });
    // Render live: drop any existing picture so it cannot stand in for the map.
    await page.goto(`${BASE}${path}`);
    await page.evaluate(() => document.querySelector('.prerender')?.remove());
    await page.waitForFunction(() => document.body.classList.contains('loaded'), null, {
      timeout: 120_000,
    });
    await page.waitForTimeout(2200); // fade-in done, last frame drawn
    // Flatten onto the page background: opaque WebP is far smaller than alpha.
    const data = await page.evaluate((q) => {
      const map = document.querySelector('#map') as HTMLCanvasElement;
      const flat = document.createElement('canvas');
      flat.width = map.width;
      flat.height = map.height;
      const g = flat.getContext('2d')!;
      g.fillStyle = getComputedStyle(document.body).backgroundColor;
      g.fillRect(0, 0, flat.width, flat.height);
      g.drawImage(map, 0, 0);
      return flat.toDataURL('image/webp', q);
    }, QUALITY);
    const file = `${OUT}${key}-${size}.webp`;
    writeFileSync(file, Buffer.from(data.split(',')[1], 'base64'));
    console.log(`wrote public/prerender/${key}-${size}.webp  ${(data.length * 0.75 / 1024).toFixed(0)} KB`);
  }
}
await browser.close();
