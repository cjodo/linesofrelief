import { INK } from './config';
import { MUSEUM_ICON } from './features';
import { corners, createIntent, dock, hull, type Point, type Rect } from './hover';
import type { MuseumInfo } from './museum-card';
import type { Label } from './tiles';

/**
 * A town's museums: a small list docked beside the badge behind its dot,
 * opening on hover the way everything here does (src/hover.ts). Its
 * corridor spans badge and list, so reaching for a row never closes it.
 * Opening fetches every listed museum's write-up, so rows fill in with a
 * photo and a line about each, and a museum's card opens with it ready.
 */

/** Slots shown before "and N more". */
const MAX_SLOTS = 8;
/** The notch's height on the list, from its top: level with the header. */
const NOTCH_Y = 21;
/** Wikimedia serves fixed thumbnail widths; this one suits a 30 px slot at 2x. */
const SLOT_THUMB = '60px';

const icon = (cls = '') =>
  `<svg class="${cls}" viewBox="0 0 16 16" aria-hidden="true"><path d="${MUSEUM_ICON}" fill="${INK.border}" fill-rule="evenodd"/></svg>`;

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
  /** The pointer is on a museum's row (`row`: its band across the list), or on none. */
  peek(museum: Label | null, row: Rect | null, at: Point): void;
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
) {
  let shown: Label[] = [];
  let current: TownTarget | null = null;
  let at = { left: 0, top: 0 };

  const intent = createIntent<TownTarget>({
    openMs: 140,
    closeMs: 220,
    onPending: onActive,
    onOpen: (target) => {
      render(target);
      onActive(target.key);
      onOpen?.(target);
    },
    onClose: () => {
      current?.peek(null, null, { x: 0, y: 0 });
      current = null;
      root.classList.remove('open');
      onActive(null);
    },
  });

  root.addEventListener('pointerenter', intent.hold);
  // Off the list onto anything but the map (legend, nav) closes it; back
  // onto the map, `hover` decides.
  root.addEventListener('pointerleave', (e) => {
    current?.peek(null, null, { x: e.clientX, y: e.clientY });
    if (e.pointerType === 'mouse') intent.release();
  });
  // Resting on a row shows its museum's hover window beside the list.
  root.addEventListener('pointermove', (e) => {
    const slot = (e.target as Element).closest<HTMLElement>('[data-slot]');
    const point = { x: e.clientX, y: e.clientY };
    if (!slot) return current?.peek(null, null, point);
    const list = root.getBoundingClientRect();
    const row = slot.getBoundingClientRect();
    current?.peek(shown[Number(slot.dataset.slot)], [list.left, row.top, list.right, row.bottom], point);
  });
  root.addEventListener('click', (e) => {
    const slot = (e.target as Element).closest<HTMLElement>('[data-slot]');
    if (!slot) return;
    const museum = shown[Number(slot.dataset.slot)];
    const target = current;
    intent.hide();
    target?.pick(museum);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') intent.hide();
  });

  function render(target: TownTarget) {
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

    root.classList.remove('open');
    position();
    root.getBoundingClientRect(); // a layout here starts it from closed
    root.classList.add('open');
    for (const [i, m] of shown.entries()) {
      target
        .describe(m)
        .then((info) => fill(target.key, i, info))
        .catch(reportError);
    }
  }

  /**
   * Dock beside the anchor, notch pointing at it, and set the corridor. Run
   * again as rows fill in: a taller list may need to rise to stay on screen.
   */
  function position() {
    if (!current) return;
    const { left, top, h, flipped } = dock(root, current.anchor, 'beside', { lead: NOTCH_Y });
    const [ax0, ay0, ax1, ay1] = current.anchor;
    const ay = (ay0 + ay1) / 2;
    at = { left, top };
    root.classList.toggle('flip', flipped);
    // The notch points at the anchor, wherever clamping put the list.
    root.style.setProperty('--notch', `${Math.max(10, Math.min(h - 10, ay - top))}px`);
    // It grows out of the anchor.
    root.style.transformOrigin = `${(flipped ? ax0 : ax1) - left}px ${ay - top}px`;
    reshape();
  }

  /** The corridor for the list as it now stands. */
  function reshape() {
    if (!current) return;
    const { left, top } = at;
    intent.setCorridor(
      hull([
        ...corners(current.anchor, 6),
        ...corners([left, top, left + root.offsetWidth, top + root.offsetHeight]),
      ]),
    );
  }

  /** A row's photo and line, once its write-up arrives; none, and the placeholder goes. */
  function fill(key: string, i: number, info: MuseumInfo | null) {
    if (key !== intent.openKey) return;
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
    position();
  }

  return {
    hover: intent.hover,
    open: intent.open,
    hide: intent.hide,
    get openKey() {
      return intent.openKey;
    },
  };
}

function escape(s: string) {
  return s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
}
