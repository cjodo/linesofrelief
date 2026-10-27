import { DS, MONO, SERIF, START, TILE, ZOOM } from './config';
import type {
  NameRequest,
  NameResult,
  SceneProgress,
  SceneRequest,
  SceneResult,
} from './contour.worker';
import { Atlas, CENTRE_PX, createCard, discovered, markDiscovered } from './discovery';
import { buildFeatures, type Features } from './features';
import { createLegend } from './legend';
import { buildScene, draw, type Scene } from './render';
import { createSearch, type Place } from './search';
import { createShare } from './share';
import { pageSpot, readSpot, spotUrl, type Spot } from './url';
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
  [`italic 16px ${SERIF}`, `400 11px ${MONO}`].map((f) =>
    document.fonts.load(f),
  ),
).catch(() => {});

const emptyFeatures: Features = { tiles: [], labels: [] };

/**
 * The build-time render of this page's map, if it shipped one and the URL is
 * for this page's own place. It is the first frame; the live map fades in over
 * an identical picture, then it is retired.
 */
const prerender = document.querySelector<HTMLElement>('.prerender');
const prerenderImg = prerender?.querySelector('img') ?? null;
let prerenderLive =
  prerenderImg !== null &&
  !document.documentElement.classList.contains('elsewhere') &&
  // Already failed before this script ran (the error listener would miss it).
  !(prerenderImg.complete && prerenderImg.naturalWidth === 0);

function retirePrerender() {
  if (!prerender || !prerenderLive) return;
  prerenderLive = false;
  prerender.classList.add('gone');
  setTimeout(() => prerender.remove(), 1300);
}

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
    if (prerenderLive) {
      // Early pans move the picture with the map until the live canvas is in.
      prerenderImg!.style.setProperty('--dx', `${arrival.x - cx}px`);
      prerenderImg!.style.setProperty('--dy', `${arrival.y - cy}px`);
    }
    const { lat, lon } = worldToLonLat(cx, cy, ZOOM);
    readout.textContent = formatLonLat(lat, lon);
    discover();
  });
}

// --- Discovery --------------------------------------------------------------

const atlas = new Atlas();
const showCard = createCard(document.querySelector<HTMLElement>('#discovery')!);
const fmt = new Intl.NumberFormat('en-US');

/** A search (or Back) arrival announces itself with the card once the map is in. */
let pendingCard: { key: string; name: string; kind?: string; context?: string } | null = null;

/** An important summit reaching the centre of the screen for the first time. */
function discover() {
  if (!document.body.classList.contains('loaded')) return;
  const mark = atlas.near(cx, cy, CENTRE_PX);
  if (!mark || discovered.has(mark.key)) return;
  markDiscovered(mark.key);
  showCard({ eyebrow: 'New area discovered', name: mark.name, detail: mark.detail });
}

/** Called as the detailed map lands: play or silence the arrival's discovery. */
function settleArrival() {
  const mark = atlas.near(cx, cy, CENTRE_PX);
  const card = pendingCard;
  pendingCard = null;
  if (card) {
    const seen = discovered.has(card.key) || (mark !== null && discovered.has(mark.key));
    const region = card.kind === 'country';
    const detail = region
      ? 'Country'
      : mark?.curated
        ? mark.detail
        : [mark?.ele !== undefined ? `${fmt.format(mark.ele)} m` : '', card.context]
            .filter(Boolean)
            .join(' · ');
    showCard({
      eyebrow: seen ? 'Returning to' : region ? 'New region discovered' : 'New area discovered',
      name: card.name,
      detail,
    });
    markDiscovered(card.key);
  }
  // The intro (or the card above) already named this place; don't announce it twice.
  if (mark) markDiscovered(mark.key);
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
  // Once the live canvas has faded in over it (1.6 s), the picture can go.
  if (prerenderLive) setTimeout(retirePrerender, 1700);
}

previewCanvas.addEventListener('transitionend', (e) => {
  if (e.target !== previewCanvas || !document.body.classList.contains('loaded')) return;
  preview = null;
  previewCanvas.hidden = true;
  intro.hidden = true;
});

