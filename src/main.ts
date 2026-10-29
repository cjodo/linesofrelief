import { DEFAULT_ZOOM, DS, INTERVALS, MONO, SERIF, START, TILE, ZOOMS } from './config';
import type {
  NameRequest,
  NameResult,
  SceneProgress,
  SceneRequest,
  SceneResult,
} from './contour.worker';
import { ATLAS_ZOOM, Atlas, CENTRE_PX, createCard, discovered, markDiscovered } from './discovery';
import { buildFeatures, labelKey, setLabelScale, type Features } from './features';
import { createMinimap } from './minimap';
import { createTextSize, storedScale } from './textsize';
import { createLegend } from './legend';
import { buildScene, draw, type Scene } from './render';
import { createSearch, type Place } from './search';
import { track } from './analytics';
import { greet } from './banner';
import { bundleUrl, decodeScene, favoriteFor, favoriteRequest } from './bundle';
import type { Favorite } from '../site/favorites';
import { createExport } from './export';
import { createShare } from './share';
import { settable } from './text';
import { pageSpot, readSpot, spotUrl, type Spot } from './url';
import { lonLatToWorld, worldToLonLat } from './tiles';

/** World pixels drawn beyond the viewport on every side. */
const MARGIN = 256;
/** Request the next region while this much drawn map is still left ahead. */
const TRIGGER = 192;
/** Extra reach in the direction of travel, at full speed. */
const LEAD_MAX = 256;
/** At or below this zoom, map tiles come one zoom coarser (a quarter of the requests). */
const COARSE_VECTORS_BELOW = 12;
/** How strongly recent pan speed turns into lead (per move event). */
const LEAD_GAIN = 6;
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

/** The view's web-mercator zoom; cx/cy are world pixels at this zoom. */
let zoom = DEFAULT_ZOOM;
let cx = 0;
let cy = 0;
let w = 0;
let h = 0;
let scene: Scene | null = null;
/** The colour scale of the current arrival (see the scene handler). */
let range: { lo: number; hi: number } | null = null;
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
      draw(ctx, scene, x0, y0, w, h, zoom);
    }
    if (preview) {
      pctx.clearRect(0, 0, w, h);
      draw(pctx, preview, x0, y0, w, h, zoom);
    }
    if (prerenderLive) {
      // Early pans move the picture with the map until the live canvas is in.
      prerenderImg!.style.setProperty('--dx', `${arrival.x - cx}px`);
      prerenderImg!.style.setProperty('--dy', `${arrival.y - cy}px`);
    }
    const { lat, lon } = worldToLonLat(cx, cy, zoom);
    readout.textContent = formatLonLat(lat, lon);
    minimap(cx, cy, zoom);
    showScale(lat);
    discover();
  });
}

// --- Discovery --------------------------------------------------------------

const atlas = new Atlas();
const showCard = createCard(document.querySelector<HTMLElement>('#discovery')!);
const fmt = new Intl.NumberFormat('en-US');

/** The important summit within `radius` screen pixels of the centre (the atlas keeps ATLAS_ZOOM pixels). */
function atlasNear(radius: number) {
  const f = 2 ** (ATLAS_ZOOM - zoom);
  return atlas.near(cx * f, cy * f, radius * f, zoom);
}

/** A search (or Back) arrival announces itself with the card once the map is in. */
let pendingCard: { key: string; name: string; kind?: string; context?: string } | null = null;

/** Cards never stack: after one plays, others wait (and fire later if still due). */
const CARD_COOLDOWN_MS = 7_000;
let cardsResumeAt = 0;
function playCard(card: Parameters<typeof showCard>[0]) {
  cardsResumeAt = performance.now() + CARD_COOLDOWN_MS;
  showCard(card);
  track('discovery', { kind: card.eyebrow, name: card.name });
}
const cardsPaused = () => performance.now() < cardsResumeAt;

