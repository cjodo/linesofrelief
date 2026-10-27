import '@fontsource/instrument-serif/400.css';
import '@fontsource/instrument-serif/400-italic.css';
import '@fontsource/jetbrains-mono/300.css';
import '@fontsource/jetbrains-mono/400.css';
import './style.css';
import { DS, MONO, SERIF, START, TILE, ZOOM } from './config';
import type { SceneProgress, SceneRequest, SceneResult } from './contour.worker';
import { buildFeatures, type Features } from './features';
import { createLegend } from './legend';
import { buildScene, draw, type Scene } from './render';
import { createSearch, type Place } from './search';
import { lonLatToWorld, worldToLonLat } from './tiles';

/** Extra world pixels fetched beyond the viewport on each side. */
const MARGIN = 128;
/** Request a new region once the view comes this close to its edge. */
const TRIGGER = 96;
/**
 * The first paint is the same place a few zoom levels coarser: a handful of
 * tiles, contoured in milliseconds, which the full map then resolves over.
 */
const PREVIEW_DROP = 2;
const PREVIEW_SCALE = 2 ** PREVIEW_DROP;

const canvas = document.querySelector<HTMLCanvasElement>('#map')!;
const ctx = canvas.getContext('2d')!;
const previewCanvas = document.querySelector<HTMLCanvasElement>('#preview')!;
const pctx = previewCanvas.getContext('2d')!;
const readout = document.querySelector<HTMLElement>('#coords')!;
const updateLegend = createLegend(document.querySelector<HTMLElement>('#legend')!);
const intro = document.querySelector<HTMLElement>('#intro')!;
const introStatus = intro.querySelector<HTMLElement>('.status')!;
const introFill = intro.querySelector<HTMLElement>('.fill')!;

// Canvas text can't fall back gracefully mid-frame; wait for the bundled faces.
const fontsReady = Promise.all(
  [`italic 16px ${SERIF}`, `16px ${SERIF}`, `300 9px ${MONO}`, `400 11px ${MONO}`].map((f) =>
    document.fonts.load(f),
  ),
).catch(() => {});

const emptyFeatures: Features = { tiles: [], labels: [] };

const worker = new Worker(new URL('./contour.worker.ts', import.meta.url), { type: 'module' });

let cx = 0;
let cy = 0;
let w = 0;
let h = 0;
let scene: Scene | null = null;
let preview: Scene | null = null;
let nextId = 0;
/** In-flight requests we still care about; anything else is stale. */
let detailId = -1;
let previewId = -1;

const formatLonLat = (lat: number, lon: number) =>
  `${Math.abs(lat).toFixed(4)}° ${lat >= 0 ? 'N' : 'S'}  ` +
  `${Math.abs(lon).toFixed(4)}° ${lon >= 0 ? 'E' : 'W'}`;