// --- Shareable URL ----------------------------------------------------------

/** The page's own title (e.g. "Mount Everest contour map · …"), kept while at its summit. */
const PAGE_TITLE = document.title;
const titleFor = (name?: string) => (name ? `${name} · Topography` : 'Topography');
const shortLonLat = (lat: number, lon: number) =>
  `${Math.abs(lat).toFixed(2)}° ${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lon).toFixed(2)}° ${lon >= 0 ? 'E' : 'W'}`;

/** Where the current visit arrived; its name holds until the view wanders off. */
let arrival: { x: number; y: number; name?: string; home: boolean } = { x: 0, y: 0, home: false };

/** The view as a shareable URL and title. */
function currentLink() {
  const { lat, lon } = worldToLonLat(cx, cy, ZOOM);
  const near = Math.hypot(cx - arrival.x, cy - arrival.y) < Math.max(w, h) / 2;
  if (near && arrival.home) return { url: location.pathname, title: PAGE_TITLE };
  const name = near ? arrival.name : undefined;
  return { url: spotUrl({ name, lat, lon }), title: titleFor(name) };
}

let syncTimer = 0;
/** Panning rewrites the current history entry rather than piling up new ones. */
function syncUrl() {
  clearTimeout(syncTimer);
  syncTimer = window.setTimeout(() => {
    const { url, title } = currentLink();
    history.replaceState(null, '', url);
    document.title = title;
  }, 300);
}

/**
 * Every visit, and every search, arrives the same way: the old map fades,
 * the place name comes up over a coarse preview, the detail resolves in.
 * `push` adds a history entry so Back returns to the previous place.
 * `announce` swaps the big intro title for the discovery card on landing.
 */
function arrive(
  place: Spot & { kind?: string; context?: string },
  { push = false, announce = false } = {},
) {
  ({ x: cx, y: cy } = lonLatToWorld(place.lon, place.lat, ZOOM));
  const home = place === pageSpot;
  arrival = { x: cx, y: cy, name: place.name, home };
  clearTimeout(syncTimer);
  if (push) history.pushState(null, '', spotUrl(place));
  document.title = home ? PAGE_TITLE : titleFor(place.name);
  scene = null;
  preview = null;
  detailId = -1;

  document.body.classList.remove('loaded');
  canvas.classList.remove('ready');
  previewCanvas.classList.remove('ready', 'gone');
  previewCanvas.hidden = false;
  pctx.clearRect(0, 0, w, h);
  intro.hidden = false;
  intro.querySelector<HTMLElement>('.place')!.textContent = place.name ?? '\u00a0';
  intro.classList.toggle('naming', !place.name);
  nameId = -1;
  if (!place.name) nameView();
  intro.querySelector<HTMLElement>('.detail')!.textContent = place.detail ?? '';
  intro.querySelector<HTMLElement>('.where')!.textContent = formatLonLat(place.lat, place.lon);
  introFill.style.transform = 'scaleX(0)';
  introStatus.textContent = 'Surveying';
  intro.classList.toggle('transit', announce);
  pendingCard = announce
    ? {
        key: `${place.name ?? ''}@${place.lat.toFixed(2)},${place.lon.toFixed(2)}`,
        name: place.name ?? shortLonLat(place.lat, place.lon),
        kind: place.kind,
        context: place.context,
      }
    : null;

  // The page's own pre-rendered map stands in for the coarse preview.
  if (home && prerenderLive) previewCanvas.hidden = true;
  else {
    retirePrerender();
    requestPreview();
  }
  ensure();
}

/** Queue the coarse preview ahead of the detailed request so it paints first. */
function requestPreview() {
  const first = request(ZOOM - PREVIEW_DROP, PREVIEW_SCALE, 1, false);
  previewId = first.id;
  worker.postMessage(first);
}

// A missing or broken render falls back to the coarse preview.
prerenderImg?.addEventListener('error', () => {
  if (!prerenderLive) return;
  retirePrerender();
  if (!scene) {
    previewCanvas.hidden = false;
    requestPreview();
  }
});

