import { INK } from './config';
import { MUSEUM_ICON } from './features';

/**
 * A museum's card: its photo, name and a few sentences from Wikipedia,
 * beside the museum on the map (a sheet along the bottom on phones). The
 * server finds the article (crates/server/src/museum_info.rs).
 */

export interface MuseumInfo {
  title: string;
  description?: string;
  extract: string;
  url: string;
  distance: number;
  photo?: {
    thumb: { source: string; width: number; height: number };
    original?: { source: string; width: number; height: number };
    page: string;
    artist?: string;
    license: string;
    licenseUrl?: string;
  };
}

export interface MuseumSpot {
  name: string;
  town?: string;
  lat: number;
  lon: number;
}

const INFO_URL = '/api/museum-info';
/** The card's corner sits this far from the museum it describes. */
const GAP = 22;
const EDGE = 16;

const cache = new Map<string, Promise<MuseumInfo | null>>();

function fetchInfo({ name, lat, lon }: MuseumSpot): Promise<MuseumInfo | null> {
  const key = `${name}@${lat.toFixed(4)},${lon.toFixed(4)}`;
  let hit = cache.get(key);
  if (!hit) {
    const q = new URLSearchParams({ name, lat: lat.toFixed(5), lon: lon.toFixed(5) });
    hit = fetch(`${INFO_URL}?${q}`)
      .then((res) => {
        if (!res.ok) throw new Error(`museum-info ${res.status}`);
        return res.json() as Promise<MuseumInfo | null>;
      })
      .catch(() => {
        // A failure isn't an answer ("no article" is): let the next open ask again.
        cache.delete(key);
        return null;
      });
    cache.set(key, hit);
  }
  return hit;
}

const escape = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

const icon = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="${MUSEUM_ICON}" fill="${INK.border}" fill-rule="evenodd"/></svg>`;

export function createMuseumCard(root: HTMLElement) {
  let openFor: MuseumSpot | null = null;
  let at = { x: 0, y: 0 };

  const hide = () => {
    openFor = null;
    root.classList.remove('open');
  };
  root.addEventListener('click', (e) => {
    if ((e.target as Element).closest('.close')) hide();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && openFor) hide();
  });
  addEventListener('resize', () => openFor && place());

  /** Beside the museum, on whichever side has room; phones use a sheet (CSS). */
  function place() {
    if (matchMedia('(max-width: 600px)').matches) {
      root.style.translate = '';
      return;
    }
    const [w, h] = [root.offsetWidth, root.offsetHeight];
    const right = at.x + GAP + w <= innerWidth - EDGE;
    const left = right ? at.x + GAP : Math.max(EDGE, at.x - GAP - w);
    const top = Math.max(EDGE + 56, Math.min(at.y - h / 2, innerHeight - h - EDGE));
    root.style.translate = `${left}px ${top}px`;
    root.style.transformOrigin = `${at.x - left}px ${at.y - top}px`;
  }

  function render(spot: MuseumSpot, info: MuseumInfo | null | undefined) {
    const eyebrow = `<p class="eyebrow">${icon}<span>Museum${spot.town ? ` · ${escape(spot.town)}` : ''}</span></p>`;
    const close = `<button class="close" type="button" aria-label="Close">×</button>`;
    if (info === undefined) {
      root.innerHTML = `${close}<div class="photo loading"></div><div class="body">${eyebrow}
        <h2>${escape(spot.name)}</h2><p class="shimmer"></p><p class="shimmer"></p><p class="shimmer short"></p></div>`;
      return;
    }
    if (!info) {
      root.innerHTML = `${close}<div class="body">${eyebrow}<h2>${escape(spot.name)}</h2>
        <p class="extract quiet">Nothing written about it on Wikipedia yet.</p>
        <footer><a href="https://en.wikipedia.org/w/index.php?search=${encodeURIComponent(spot.name)}" target="_blank" rel="noopener">Search Wikipedia ↗</a></footer></div>`;
      return;
    }
    const p = info.photo;
    const credit = p
      ? `<figcaption><a href="${escape(p.page)}" target="_blank" rel="noopener">${p.artist ? `${escape(p.artist)} · ` : ''}${escape(p.license)}</a></figcaption>`
      : '';
    root.innerHTML = `${close}
      ${p ? `<figure class="photo"><img src="${escape(p.thumb.source)}" alt="${escape(info.title)}" width="${p.thumb.width}" height="${p.thumb.height}" decoding="async">${credit}</figure>` : ''}
      <div class="body">${eyebrow}
        <h2>${escape(info.title)}</h2>
        ${info.description ? `<p class="description">${escape(info.description)}</p>` : ''}
        <p class="extract">${escape(info.extract)}</p>
        <footer><a href="${escape(info.url)}" target="_blank" rel="noopener">Read on Wikipedia ↗</a><span>Text CC BY-SA</span></footer>
      </div>`;
    const img = root.querySelector('img');
    if (img) {
      const done = () => img.classList.add('loaded');
      if (img.complete) done();
      else img.addEventListener('load', done, { once: true });
    }
  }

  return {
    /** Open for `spot`, beside screen point (x, y) where the museum is drawn. */
    show(spot: MuseumSpot, x: number, y: number) {
      openFor = spot;
      at = { x, y };
      root.classList.remove('open');
      render(spot, undefined);
      place();
      void root.offsetWidth; // start the entrance from closed
      root.classList.add('open');
      fetchInfo(spot).then((info) => {
        if (openFor !== spot) return; // closed, or another museum since
        render(spot, info);
        place();
      });
    },
    hide,
    get open() {
      return openFor !== null;
    },
  };
}
