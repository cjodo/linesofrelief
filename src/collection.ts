import { INK } from './config';
import { MUSEUM_ICON } from './features';
import type { Label } from './tiles';

/**
 * A town's museums, unfolding from its dot: a small inventory of slots, one
 * per museum, that open in turn. Picking one travels there.
 */

/** Slots shown before "and N more". */
const MAX_SLOTS = 8;
/** Grace period for the pointer to cross from the dot into the panel. */
const HIDE_MS = 220;
/** The panel's corner sits this far from the dot it unfolds from. */
const OFFSET = { x: 14, y: -16 };

const icon = (cls = '') =>
  `<svg class="${cls}" viewBox="0 0 16 16" aria-hidden="true"><path d="${MUSEUM_ICON}" fill="${INK.border}" fill-rule="evenodd"/></svg>`;

export interface Collection {
  /** Open for the town whose dot is at screen (x, y); the same town only stays open. */
  show(key: string, town: string, museums: Label[], x: number, y: number): void;
  /** Close after a moment, unless the pointer reaches the panel. */
  hideSoon(): void;
  hide(): void;
  readonly openKey: string | null;
}

export function createCollection(root: HTMLElement, onPick: (museum: Label) => void): Collection {
  let openKey: string | null = null;
  let timer = 0;
  let shown: Label[] = [];

  const hide = () => {
    clearTimeout(timer);
    openKey = null;
    root.classList.remove('open');
  };
  root.addEventListener('pointerenter', () => clearTimeout(timer));
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

  const api: Collection = {
    get openKey() {
      return openKey;
    },
    show(key, town, museums, x, y) {
      clearTimeout(timer);
      if (key === openKey) return;
      openKey = key;
      shown = museums.slice(0, MAX_SLOTS);
      const more = museums.length - shown.length;
      root.innerHTML = `
        <header>${icon('mark')}<span class="town">${escape(town)}</span>
          <span class="count">${museums.length} ${museums.length === 1 ? 'museum' : 'museums'}</span></header>
        <ol>${shown
          .map(
            (m, i) =>
              `<li style="--i:${i}"><button type="button" data-slot="${i}"><span class="slot">${icon()}</span><span class="name">${escape(m.name)}</span></button></li>`,
          )
          .join('')}</ol>
        ${more > 0 ? `<p class="more" style="--i:${shown.length}">and ${more} more</p>` : ''}`;

      // Unfold to the right of the dot, or to its left where there's no room.
      root.classList.remove('open', 'flip');
      // Measured from the corner, where it has room for its natural width.
      root.style.left = '0px';
      root.style.top = '0px';
      // Layout size: the closed panel is scaled down, which offset sizes ignore.
      const [width, height] = [root.offsetWidth, root.offsetHeight];
      const flip = x + OFFSET.x + width > innerWidth - 16;
      root.classList.toggle('flip', flip);
      const left = flip ? x - OFFSET.x - width : x + OFFSET.x;
      const top = Math.max(16, Math.min(y + OFFSET.y, innerHeight - height - 16));
      root.style.left = `${left}px`;
      root.style.top = `${top}px`;
      // Unfolds from the dot itself.
      root.style.transformOrigin = `${x - left}px ${y - top}px`;
      void root.offsetWidth; // start the unfolding from closed
      root.classList.add('open');
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
