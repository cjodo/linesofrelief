/**
 * Checks each landing-page summit against the elevation tiles: the highest
 * DEM cell within ~1.5 km of the listed coordinate should match the published
 * elevation. Catches typos and swapped signs in site/peaks.ts.
 *
 *   node scripts/verify-peaks.ts            (needs a Chromium; set CHROMIUM=path)
 */
import { chromium } from 'playwright-core';
import { PEAKS } from '../site/peaks.ts';

const Z = 12;
const RADIUS_PX = 60; // ≈1.5–2 km at z12 for most latitudes
const TOLERANCE = 0.06; // 30 m tiles smooth summits; 6% catches real mistakes
/** Coordinates confirmed against OpenStreetMap; the DEM itself is the gap. */
const KNOWN_DEM_GAPS: Record<string, string> = {
  'fitz-roy': 'SRTM void on the granite spire',
};

const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
const page = await browser.newPage();
await page.goto('about:blank');

const results = await page.evaluate(
  async ({ peaks, Z, R }) => {
    const size = 256 * 2 ** Z;
    const world = (lat: number, lon: number) => {
      const s = Math.sin((lat * Math.PI) / 180);
      return [((lon + 180) / 360) * size, (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * size];
    };
    const tiles = new Map<string, Promise<Float32Array>>();
    const tile = (x: number, y: number) => {
      const key = `${x}/${y}`;
      if (!tiles.has(key)) {
        tiles.set(
          key,
          (async () => {
            const res = await fetch(`https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${Z}/${x}/${y}.png`);
            const bmp = await createImageBitmap(await res.blob());
            const c = new OffscreenCanvas(256, 256).getContext('2d')!;
            c.drawImage(bmp, 0, 0);
            const d = c.getImageData(0, 0, 256, 256).data;
            const out = new Float32Array(256 * 256);
            for (let i = 0; i < out.length; i++) out[i] = d[i * 4] * 256 + d[i * 4 + 1] + d[i * 4 + 2] / 256 - 32768;
            return out;
          })(),
        );
      }
      return tiles.get(key)!;
    };
    return Promise.all(
      peaks.map(async (p) => {
        const [wx, wy] = world(p.lat, p.lon);
        let max = -Infinity;
        for (let dy = -R; dy <= R; dy++) {
          for (let dx = -R; dx <= R; dx++) {
            if (dx * dx + dy * dy > R * R) continue;
            const px = Math.floor(wx + dx);
            const py = Math.floor(wy + dy);
            const t = await tile(Math.floor(px / 256), Math.floor(py / 256));
            max = Math.max(max, t[(py % 256) * 256 + (px % 256)]);
          }
        }
        return { slug: p.slug, ele: p.ele, dem: Math.round(max) };
      }),
    );
  },
  { peaks: PEAKS, Z, R: RADIUS_PX },
);
await browser.close();

let bad = 0;
for (const r of results) {
  const off = Math.abs(r.dem - r.ele) / r.ele;
  const known = KNOWN_DEM_GAPS[r.slug];
  const ok = off <= TOLERANCE || known !== undefined;
  if (!ok) bad++;
  const mark = off <= TOLERANCE ? '  ok ' : known ? 'known' : 'FAIL ';
  console.log(`${mark} ${r.slug.padEnd(16)} listed ${String(r.ele).padStart(5)} m   dem ${String(r.dem).padStart(5)} m   ${(off * 100).toFixed(1)}%${known ? `  (${known})` : ''}`);
}
console.log(bad ? `\n${bad} summit(s) need checking` : '\nall summits verified');
process.exit(bad ? 1 : 0);
