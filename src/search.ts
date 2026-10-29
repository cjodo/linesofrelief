import { SEARCH_URL } from './config';
import { parseCoords } from './coords';

export interface Place {
  name: string;
  lat: number;
  lon: number;
  kind: string;
  context: string;
}

interface PhotonFeature {
  geometry: { coordinates: [number, number] };
  properties: {
    name?: string;
    osm_value?: string;
    state?: string;
    country?: string;
  };
}

/**
 * Photon ranks by text match alone, so an exact-named hill in Denmark beats
 * Kilimanjaro. Nudge the landmarks up: countries, volcanoes and ranges over
 * generic peaks, and peaks that sit in a region of the searched name.
 */
const KIND_WEIGHT: Record<string, number> = {
  country: 2,
  city: 1.5,
  volcano: 1,
  'mountain range': 1,
  lake: 1,
  town: 0.5,
  reservoir: 0.5,
};
/** Results shown (the server asks for a few more, to rank across kinds). */
const SHOWN = 7;
const CONTEXT_WEIGHT = 1.5;
const ORDER_WEIGHT = 0.1;

function rank(places: Place[], q: string): Place[] {
  const needle = q.toLowerCase();
  const score = (p: Place, i: number) =>
    (KIND_WEIGHT[p.kind] ?? 0) +
    (p.context.toLowerCase().includes(needle) ? CONTEXT_WEIGHT : 0) -
    i * ORDER_WEIGHT;
  return places
    .map((p, i) => ({ p, s: score(p, i) }))
    .sort((a, b) => b.s - a.s)
    .map(({ p }) => p);
}

/** Web mercator stops short of the poles; coordinates past this are pulled in. */
const MAX_LAT = 85;
const deg = (v: number, pos: string, neg: string) => `${Math.abs(v).toFixed(4)}° ${v >= 0 ? pos : neg}`;

/** Typed coordinates as a search result: the map names the place on arrival. */
function coordinatePlace({ lat, lon }: { lat: number; lon: number }): Place {
  const clamped = Math.max(-MAX_LAT, Math.min(MAX_LAT, lat));
  return {
    name: `${deg(clamped, 'N', 'S')}, ${deg(lon, 'E', 'W')}`,
    lat: clamped,
    lon,
    kind: 'coordinates',
    context: clamped === lat ? '' : `as near the pole as the map goes`,
  };
}

const MIN_CHARS = 2;
const DEBOUNCE_MS = 250;

// The server caches answers for everyone; here we debounce, abort superseded
// queries and remember answers so retyping or backspacing costs nothing.
const cache = new Map<string, Place[]>();

async function query(q: string, signal: AbortSignal): Promise<Place[]> {
  const key = q.toLowerCase();
  const hit = cache.get(key);
  if (hit) return hit;

  const res = await fetch(`${SEARCH_URL}?q=${encodeURIComponent(q)}`, { signal });
  if (!res.ok) return [];
  const { features } = (await res.json()) as { features: PhotonFeature[] };

  const seen = new Set<string>();
  const places: Place[] = [];
  for (const { geometry, properties: p } of features) {
    if (!p.name) continue;
    const kind = (p.osm_value ?? 'peak').replace('_', ' ');
    const context = kind === 'country' ? '' : [p.state, p.country].filter(Boolean).join(', ');
    const id = `${p.name}|${context}|${kind}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const [lon, lat] = geometry.coordinates;
    places.push({ name: p.name, lat, lon, kind, context });
  }
  const ranked = rank(places, q).slice(0, SHOWN);
  cache.set(key, ranked);
  return ranked;
}

/** Longest first: the box shows the longest that fits at its width and text size. */
const PLACEHOLDERS = ['Find a peak, lake, town or country', 'Find a peak, lake or town', 'Find a place'];
let measure: CanvasRenderingContext2D | null = null;

function fitPlaceholder(input: HTMLInputElement) {
  const cs = getComputedStyle(input);
  const room = input.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  if (room <= 0) return;
  measure ??= document.createElement('canvas').getContext('2d')!;
  measure.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
  measure.letterSpacing = cs.letterSpacing;
  input.placeholder =
    PLACEHOLDERS.find((p) => measure!.measureText(p).width <= room) ?? PLACEHOLDERS.at(-1)!;
}

const escape = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/**
 * Wires the search box; `onPick` receives the chosen place. Returns a hook to
 * re-fit the placeholder after the text size changes.
 */
export function createSearch(root: HTMLElement, onPick: (place: Place) => void) {
  const input = root.querySelector<HTMLInputElement>('input')!;
  const list = root.querySelector<HTMLUListElement>('ul')!;
  let results: Place[] = [];
  let active = -1;
  let timer = 0;
  let controller: AbortController | null = null;

  function render() {
    list.hidden = results.length === 0 && !root.classList.contains('empty');
    input.setAttribute('aria-expanded', String(!list.hidden));
    list.innerHTML = results.length
      ? results
          .map(
            (p, i) => `
        <li id="result-${i}" role="option" aria-selected="${i === active}">
          <span class="name">${escape(p.name)}</span>
          <span class="meta">${escape(p.kind)}${p.context ? `<i>·</i>${escape(p.context)}` : ''}</span>
        </li>`,
          )
          .join('')
      : '<li class="none">Nothing on the map by that name</li>';
    if (active >= 0) input.setAttribute('aria-activedescendant', `result-${active}`);
    else input.removeAttribute('aria-activedescendant');
  }

  function close() {
    results = [];
    active = -1;
    root.classList.remove('empty');
    render();
  }

  function pick(i: number) {
    const place = results[i];
    if (!place) return;
    input.value = '';
    close();
    input.blur();
    onPick(place);
  }

  input.addEventListener('input', () => {
    clearTimeout(timer);
    controller?.abort();
    const q = input.value.trim();
    // Coordinates need no lookup: offer them at once.
    const at = parseCoords(q);
    if (at) {
      results = [coordinatePlace(at)];
      active = 0;
      root.classList.remove('empty');
      return render();
    }
    if (q.length < MIN_CHARS) return close();
    timer = window.setTimeout(async () => {
      controller = new AbortController();
      root.classList.add('searching');
      try {
        results = await query(q, controller.signal);
        active = results.length ? 0 : -1;
        root.classList.toggle('empty', results.length === 0);
        render();
      } catch {
        // aborted by a newer keystroke, or offline: leave the list as it was
      } finally {
        root.classList.remove('searching');
      }
    }, DEBOUNCE_MS);
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!results.length) return;
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      active = (active + step + results.length) % results.length;
      render();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      pick(active);
    } else if (e.key === 'Escape') {
      input.value = '';
      close();
      input.blur();
    }
  });

  // pointerdown beats the input's blur, so the click still lands.
  list.addEventListener('pointerdown', (e) => {
    const li = (e.target as HTMLElement).closest<HTMLElement>('li[role="option"]');
    if (!li) return;
    e.preventDefault();
    pick(Number(li.id.slice('result-'.length)));
  });

  input.addEventListener('blur', () => setTimeout(close, 120));

  window.addEventListener('keydown', (e) => {
    // Not while typing in another box (coordinates may be split by a slash).
    if (e.key === '/' && !(document.activeElement instanceof HTMLInputElement)) {
      e.preventDefault();
      input.focus();
    }
  });

  // The placeholder shortens to fit: narrow screens, larger text.
  const fit = () => fitPlaceholder(input);
  new ResizeObserver(fit).observe(input);
  document.fonts.ready.then(fit, () => {});

  close();
  return fit;
}
