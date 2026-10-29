import { INK } from './config';
import { MUSEUM_ICON } from './features';
import type { MuseumInfo } from './museum-card';
import type { Label } from './tiles';

/**
 * A town's museums: a small list docked beside the badge behind its dot.
 *
 * Hover works the way a good menu does:
 * - Resting on the badge for a moment opens it; sweeping past doesn't.
 * - Once one is open, moving onto another town's badge switches at once.
 * - It stays open while the pointer is anywhere in the corridor spanning
 *   badge and list (their convex hull), so reaching for it never races a
 *   timer, and closes shortly after the pointer leaves that corridor.
 * - A click or tap opens it at once; Escape, a click elsewhere or moving
 *   the map closes it.
 * Opening fetches every listed museum's write-up, so rows fill in with a
 * photo and a line about each, and a museum's card opens with it ready.
 */

/** Slots shown before "and N more". */
const MAX_SLOTS = 8;
/** Resting this long on a badge opens its list: intent, not a pass-by. */
const OPEN_MS = 140;
/** Leaving the corridor closes it after this long (pointer jitter at its edge). */
const CLOSE_MS = 220;
/** Space between badge and list, where the notch sits. */
const GAP = 12;
/** The notch's height on the list, from its top: level with the header. */
const NOTCH_Y = 21;
const EDGE = 12;
/** Wikimedia serves fixed thumbnail widths; this one suits a 22 px slot at 2x. */
const SLOT_THUMB = '60px';

const icon = (cls = '') =>
  `<svg class="${cls}" viewBox="0 0 16 16" aria-hidden="true"><path d="${MUSEUM_ICON}" fill="${INK.border}" fill-rule="evenodd"/></svg>`;

export interface Point {
  x: number;
  y: number;
}

/** Screen px: left, top, right, bottom. */
export type Rect = [number, number, number, number];

export interface TownTarget {
  key: string;
  town: string;
  museums: Label[];
  /** The badge and dot on screen: what the list docks beside. */
  anchor: Rect;
  /** A museum's write-up (shared with its card), for the row. */
  describe(museum: Label): Promise<MuseumInfo | null>;
  /** Go to a museum chosen from the list. */
  pick(museum: Label): void;
}

export interface Collection {
  /** The pointer moved over the map: the town under it, if any, and where it is. */
  hover(target: TownTarget | null, at: Point): void;
  /** Open at once (a click, or a tap: touch has no hover). */
  open(target: TownTarget): void;
  hide(): void;
  readonly openKey: string | null;
}