// --- Naming a view that arrived without a name -------------------------------

/** Summits this close to the centre (curated, or already indexed) name it at once. */
const KNOWN_NAME_M = 10_000;
/** A reverse-lookup result farther than this names the region, not the view. */
const REVERSE_NEAR_KM = 25;
let nameId = -1;

/** Name the arrival: a known summit nearby, else the map tiles, else the server. */
function nameView() {
  const { lat } = worldToLonLat(cx, cy, ZOOM);
  const mpp = (40_075_016.686 * Math.cos((lat * Math.PI) / 180)) / (TILE * 2 ** ZOOM);
  const known = atlas.near(cx, cy, KNOWN_NAME_M / mpp);
  if (known) return applyName(known.name, known.ele);
  const req: NameRequest = { type: 'name', id: ++nextId, z: ZOOM, x: cx, y: cy };
  nameId = req.id;
  worker.postMessage(req);
}

async function named({ id, name, ele }: NameResult) {
  if (id !== nameId) return; // a newer arrival took over
  if (name) return applyName(name, ele);
  // Nothing in the tiles (open sea, empty land): ask the server what's near.
  const { lat, lon } = worldToLonLat(cx, cy, ZOOM);
  let fallback: string | undefined;
  try {
    const res = await fetch(`/api/reverse?lat=${lat.toFixed(4)}&lon=${lon.toFixed(4)}`);
    const f = (
      (await res.json()) as {
        features: { properties: Record<string, string>; geometry: { coordinates: number[] } }[];
      }
    ).features[0];
    if (f) {
      const [flon, flat] = f.geometry.coordinates;
      const km = Math.hypot((flon - lon) * Math.cos((lat * Math.PI) / 180), flat - lat) * 111.32;
      const p = f.properties;
      fallback = (km <= REVERSE_NEAR_KM && p.name) || p.state || p.country;
    }
  } catch {
    // offline or no server: coordinates it is
  }
  if (id !== nameId) return;
  if (fallback) applyName(fallback);
  else {
    // Last resort: show coordinates, but they are not a name (URL, tab, card).
    nameId = -1;
    intro.querySelector<HTMLElement>('.place')!.textContent = shortLonLat(lat, lon);
    intro.classList.remove('naming');
  }
}

function applyName(name: string, ele?: number) {
  nameId = -1;
  intro.querySelector<HTMLElement>('.place')!.textContent = name;
  if (ele !== undefined && !intro.querySelector<HTMLElement>('.detail')!.textContent) {
    intro.querySelector<HTMLElement>('.detail')!.textContent = `${fmt.format(ele)} m`;
  }
  intro.classList.remove('naming');
  arrival.name = name;
  if (pendingCard) pendingCard.name = name;
  if (!arrival.home) document.title = titleFor(name);
  syncUrl();
}

worker.onmessage = async (e: MessageEvent<SceneResult | SceneProgress | NameResult>) => {
  const msg = e.data;
  if (msg.type === 'named') return named(msg);
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
  atlas.addPeaks(msg.labels, msg.originX, msg.originY);
  updateLegend(scene.lo, scene.hi);
  if (!document.body.classList.contains('loaded')) settleArrival();
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
  syncUrl();
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
  syncUrl();
});

// No zoom, by design.
window.addEventListener('wheel', (e) => e.preventDefault(), { passive: false });
document.addEventListener('gesturestart', (e) => e.preventDefault());

window.addEventListener('resize', resize);
createSearch(document.querySelector<HTMLElement>('#search')!, (place: Place) =>
  arrive(place, { push: true, announce: true }),
);
createShare(document.querySelector<HTMLButtonElement>('#share')!, () => {
  const link = currentLink();
  history.replaceState(null, '', link.url);
  return { url: location.href, title: link.title };
});
const landing = () => readSpot() ?? pageSpot ?? START;
window.addEventListener('popstate', () => arrive(landing(), { announce: true }));

w = window.innerWidth;
h = window.innerHeight;
// A shared link lands where it was shared from; otherwise the page's own place.
arrive(landing());
resize();
