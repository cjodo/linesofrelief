import { TILE, ZOOM } from './config';
import { detailOf, PEAKS } from '../site/peaks';
import type { Label } from './tiles';
import { lonLatToWorld, worldToLonLat } from './tiles';

/**
 * An index of the region's important mountains, built up as the map is
 * explored, and the "new area discovered" title card that plays when one
 * reaches the middle of the screen.
 */

export interface Landmark {
  key: string;
  name: string;
  /** World pixels at the fixed zoom. */
  x: number;
  y: number;
  ele?: number;
  detail: string;
  /** Curated summits are always important. */
  curated: boolean;
}

/** A summit is important if nothing known within this radius stands higher. */
const DOMINANCE_M = 10_000;
/** Two labels closer than this are the same summit. */
const SAME_PX = 40;
/** How close to the centre of the screen counts as "arrived". */
export const CENTRE_PX = 70;

const fmt = new Intl.NumberFormat('en-US');
const STORE = 'topography:discovered';

/** Metres per world pixel at a world y, at the fixed zoom. */
function metresPerPx(y: number) {
  const { lat } = worldToLonLat(0, y, ZOOM);
  return (40_075_016.686 * Math.cos((lat * Math.PI) / 180)) / (TILE * 2 ** ZOOM);
}

export class Atlas {
  private marks: Landmark[] = [];

  constructor() {
    for (const p of PEAKS) {
      const { x, y } = lonLatToWorld(p.lon, p.lat, ZOOM);
      this.marks.push({ key: p.slug, name: p.name, x, y, ele: p.ele, detail: detailOf(p), curated: true });
    }
  }

  /** Index the summits a scene carried (positions relative to its origin). */
  addPeaks(labels: Label[], originX: number, originY: number) {
    for (const l of labels) {
      if (l.kind !== 'peak' || l.ele === undefined) continue;
      const x = originX + l.x;
      const y = originY + l.y;
      if (this.marks.some((m) => Math.hypot(m.x - x, m.y - y) < SAME_PX)) continue;
      const { lat, lon } = worldToLonLat(x, y, ZOOM);
      this.marks.push({
        key: `${l.name}@${lat.toFixed(2)},${lon.toFixed(2)}`,
        name: l.name,
        x,
        y,
        ele: l.ele,
        detail: `${fmt.format(l.ele)} m`,
        curated: false,
      });
    }
  }

  private important(m: Landmark) {
    if (m.curated) return true;
    const r = DOMINANCE_M / metresPerPx(m.y);
    return !this.marks.some(
      (o) => o !== m && (o.ele ?? 0) > (m.ele ?? 0) && Math.hypot(o.x - m.x, o.y - m.y) < r,
    );
  }

  /** The important summit nearest (x, y) within `radius` world pixels. */
  near(x: number, y: number, radius: number): Landmark | null {
    let best: Landmark | null = null;
    let bestD = radius;
    for (const m of this.marks) {
      const d = Math.hypot(m.x - x, m.y - y);
      if (d < bestD && this.important(m)) {
        best = m;
        bestD = d;
      }
    }
    return best;
  }
}

// --- Remembering what has been found -----------------------------------------

function load(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(STORE) ?? '[]') as string[]);
  } catch {
    return new Set();
  }
}

export const discovered = load();

export function markDiscovered(key: string) {
  discovered.add(key);
  try {
    localStorage.setItem(STORE, JSON.stringify([...discovered]));
  } catch {
    // private mode or storage full: discoveries just won't persist
  }
}

// --- The title card ----------------------------------------------------------

export interface Card {
  eyebrow: string;
  name: string;
  detail?: string;
}

const HOLD_MS = 3200;

export function createCard(root: HTMLElement) {
  const eyebrow = root.querySelector<HTMLElement>('.eyebrow')!;
  const name = root.querySelector<HTMLElement>('.name')!;
  const detail = root.querySelector<HTMLElement>('.detail')!;
  let timer = 0;

  return function show(card: Card) {
    clearTimeout(timer);
    root.classList.remove('on', 'off');
    void root.offsetWidth; // restart the animations

    eyebrow.textContent = card.eyebrow;
    detail.textContent = card.detail ?? '';
    name.setAttribute('aria-label', card.name);
    // One span per letter so the name can resolve letter by letter.
    name.replaceChildren(
      ...[...card.name].map((ch, i) => {
        const s = document.createElement('span');
        s.textContent = ch;
        s.style.setProperty('--i', String(i));
        s.setAttribute('aria-hidden', 'true');
        return s;
      }),
    );

    root.hidden = false;
    root.classList.add('on');
    timer = window.setTimeout(() => {
      root.classList.add('off');
      timer = window.setTimeout(() => (root.hidden = true), 1400);
    }, HOLD_MS + card.name.length * 40);
  };
}