/** A summit important at this zoom reaching the centre of the screen, first time. */
function discover() {
  if (!document.body.classList.contains('loaded') || cardsPaused()) return;
  const mark = atlasNear(CENTRE_PX);
  if (!mark || discovered.has(mark.key)) return;
  markDiscovered(mark.key);
  playCard({ eyebrow: 'New area discovered', name: mark.name, detail: mark.detail });
}

/** Called as the detailed map lands: play or silence the arrival's discovery. */
function settleArrival() {
  const mark = atlasNear(CENTRE_PX);
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
    playCard({
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
  // The region leans toward where the view is heading.
  const x0 = (cx - w / 2 - MARGIN - Math.max(0, -lead.x)) / k;
  const y0 = (cy - h / 2 - MARGIN - Math.max(0, -lead.y)) / k;
  const x1 = (cx + w / 2 + MARGIN + Math.max(0, lead.x)) / k;
  const y1 = (cy + h / 2 + MARGIN + Math.max(0, lead.y)) / k;
  const max = 2 ** z - 1;
  return {
    id: ++nextId,
    z,
    ds,
    features,
    // The view's interval, also for the coarse preview, so line weights match.
    interval: INTERVALS[zoom],
    coarseVectors: features && z < COARSE_VECTORS_BELOW,
    tx0: Math.floor(x0 / TILE),
    tx1: Math.floor(x1 / TILE),
    ty0: Math.max(0, Math.floor(y0 / TILE)),
    ty1: Math.min(max, Math.floor(y1 / TILE)),
  };
}

/** Make sure the current scene covers the view; otherwise ask the worker for one. */
function ensure() {
  if (covers(scene)) return;
  // A request in flight that will still cover the view: let it land. One for
  // where the view used to be is superseded (the worker skips its queued
  // tiles), rather than queued behind.
  if (detailId !== -1 && covers(pending)) return;
  document.body.classList.add('busy');
  const req = request(zoom, 1, DS, true);
  detailId = req.id;
  pending = {
    zoom,
    originX: req.tx0 * TILE,
    originY: req.ty0 * TILE,
    width: (req.tx1 - req.tx0 + 1) * TILE,
    height: (req.ty1 - req.ty0 + 1) * TILE,
  };
  worker.postMessage(req);
}

type Region = { zoom: number; originX: number; originY: number; width: number; height: number };
/** The in-flight detailed request's region, while there is one. */
let pending: Region | null = null;

/** Whether a region at the view's zoom covers the view with TRIGGER to spare. */
function covers(r: Region | null) {
  const x0 = cx - w / 2;
  const y0 = cy - h / 2;
  return (
    r !== null &&
    r.zoom === zoom &&
    x0 >= r.originX + TRIGGER &&
    y0 >= r.originY + TRIGGER &&
    x0 + w <= r.originX + r.width - TRIGGER &&
    y0 + h <= r.originY + r.height - TRIGGER
  );
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
  const { lat, lon } = worldToLonLat(cx, cy, zoom);
  const near = Math.hypot(cx - arrival.x, cy - arrival.y) < Math.max(w, h) / 2;
  if (near && arrival.home && zoom === DEFAULT_ZOOM) {
    return { url: location.pathname, title: PAGE_TITLE };
  }
  const name = near ? arrival.name : undefined;
  return { url: spotUrl({ name, lat, lon, zoom }), title: titleFor(name) };
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
  { push = false, announce = false, keepZoom = false } = {},
) {
  // A link's zoom wins; a search keeps the reader's; otherwise the default.
  zoom = place.zoom ?? (keepZoom ? zoom : DEFAULT_ZOOM);
  updateZoomControls();
  ({ x: cx, y: cy } = lonLatToWorld(place.lon, place.lat, zoom));
  const home = place === pageSpot;
  // e.g. a search hit named only in another script: name the view ourselves.
  if (place.name && !settable(place.name)) place = { ...place, name: undefined };
  arrival = { x: cx, y: cy, name: place.name, home };
  clearTimeout(syncTimer);
  if (push) history.pushState(null, '', spotUrl({ ...place, zoom }));
  document.title = home ? PAGE_TITLE : titleFor(place.name);
  scene = null;
  preview = null;
  detailId = -1;
  exportButton.disabled = true;
  range = null;
  lead.x = lead.y = 0;
  regionAt = null;
  regionQuiet = true;
  scheduleRegion();

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

  // A favourite arrives pre-built: one file, no tiles, no tracing. Otherwise
  // the page's own pre-rendered map, or the coarse preview, covers the wait.
  const favorite = zoom === DEFAULT_ZOOM ? favoriteFor(place.lat, place.lon, w, h, TRIGGER) : null;
  if (home && prerenderLive) previewCanvas.hidden = true;
  else if (favorite) {
    retirePrerender();
    previewCanvas.hidden = true;
  } else {
    retirePrerender();
    requestPreview();
  }
  if (favorite) loadFavorite(favorite);
  ensure();
}

/** Fetch a favourite's pre-built scene in place of a worker request for it. */
async function loadFavorite(f: Favorite) {
  const r = favoriteRequest(f);
  const id = ++nextId;
  detailId = id;
  pending = {
    zoom: DEFAULT_ZOOM,
    originX: r.tx0 * TILE,
    originY: r.ty0 * TILE,
    width: (r.tx1 - r.tx0 + 1) * TILE,
    height: (r.ty1 - r.ty0 + 1) * TILE,
  };
  document.body.classList.add('busy');
  try {
    const res = await fetch(bundleUrl(f));
    if (!res.ok) throw new Error(`${res.status}`);
    const result = decodeScene(await res.arrayBuffer(), id);
    if (detailId === id) await acceptScene(result);
  } catch {
    // Not built yet, or unreachable: build it live like anywhere else.
    if (detailId !== id) return;
    detailId = -1;
    pending = null;
    if (!scene) requestPreview();
    ensure();
  }
}

/** Queue the coarse preview ahead of the detailed request so it paints first. */
function requestPreview() {
  const first = request(zoom - PREVIEW_DROP, PREVIEW_SCALE, 1, false);
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
/** Reverse-lookup features that can name a view (not roads, shops, buildings…). */
const NAMING_KEYS = new Set(['place', 'natural', 'waterway', 'water', 'boundary', 'mountain_pass']);
const usable = (s?: string) => (s && settable(s) ? s : undefined);
let nameId = -1;

/** Name the arrival: a known summit nearby, else the map tiles, else the server. */
function nameView() {
  const known = atlasNear(KNOWN_NAME_M / metresPerPx());
  if (known) return applyName(known.name, known.ele);
  const req: NameRequest = { type: 'name', id: ++nextId, z: zoom, x: cx, y: cy };
  nameId = req.id;
  worker.postMessage(req);
}

async function named({ id, name, ele }: NameResult) {
  if (id !== nameId) return; // a newer arrival took over
  if (name) return applyName(name, ele);
  // Nothing in the tiles (open sea, empty land): ask the server what's near.
  const { lat, lon } = worldToLonLat(cx, cy, zoom);
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
      const own = km <= REVERSE_NEAR_KM && NAMING_KEYS.has(p.osm_key) ? usable(p.name) : undefined;
      fallback = own ?? usable(p.state) ?? usable(p.country);
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

// --- Where am I: country / state / ocean under the centre --------------------

const regionEl = document.querySelector<HTMLElement>('#region')!;
/** Look the region up again only after moving this far. */
const REGION_STEP_M = 2_000;
let regionId = -1;
let regionAt: { x: number; y: number } | null = null;
let regionTimer = 0;
/** The arrival's own region is announced by the intro or card, not again. */
let regionQuiet = true;

/** After panning settles: at sea, the ocean; on land, state and country. */
function scheduleRegion() {
  clearTimeout(regionTimer);
  regionTimer = window.setTimeout(() => {
    if (regionAt && Math.hypot(cx - regionAt.x, cy - regionAt.y) * metresPerPx() < REGION_STEP_M) return;
    regionAt = { x: cx, y: cy };
    const req: NameRequest = { type: 'name', id: ++nextId, z: zoom, x: cx, y: cy, oceanOnly: true };
    regionId = req.id;
    worker.postMessage(req);
  }, 400);
}

async function regionNamed({ id, name }: NameResult) {
  if (name) return showRegion(name, { eyebrow: 'New waters discovered', name });
  const { lat, lon } = worldToLonLat(cx, cy, zoom);
  let text = '';
  try {
    const res = await fetch(`/api/reverse?lat=${lat.toFixed(4)}&lon=${lon.toFixed(4)}`);
    const p = ((await res.json()) as { features: { properties: Record<string, string> }[] })
      .features[0]?.properties;
    const state = usable(p?.state);
    const country = usable(p?.country);
    text = [state, country !== state ? country : undefined].filter(Boolean).join(', ');
    if (id === regionId && text) {
      const name = state ?? country!;
      return showRegion(text, {
        eyebrow: 'New region discovered',
        name,
        detail: state && country && country !== state ? country : undefined,
      });
    }
  } catch {
    // offline or no server: just the coordinates
  }
  if (id === regionId) showRegion(text);
}

/** Show where we are; the first visit to a region plays its discovery card. */
function showRegion(text: string, card?: { eyebrow: string; name: string; detail?: string }) {
  regionEl.textContent = text;
  regionEl.classList.toggle('empty', !text);
  if (!card) return;
  const key = `region:${text}`;
  if (regionQuiet) {
    regionQuiet = false;
    markDiscovered(key);
    return;
  }
  if (discovered.has(key) || cardsPaused() || !document.body.classList.contains('loaded')) return;
  markDiscovered(key);
  playCard(card);
}

worker.onmessage = async (e: MessageEvent<SceneResult | SceneProgress | NameResult>) => {
  const msg = e.data;
  if (msg.type === 'named') return msg.id === regionId ? regionNamed(msg) : named(msg);
  if (msg.id === previewId) {
    if (msg.type === 'scene' && !scene) {
      preview = buildScene(msg, emptyFeatures, 1);
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
  await acceptScene(msg);
};

/** A detailed scene is ready (from the worker, or a pre-built favourite). */
async function acceptScene(msg: SceneResult) {
  await fontsReady;
  if (msg.id !== detailId) return;
  detailId = -1;
  pending = null;
  document.body.classList.remove('busy');
  const keep = new Set(scene?.features.labels.map((p) => labelKey(p.label)));
  const features = buildFeatures(ctx, msg.tiles, msg.labels, msg.width, msg.height, keep);
  lastScene = msg;
  // One colour scale per arrival; re-fit only on reaching wholly new terrain.
  if (range && (msg.max < range.lo || msg.min > range.hi)) range = null;
  scene = buildScene(msg, features, DS, range ?? undefined);
  range ??= { lo: scene.lo, hi: scene.hi };
  exportButton.disabled = false;
  atlas.addPeaks(msg.labels, msg.originX, msg.originY, msg.z);
  updateLegend(scene.lo, scene.hi, scene.minor, scene.major);
  if (!document.body.classList.contains('loaded')) settleArrival();
  reveal();
  requestDraw();
  ensure();
}

// --- Panning ----------------------------------------------------------------

/** Recent direction and speed of travel, in world pixels (see request()). */
const lead = { x: 0, y: 0 };
const clampLead = (v: number) => Math.max(-LEAD_MAX, Math.min(LEAD_MAX, v));

/**
 * Above this pan speed (screen px per ms, smoothed) no new regions are
 * requested: a fling would only queue tiles for places already left behind.
 * The map catches up as soon as the pan slows, or SETTLE_MS after it stops.
 */
const FAST_PX_PER_MS = 1.5;
const SETTLE_MS = 120;
let speed = 0;
let lastMoveAt = 0;
let settleTimer = 0;

function move(dx: number, dy: number) {
  cx += dx;
  cy += dy;
  const now = performance.now();
  const dt = now - lastMoveAt;
  lastMoveAt = now;
  const v = Math.hypot(dx, dy) / Math.max(dt, 1);
  speed = dt > 100 ? v : speed * 0.6 + v * 0.4; // a pause restarts the average
  scheduleRegion();
  lead.x = clampLead(lead.x * 0.7 + dx * LEAD_GAIN);
  lead.y = clampLead(lead.y * 0.7 + dy * LEAD_GAIN);
  requestDraw();
  clearTimeout(settleTimer);
  if (speed < FAST_PX_PER_MS) ensure();
  else settleTimer = window.setTimeout(ensure, SETTLE_MS);
  syncUrl();
}

/** Ground metres per screen pixel at the centre of the view. */
function metresPerPx() {
  const { lat } = worldToLonLat(cx, cy, zoom);
  return (40_075_016.686 * Math.cos((lat * Math.PI) / 180)) / (TILE * 2 ** zoom);
}

// --- Stepped zoom ------------------------------------------------------------
//
// A handful of fixed scales (ZOOMS), never continuous. A step shows the scene
// on screen scaled ×2 or ×½ at once (draw() scales any scene to the view's
// zoom) while the crisp scene for the new level loads in behind it.

const zoomIn = document.querySelector<HTMLButtonElement>('#zoom-in')!;
const zoomOut = document.querySelector<HTMLButtonElement>('#zoom-out')!;

function updateZoomControls() {
  zoomIn.disabled = zoom >= ZOOMS[ZOOMS.length - 1];
  zoomOut.disabled = zoom <= ZOOMS[0];
}

/** Step to `next`, keeping the world point under screen (ax, ay) in place. */
function zoomTo(next: number, ax = w / 2, ay = h / 2) {
  if (!ZOOMS.includes(next) || next === zoom) return;
  const f = 2 ** (next - zoom);
  cx = (cx - w / 2 + ax) * f - ax + w / 2;
  cy = (cy - h / 2 + ay) * f - ay + h / 2;
  arrival.x *= f;
  arrival.y *= f;
  zoom = next;
  updateZoomControls();
  track('zoom', { level: next });
  // The old scene stays as the stand-in; the in-flight request is for the old
  // zoom, so forget it and ask for this one.
  detailId = -1;
  range = null;
  lead.x = lead.y = 0;
  regionAt = null;
  retirePrerender();
  requestDraw();
  ensure();
  scheduleRegion();
  syncUrl();
}

zoomIn.addEventListener('click', () => zoomTo(zoom + 1));
zoomOut.addEventListener('click', () => zoomTo(zoom - 1));

/** Scale bar: the largest 1/2/5 × 10ⁿ distance that fits in MAX_BAR px. */
const scaleBar = document.querySelector<HTMLElement>('.scalebar')!;
const scaleLabel = scaleBar.querySelector<HTMLElement>('span')!;
const MAX_BAR = 72;
let scaleShown = '';
function showScale(lat: number) {
  const mpp = (40_075_016.686 * Math.cos((lat * Math.PI) / 180)) / (TILE * 2 ** zoom);
  const max = MAX_BAR * mpp;
  const pow = 10 ** Math.floor(Math.log10(max));
  const metres = [5, 2, 1].map((m) => m * pow).find((m) => m <= max)!;
  const text = metres >= 1000 ? `${fmt.format(metres / 1000)} km` : `${fmt.format(metres)} m`;
  const width = `${(metres / mpp).toFixed(1)}px`;
  if (text + width === scaleShown) return;
  scaleShown = text + width;
  scaleLabel.textContent = text;
  scaleBar.style.setProperty('--bar', width);
}

// --- Famous peaks are links to their summary pages ------------------------------

/** A curated summit's label must sit this close (atlas px, ≈3 km) to count as it. */
const CURATED_MATCH_PX = 110;
/** Hit slop around a label's box, in screen pixels. */
const LABEL_SLOP = 4;

/** The curated summit whose label (or marker) is under screen point (sx, sy). */
function famousPeakAt(sx: number, sy: number) {
  if (!scene || scene.zoom !== zoom) return null; // not while a stand-in is showing
  const x = cx - w / 2 + sx - scene.originX; // scene pixels
  const y = cy - h / 2 + sy - scene.originY;
  const f = 2 ** (ATLAS_ZOOM - zoom);
  for (const { label, box } of scene.features.labels) {
    if (label.kind !== 'peak') continue;
    if (x < box[0] - LABEL_SLOP || x > box[2] + LABEL_SLOP) continue;
    if (y < box[1] - LABEL_SLOP || y > box[3] + LABEL_SLOP) continue;
    const ax = (scene.originX + label.x) * f;
    const ay = (scene.originY + label.y) * f;
    const peak = atlas.curatedAt(ax, ay, CURATED_MATCH_PX);
    if (peak) return peak;
  }
  return null;
}

// --- Pointer input: drag pans, pinch steps zoom (once per gesture) -----------

const pointers = new Map<number, { x: number; y: number }>();
let drag: { x: number; y: number } | null = null;
/** The press that may turn out to be a click (not a drag or a pinch). */
let press: { x: number; y: number; at: number; moved: number } | null = null;
const CLICK_MOVE_PX = 6;
const CLICK_MS = 400;
let pinch: { spread: number; stepped: boolean } | null = null;
/** Spread change that counts as a pinch step (in or out). */
const PINCH_IN = 1.4;
const PINCH_OUT = 0.7;

const spread = () => {
  const [a, b] = [...pointers.values()];
  return Math.hypot(a.x - b.x, a.y - b.y);
};

canvas.addEventListener('pointerdown', (e) => {
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  canvas.setPointerCapture(e.pointerId);
  if (pointers.size === 1) {
    drag = { x: e.clientX, y: e.clientY };
    press = { x: e.clientX, y: e.clientY, at: performance.now(), moved: 0 };
    canvas.classList.add('dragging');
  } else if (pointers.size === 2) {
    drag = null;
    press = null;
    pinch = { spread: spread(), stepped: false };
  }
});
canvas.addEventListener('pointermove', (e) => {
  if (!pointers.has(e.pointerId)) {
    // Hovering (no button down): famous peaks show as links.
    if (e.pointerType === 'mouse') {
      canvas.classList.toggle('linkable', famousPeakAt(e.clientX, e.clientY) !== null);
    }
    return;
  }
  if (press) press.moved = Math.max(press.moved, Math.hypot(e.clientX - press.x, e.clientY - press.y));
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pinch && pointers.size >= 2) {
    const ratio = spread() / pinch.spread;
    if (!pinch.stepped && (ratio > PINCH_IN || ratio < PINCH_OUT)) {
      pinch.stepped = true;
      const [a, b] = [...pointers.values()];
      zoomTo(zoom + (ratio > 1 ? 1 : -1), (a.x + b.x) / 2, (a.y + b.y) / 2);
    }
    return;
  }
  if (!drag) return;
  move(drag.x - e.clientX, drag.y - e.clientY);
  drag = { x: e.clientX, y: e.clientY };
});
const endPointer = (e: PointerEvent) => {
  pointers.delete(e.pointerId);
  // A short, still press on a famous peak opens its summary.
  const click =
    e.type === 'pointerup' &&
    press !== null &&
    pointers.size === 0 &&
    press.moved < CLICK_MOVE_PX &&
    performance.now() - press.at < CLICK_MS;
  press = null;
  if (click) {
    const peak = famousPeakAt(e.clientX, e.clientY);
    if (peak) location.assign(`/mountains/${peak.key}/`);
  }
  if (pointers.size < 2) pinch = null;
  // Lifting one finger of a pinch continues as a drag from where it is.
  const rest = [...pointers.values()][0];
  drag = rest ? { ...rest } : null;
  if (!rest) canvas.classList.remove('dragging');
};
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);

// --- Keyboard: arrows pan, + / − step zoom -----------------------------------

const STEP = 160;
const KEYS: Record<string, [number, number]> = {
  ArrowLeft: [-STEP, 0],
  ArrowRight: [STEP, 0],
  ArrowUp: [0, -STEP],
  ArrowDown: [0, STEP],
};
const ZOOM_KEYS: Record<string, number> = { '+': 1, '=': 1, '-': -1, _: -1 };
window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement || e.ctrlKey || e.metaKey) return;
  const step = ZOOM_KEYS[e.key];
  if (step) {
    e.preventDefault();
    zoomTo(zoom + step);
    return;
  }
  const d = KEYS[e.key];
  if (!d) return;
  e.preventDefault();
  move(d[0], d[1]);
});

// --- Wheel / trackpad: one step per gesture, toward the cursor ---------------

/** Accumulated scroll needed for a step (trackpad pinch deltas are small). */
const WHEEL_STEP = 60;
/** After a step, input is ignored until the gesture has been quiet this long. */
const WHEEL_QUIET_MS = 220;
let wheelSum = 0;
let wheelLockedUntil = 0;
window.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault(); // the page itself never scrolls or zooms
    const now = performance.now();
    if (now < wheelLockedUntil) {
      wheelLockedUntil = now + WHEEL_QUIET_MS; // still the same gesture
      return;
    }
    const lines = e.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : 1;
    wheelSum += e.deltaY * lines * (e.ctrlKey ? 6 : 1);
    if (Math.abs(wheelSum) < WHEEL_STEP) return;
    const dir = wheelSum < 0 ? 1 : -1;
    wheelSum = 0;
    wheelLockedUntil = now + WHEEL_QUIET_MS + 150;
    zoomTo(zoom + dir, e.clientX, e.clientY);
  },
  { passive: false },
);
document.addEventListener('gesturestart', (e) => e.preventDefault());

