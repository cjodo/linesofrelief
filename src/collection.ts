import { INK } from './config';
import { MUSEUM_ICON } from './features';
import type { Label } from './tiles';

/**
 * A town's museums: a small inventory that grows out of the badge behind
 * its dot, by the pointer. Pinned, it holds still and takes clicks: hovering
 * the town pins it at once (a tap does on touch), and leaving both town and
 * list closes it.
 */

/** Slots shown before "and N more". */
const MAX_SLOTS = 8;
/** Leaving the town closes it after this long: time to cross into the list. */
const HIDE_MS = 300;
/** The panel's corner sits this far below-right of the pointer's tip. */
const TRAIL = { x: 16, y: 18 };
const EDGE = 12;

const icon = (cls = '') =>
  `<svg class="${cls}" viewBox="0 0 16 16" aria-hidden="true"><path d="${MUSEUM_ICON}" fill="${INK.border}" fill-rule="evenodd"/></svg>`;

export interface Collection {
  /**
   * Open for a town, growing from its badge at screen `from`, to sit by the
   * pointer at `at`. Already open for this town: just follow the pointer.
   */
  show(key: string, town: string, museums: Label[], from: Point, at: Point): void;
  /** Hold still and take clicks. */
  pin(): void;
  /** Close after HIDE_MS, unless the pointer comes back to the town or the list. */
  hideSoon(): void;
  hide(): void;
  readonly openKey: string | null;
  readonly pinned: boolean;
}

interface Point {
  x: number;
  y: number;
}

export function createCollection(root: HTMLElement, onPick: (museum: Label) => void): Collection {
  let openKey: string | null = null;
  let pinned = false;
  let timer = 0;
  let shown: Label[] = [];
  let size = { w: 0, h: 0 };

  const hide = () => {
    clearTimeout(timer);
    openKey = null;
    pinned = false;
    root.classList.remove('open', 'pinned');
  };
  root.addEventListener('pointerenter', () => clearTimeout(timer));
  // Leaving the list (even onto the legend or nav, not the map) closes it too.
  root.addEventListener('pointerleave', (e) => {
    if (e.pointerType === 'mouse') api.hideSoon();
  });
  root.addEventListener('click', (e) => {
    const slot = (e.target as Element).closest<HTMLElement>('[data-slot]');
    if (!slot) return;
    const museum = shown[Number(slot.dataset.slot)];
    hide();
    onPick(museum);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && openKey) hide();
  });

  /** Beside the pointer, flipping to stay on screen. */
  function place(at: Point) {
    const right = at.x + TRAIL.x + size.w > innerWidth - EDGE;
    const below = at.y + TRAIL.y + size.h > innerHeight - EDGE;
    const left = right ? at.x - TRAIL.x - size.w : at.x + TRAIL.x;
    const top = below ? at.y - TRAIL.y - size.h : at.y + TRAIL.y;
    root.style.translate = `${Math.max(EDGE, left)}px ${Math.max(EDGE, top)}px`;
    return { left: Math.max(EDGE, left), top: Math.max(EDGE, top) };
  }

  const api: Collection = {
    get openKey() {
      return openKey;
    },
    get pinned() {
      return pinned;
    },
    show(key, town, museums, from, at) {
      clearTimeout(timer);
      if (key === openKey) {
        if (!pinned) place(at);
        return;
      }
      openKey = key;
      pinned = false;
      shown = museums.slice(0, MAX_SLOTS);
      const more = museums.length - shown.length;
      root.innerHTML = `
        <header>${icon('mark')}<span class="town">${escape(town)}</span>
          <span class="count">${museums.length} ${museums.length === 1 ? 'museum' : 'museums'}</span></header>
        <ol>${shown
          .map(
            (m, i) =>
              `<li style="--i:${i}"><button type="button" data-slot="${i}" tabindex="-1"><span class="slot">${icon()}</span><span class="name">${escape(m.name)}</span></button></li>`,
          )
          .join('')}</ol>
        ${more > 0 ? `<p class="more" style="--i:${shown.length}">and ${more} more</p>` : ''}`;

      root.classList.remove('open', 'pinned');
      root.style.translate = '0px 0px';
      // Layout size: the closed panel is scaled down, which offset sizes ignore.
      size = { w: root.offsetWidth, h: root.offsetHeight };
      const { left, top } = place(at);
      // It grows out of the badge, wherever the panel lands.
      root.style.transformOrigin = `${from.x - left}px ${from.y - top}px`;
      void root.offsetWidth; // start from closed
      root.classList.add('open');
    },
    pin() {
      if (!openKey) return;
      pinned = true;
      root.classList.add('pinned');
      for (const b of root.querySelectorAll('button')) b.tabIndex = 0;
    },
    hideSoon() {
      if (!openKey) return;
      clearTimeout(timer);
      timer = window.setTimeout(hide, HIDE_MS);
    },
    hide,
  };
  return api;
}

function escape(s: string) {
  return s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
}