function resize() {
  const dpr = window.devicePixelRatio || 1;
  w = window.innerWidth;
  h = window.innerHeight;
  for (const [c, g] of [
    [canvas, ctx],
    [previewCanvas, pctx],
  ] as const) {
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  requestDraw();
  ensure();
}

let frame = 0;
function requestDraw() {
  frame ||= requestAnimationFrame(() => {
    frame = 0;
    const x0 = cx - w / 2;
    const y0 = cy - h / 2;
    // Without a scene the last frame stays put, so a departure can fade out.
    if (scene) {
      ctx.clearRect(0, 0, w, h);
      draw(ctx, scene, x0, y0, w, h);
    }
    if (preview) {
      pctx.clearRect(0, 0, w, h);
      draw(pctx, preview, x0, y0, w, h);
    }
    const { lat, lon } = worldToLonLat(cx, cy, ZOOM);
    readout.textContent = formatLonLat(lat, lon);
  });
}

/** Tiles at zoom `z` covering the view (plus margin), `k` screen px per tile px. */
function request(z: number, k: number, ds: number, features: boolean): SceneRequest {
  const x0 = (cx - w / 2 - MARGIN) / k;
  const y0 = (cy - h / 2 - MARGIN) / k;
  const x1 = (cx + w / 2 + MARGIN) / k;
  const y1 = (cy + h / 2 + MARGIN) / k;
  const max = 2 ** z - 1;
  return {
    id: ++nextId,
    z,
    ds,
    features,
    tx0: Math.floor(x0 / TILE),
    tx1: Math.floor(x1 / TILE),
    ty0: Math.max(0, Math.floor(y0 / TILE)),
    ty1: Math.min(max, Math.floor(y1 / TILE)),
  };
}

/** Make sure the current scene covers the view; otherwise ask the worker for one. */
function ensure() {
  const x0 = cx - w / 2;
  const y0 = cy - h / 2;
  if (
    scene &&
    x0 >= scene.originX + TRIGGER &&
    y0 >= scene.originY + TRIGGER &&
    x0 + w <= scene.originX + scene.width - TRIGGER &&
    y0 + h <= scene.originY + scene.height - TRIGGER
  ) {
    return;
  }
  if (detailId !== -1) return; // re-checked when the in-flight scene lands
  document.body.classList.add('busy');
  const req = request(ZOOM, 1, DS, true);
  detailId = req.id;
  worker.postMessage(req);
}

function showProgress({ done, total }: SceneProgress) {
  introFill.style.transform = `scaleX(${done / total})`;
  introStatus.textContent = done < total ? `Surveying  ${done} / ${total}` : 'Tracing contours';
}

/** Detail has landed: resolve the map over the preview and let the title go. */
function reveal() {
  if (document.body.classList.contains('loaded')) return;
  document.body.classList.add('loaded');
  canvas.classList.add('ready');
  previewCanvas.classList.add('gone');
}

previewCanvas.addEventListener('transitionend', (e) => {
  if (e.target !== previewCanvas || !document.body.classList.contains('loaded')) return;
  preview = null;
  previewCanvas.hidden = true;
  intro.hidden = true;
});

/**
 * Every visit, and every search, arrives the same way: the old map fades,
 * the place name comes up over a coarse preview, the detail resolves in.
 */
function arrive(place: { name: string; lat: number; lon: number }) {
  ({ x: cx, y: cy } = lonLatToWorld(place.lon, place.lat, ZOOM));
  scene = null;
  preview = null;
  detailId = -1;

  document.body.classList.remove('loaded');
  canvas.classList.remove('ready');
  previewCanvas.classList.remove('ready', 'gone');
  previewCanvas.hidden = false;
  pctx.clearRect(0, 0, w, h);
  intro.hidden = false;
  intro.querySelector<HTMLElement>('.place')!.textContent = place.name;
  intro.querySelector<HTMLElement>('.where')!.textContent = formatLonLat(place.lat, place.lon);
  introFill.style.transform = 'scaleX(0)';
  introStatus.textContent = 'Surveying';

  // Queue the coarse preview ahead of the detailed request so it paints first.
  const first = request(ZOOM - PREVIEW_DROP, PREVIEW_SCALE, 1, false);
  previewId = first.id;
  worker.postMessage(first);
  ensure();
}

worker.onmessage = async (e: MessageEvent<SceneResult | SceneProgress>) => {
  const msg = e.data;
  if (msg.id === previewId) {
    if (msg.type === 'scene' && !scene) {
      preview = buildScene(msg, emptyFeatures, 1, PREVIEW_SCALE);
      previewCanvas.classList.add('ready');
      requestDraw();
    }
    return;
  }
  if (msg.id !== detailId) return; // superseded by a search
  if (msg.type === 'progress') {
    if (!scene) showProgress(msg);
    return;
  }
  await fontsReady;
  if (msg.id !== detailId) return;
  detailId = -1;
  document.body.classList.remove('busy');
  const features = buildFeatures(ctx, msg.tiles, msg.labels, msg.width, msg.height);
  scene = buildScene(msg, features, DS);
  updateLegend(scene.lo, scene.hi);
  reveal();
  requestDraw();
  ensure();
};

// --- Panning only. Scale is fixed. -----------------------------------------

let drag: { x: number; y: number } | null = null;

canvas.addEventListener('pointerdown', (e) => {
  drag = { x: e.clientX, y: e.clientY };
  canvas.setPointerCapture(e.pointerId);
  canvas.classList.add('dragging');
});
canvas.addEventListener('pointermove', (e) => {
  if (!drag) return;
  cx -= e.clientX - drag.x;
  cy -= e.clientY - drag.y;
  drag = { x: e.clientX, y: e.clientY };
  requestDraw();
  ensure();
});
const endDrag = () => {
  drag = null;
  canvas.classList.remove('dragging');
};
canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);

const STEP = 160;
const KEYS: Record<string, [number, number]> = {
  ArrowLeft: [-STEP, 0],
  ArrowRight: [STEP, 0],
  ArrowUp: [0, -STEP],
  ArrowDown: [0, STEP],
};
window.addEventListener('keydown', (e) => {
  const d = KEYS[e.key];
  if (!d || e.target instanceof HTMLInputElement) return;
  e.preventDefault();
  cx += d[0];
  cy += d[1];
  requestDraw();
  ensure();
});

// No zoom, by design.
window.addEventListener('wheel', (e) => e.preventDefault(), { passive: false });
document.addEventListener('gesturestart', (e) => e.preventDefault());

window.addEventListener('resize', resize);
createSearch(document.querySelector<HTMLElement>('#search')!, (place: Place) => arrive(place));

w = window.innerWidth;
h = window.innerHeight;
arrive(START);
resize();