window.addEventListener('resize', resize);
createSearch(document.querySelector<HTMLElement>('#search')!, (place: Place) => {
  track('search_select', { kind: place.kind, name: place.name });
  arrive(place, { push: true, announce: true, keepZoom: true });
});
createShare(document.querySelector<HTMLButtonElement>('#share')!, () => {
  const link = currentLink();
  history.replaceState(null, '', link.url);
  return { url: location.href, title: link.title };
});
const minimap = createMinimap(document.querySelector<HTMLElement>('.minimap')!);

/** The last detailed scene's raw data, so labels can be re-laid out (text size). */
let lastScene: SceneResult | null = null;
setLabelScale(storedScale());
createTextSize(document.querySelector<HTMLElement>('.textsize')!, (scale) => {
  setLabelScale(scale);
  if (!scene || !lastScene) return;
  const m = lastScene;
  const keep = new Set(scene.features.labels.map((p) => labelKey(p.label)));
  scene = { ...scene, features: buildFeatures(ctx, m.tiles, m.labels, m.width, m.height, keep) };
  requestDraw();
});

const exportButton = document.querySelector<HTMLButtonElement>('#export')!;
createExport(exportButton, () => {
  if (!scene) return null;
  const { lat, lon } = worldToLonLat(cx, cy, zoom);
  const near = Math.hypot(cx - arrival.x, cy - arrival.y) < Math.max(w, h) / 2;
  return { scene, x: cx - w / 2, y: cy - h / 2, w, h, zoom, name: near ? arrival.name : undefined, lat, lon };
});

// The nav's favourites arrive in place on the map (they're plain links elsewhere).
const favs = document.querySelector<HTMLDetailsElement>('.favs');
favs?.addEventListener('click', (e) => {
  const a = (e.target as HTMLElement).closest<HTMLAnchorElement>('a[data-favorite]');
  if (!a) return;
  const spot = readSpot(new URL(a.href).search);
  if (!spot) return;
  e.preventDefault();
  favs.open = false;
  track('favourite_open', { name: spot.name ?? '' });
  arrive(spot, { push: true, announce: true });
});
document.addEventListener('pointerdown', (e) => {
  if (favs?.open && !favs.contains(e.target as Node)) favs.open = false;
});

const landing = () => readSpot() ?? pageSpot ?? START;
window.addEventListener('popstate', () => arrive(landing(), { announce: true }));

greet();

w = window.innerWidth;
h = window.innerHeight;
// A shared link lands where it was shared from; otherwise the page's own place.
arrive(landing());
resize();
