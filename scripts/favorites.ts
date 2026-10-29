/**
 * Pre-builds every favourite (site/favorites.ts) into public/favorites/<slug>.bin:
 * the finished scene at the default zoom, made by the same code the browser
 * runs (src/scene-build.ts), so arriving there costs one file and a draw.
 *
 * Tiles come through the running server (BASE), which warms its cache too.
 * Use `make favorites` (optionally SLUGS="lake-louise"); it bundles this
 * script first, since src/ imports are written for the browser build.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { brotliCompressSync } from 'node:zlib';
import { FAVORITES } from '../site/favorites';
import { encodeScene, favoriteRequest } from '../src/bundle';
import { terrainUrl, vectorUrl } from '../src/config';
import { buildRegion, type Kernel } from '../src/scene-build';
import { decodeVector, terrariumToElevation } from '../src/tiles';
import { decodePng } from './png';

const BASE = process.env.BASE ?? 'http://localhost:8080';
const OUT = 'public/favorites';
const ONLY = process.argv.slice(2);

async function get(path: string, type: string): Promise<ArrayBuffer> {
  const res = await fetch(BASE + path);
  const got = res.headers.get('content-type') ?? '';
  if (!res.ok || !got.startsWith(type)) throw new Error(`${path}: ${res.status} ${got}`);
  return res.arrayBuffer();
}

const loaders = {
  async elevation(z: number, x: number, y: number) {
    const png = decodePng(new Uint8Array(await get(terrainUrl(z, x, y), 'image/png')));
    return terrariumToElevation(png.pixels, png.channels);
  },
  async vector(z: number, x: number, y: number) {
    return decodeVector(await get(vectorUrl(z, x, y), 'application/x-protobuf'));
  },
};

const { instance } = await WebAssembly.instantiate(readFileSync('src/wasm/contour.wasm'));
const kernel = instance.exports as unknown as Kernel;

mkdirSync(OUT, { recursive: true });
for (const f of FAVORITES) {
  if (ONLY.length && !ONLY.includes(f.slug)) continue;
  const t0 = Date.now();
  const scene = await buildRegion(favoriteRequest(f), kernel, loaders);
  const bytes = encodeScene(scene);
  writeFileSync(`${OUT}/${f.slug}.bin`, bytes);
  const br = brotliCompressSync(bytes).length;
  console.log(
    `wrote ${OUT}/${f.slug}.bin  ${(bytes.length / 1024).toFixed(0)} KB (≈${(br / 1024).toFixed(0)} KB brotli)` +
      `  ${scene.levels.length} levels, ${scene.labels.length} labels, ${Date.now() - t0} ms`,
  );
}
