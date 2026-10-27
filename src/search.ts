import { SEARCH_TAGS, SEARCH_URL } from './config';

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
const KIND_WEIGHT: Record<string, number> = { country: 2, volcano: 1, 'mountain range': 1 };
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

const MIN_CHARS = 2;
const DEBOUNCE_MS = 250;
const LIMIT = 7;

// Photon is a shared free service: debounce, abort superseded queries and
// remember answers so retyping or backspacing costs nothing.
const cache = new Map<string, Place[]>();

async function query(q: string, signal: AbortSignal): Promise<Place[]> {
  const key = q.toLowerCase();
  const hit = cache.get(key);
  if (hit) return hit;

  const url = new URL(SEARCH_URL);
  url.searchParams.set('q', q);
  url.searchParams.set('limit', String(LIMIT));
  url.searchParams.set('lang', 'en');
  for (const tag of SEARCH_TAGS) url.searchParams.append('osm_tag', tag);

  const res = await fetch(url, { signal });
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
  const ranked = rank(places, q);
  cache.set(key, ranked);
  return ranked;
}

const escape = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** Wires the search box; `onPick` receives the chosen place. */
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
    if (e.key === '/' && document.activeElement !== input) {
      e.preventDefault();
      input.focus();
    }
  });

  close();
}