export function createCollection(
  root: HTMLElement,
  {
    onActive,
    onOpen,
  }: {
    /** The town whose badge should look lifted (open or about to), or null. */
    onActive: (key: string | null) => void;
    onOpen?: (target: TownTarget) => void;
  },
): Collection {
  let openKey: string | null = null;
  let pendingKey: string | null = null;
  let openTimer = 0;
  let closeTimer = 0;
  let shown: Label[] = [];
  let current: TownTarget | null = null;
  /** The corridor that keeps it open: badge and list, as a convex polygon. */
  let corridor: Point[] = [];
  let at = { left: 0, top: 0 };

  const cancelOpen = () => {
    clearTimeout(openTimer);
    pendingKey = null;
  };
  const cancelClose = () => clearTimeout(closeTimer);
  const closeSoon = () => {
    clearTimeout(closeTimer);
    closeTimer = window.setTimeout(hide, CLOSE_MS);
  };

  function hide() {
    const was = openKey ?? pendingKey;
    cancelOpen();
    cancelClose();
    openKey = null;
    root.classList.remove('open');
    if (was) onActive(null);
  }

  root.addEventListener('pointerenter', cancelClose);
  // Off the list onto anything but the map (legend, nav) closes it; back
  // onto the map, `hover` decides.
  root.addEventListener('pointerleave', (e) => {
    if (e.pointerType === 'mouse') closeSoon();
  });
  root.addEventListener('click', (e) => {
    const slot = (e.target as Element).closest<HTMLElement>('[data-slot]');
    if (!slot) return;
    const museum = shown[Number(slot.dataset.slot)];
    const target = current;
    hide();
    target?.pick(museum);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && openKey) hide();
  });

  function open(target: TownTarget) {
    cancelOpen();
    cancelClose();
    if (target.key === openKey) return;
    openKey = target.key;
    current = target;
    const { museums } = target;
    shown = museums.slice(0, MAX_SLOTS);
    const more = museums.length - shown.length;
    root.innerHTML = `
      <header>${icon('mark')}<span class="town">${escape(target.town)}</span>
        <span class="count">${museums.length} ${museums.length === 1 ? 'museum' : 'museums'}</span></header>
      <ol>${shown
        .map(
          (m, i) =>
            `<li style="--i:${i}"><button type="button" data-slot="${i}"><span class="slot">${icon()}</span><span class="text"><span class="name">${escape(m.name)}</span><span class="about"></span></span></button></li>`,
        )
        .join('')}</ol>
      ${more > 0 ? `<p class="more" style="--i:${shown.length}">and ${more} more</p>` : ''}`;

    // Docked beside the badge: right of it, or left where there's no room.
    root.classList.remove('open');
    root.style.translate = '0px 0px';
    // Layout size: the closed list is scaled down, which offset sizes ignore.
    const [w, h] = [root.offsetWidth, root.offsetHeight];
    const [ax0, ay0, ax1, ay1] = target.anchor;
    const ay = (ay0 + ay1) / 2;
    const flip = ax1 + GAP + w > innerWidth - EDGE;
    const left = flip ? Math.max(EDGE, ax0 - GAP - w) : ax1 + GAP;
    const top = Math.max(EDGE, Math.min(ay - NOTCH_Y, innerHeight - h - EDGE));
    root.classList.toggle('flip', flip);
    root.style.translate = `${left}px ${top}px`;
    // The notch points at the badge, wherever clamping put the list.
    root.style.setProperty('--notch', `${Math.max(10, Math.min(h - 10, ay - top))}px`);
    // It grows out of the badge.
    root.style.transformOrigin = `${(flip ? ax0 : ax1) - left}px ${ay - top}px`;
    at = { left, top };
    reshape();
    void root.offsetWidth; // start from closed
    root.classList.add('open');
    onActive(openKey);
    onOpen?.(target);
    shown.forEach((m, i) => target.describe(m).then((info) => fill(target.key, i, info)));
  }

  /** The corridor for the list as it now stands (rows grow as they fill in). */
  function reshape() {
    if (!current) return;
    const { left, top } = at;
    corridor = hull([
      ...corners(current.anchor, 6),
      ...corners([left, top, left + root.offsetWidth, top + root.offsetHeight], 0),
    ]);
  }

  /** A row's photo and line, once its write-up arrives; none, and the placeholder goes. */
  function fill(key: string, i: number, info: MuseumInfo | null) {
    if (key !== openKey) return;
    const row = root.querySelector<HTMLElement>(`[data-slot="${i}"]`);
    const about = row?.querySelector<HTMLElement>('.about');
    if (!row || !about) return;
    if (!info) {
      about.remove();
    } else {
      about.textContent = info.description ?? info.title;
      about.classList.add('filled');
      const photo = info.photo;
      if (photo) {
        const img = new Image();
        img.alt = '';
        img.decoding = 'async';
        img.title = `Photo: ${photo.artist ? `${photo.artist}, ` : ''}${photo.license}`;
        img.src = photo.thumb.source.replace(/\/\d+px-/, `/${SLOT_THUMB}-`);
        img.addEventListener('load', () => img.classList.add('loaded'), { once: true });
        row.querySelector('.slot')?.append(img);
      }
    }
    reshape();
  }

  return {
    get openKey() {
      return openKey;
    },
    hover(target, at) {
      if (openKey) {
        // Open: another town's badge takes over at once; anywhere in the
        // corridor (or on this badge) keeps it; anywhere else lets it go.
        if (target && target.key !== openKey) open(target);
        else if (target || inside(corridor, at)) cancelClose();
        else closeSoon();
        return;
      }
      if (!target) {
        if (pendingKey) onActive(null);
        cancelOpen();
        return;
      }
      if (pendingKey === target.key) return;
      cancelOpen();
      pendingKey = target.key;
      onActive(target.key); // the badge lifts as soon as it's under the pointer
      openTimer = window.setTimeout(() => open(target), OPEN_MS);
    },
    open,
    hide,
  };
}

function corners([x0, y0, x1, y1]: Rect, pad: number): Point[] {
  return [
    { x: x0 - pad, y: y0 - pad },
    { x: x1 + pad, y: y0 - pad },
    { x: x1 + pad, y: y1 + pad },
    { x: x0 - pad, y: y1 + pad },
  ];
}

const cross = (o: Point, a: Point, b: Point) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

/** Convex hull, its corners in order (monotone chain). */
function hull(points: Point[]): Point[] {
  const p = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  const half = (list: Point[]) => {
    const out: Point[] = [];
    for (const q of list) {
      while (out.length >= 2 && cross(out[out.length - 2], out[out.length - 1], q) <= 0) out.pop();
      out.push(q);
    }
    out.pop();
    return out;
  };
  return [...half(p), ...half([...p].reverse())];
}

/** Inside a convex polygon (edges included), whichever way it winds: screen y runs down. */
function inside(poly: Point[], q: Point) {
  if (poly.length < 3) return false;
  const sides = poly.map((a, i) => cross(a, poly[(i + 1) % poly.length], q));
  return sides.every((c) => c >= 0) || sides.every((c) => c <= 0);
}

function escape(s: string) {
  return s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
}
