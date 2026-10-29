import { INK } from './config';
import type { FindKind } from './contour.worker';
import type { Point, Rect } from './hover';
import { DOT, MUSEUM_ICON } from './features';
import { ramp } from './render';

const fmt = new Intl.NumberFormat('en-US');

/** Where the legend folds into a chip and opens as a sheet (the CSS's own query). */
const PHONE = matchMedia('(max-width: 520px), (max-height: 600px)');
/** On larger screens it folds to its header and colours instead; remembered per browser. */
const FOLDED = 'topography:legend-folded';

/** A legend row that finds its feature: the nearest one, on click. */
const find = (kind: FindKind, noun: string) =>
  `<div class="find" role="button" tabindex="0" data-find="${kind}" title="Go to the nearest ${noun}">`;

/**
 * `onFind` runs when a row is clicked: go to the nearest of that kind.
 * `onMuseumHover` follows the pointer on the museum row (its rect, or null
 * once off it), so the nearby museums can open beside it.
 */
export function createLegend(
  root: HTMLElement,
  onFind: (kind: FindKind) => void,
  onMuseumHover: (row: Rect | null, at: Point) => void = () => {},
) {
  root.innerHTML = `
    <button class="legend-head" type="button" aria-expanded="false" aria-controls="legend-body">
      <h2>Elevation</h2>
      <span class="mini" aria-hidden="true"></span>
      <span class="unit">metres</span>
      <span class="chevron" aria-hidden="true"></span>
    </button>
    <div id="legend-body" class="legend-body">
    <div class="scale">
      <div class="bar"></div>
      <ol class="ticks"></ol>
    </div>
    <dl class="key">
      <div><dt><svg viewBox="0 0 28 10"><line x1="0" y1="5" x2="28" y2="5" stroke="${INK.text}" stroke-width="1.6"/></svg></dt>
        <dd>index <span class="major"></span></dd></div>
      <div><dt><svg viewBox="0 0 28 10"><line x1="0" y1="5" x2="28" y2="5" stroke="${INK.text}" stroke-width="0.7" opacity="0.6"/></svg></dt>
        <dd>intermediate <span class="minor"></span></dd></div>
    </dl>
    <h3>Water</h3>
    <dl class="key">
      ${find('ocean', 'coast')}<dt><svg viewBox="0 0 28 10">
          <rect x="0" y="0" width="28" height="10" fill="${INK.water}" fill-opacity="0.14"/>
          ${[2, 5, 8].map((y) => `<line x1="0" y1="${y}" x2="28" y2="${y}" stroke="${INK.shore}" stroke-opacity="0.35" stroke-width="0.6"/>`).join('')}
          <rect x="0.4" y="0.4" width="27.2" height="9.2" fill="none" stroke="${INK.shore}" stroke-opacity="0.7" stroke-width="0.8"/>
        </svg></dt><dd>ocean</dd></div>
      ${find('lake', 'lake')}<dt><svg viewBox="0 0 28 10">
          <rect x="0.4" y="0.4" width="27.2" height="9.2" rx="4.6" fill="${INK.water}" fill-opacity="0.32" stroke="${INK.shore}" stroke-opacity="0.7" stroke-width="0.8"/>
        </svg></dt><dd>lake</dd></div>
      ${find('river', 'river')}<dt><svg viewBox="0 0 28 10">
          <path d="M1 6C6 2 9 8 14 5S22 3 27 5" fill="none" stroke="${INK.shore}" stroke-opacity="0.9" stroke-width="1.4" stroke-linecap="round"/>
        </svg></dt><dd>river</dd></div>
    </dl>
    <h3>Settlements</h3>
    <dl class="key settlements">
      ${(['city', 'town', 'village'] as const)
        .map(
          (k) => `${find(k, k)}<dt><svg viewBox="0 0 28 10">
          <circle cx="14" cy="5" r="${DOT[k]}" fill="${k === 'city' ? INK.text : k === 'town' ? INK.subtle : INK.muted}"/>
        </svg></dt><dd class="${k}">${k}</dd></div>`,
        )
        .join('')}
    </dl>
    <h3>Map</h3>
    <dl class="key">
      ${find('border', 'border')}<dt><svg viewBox="0 0 28 10">
          <line x1="0" y1="5" x2="28" y2="5" stroke="${INK.border}" stroke-opacity="0.85" stroke-width="1.1" stroke-dasharray="7 4 1.5 4"/>
        </svg></dt><dd>national border</dd></div>
      ${find('peak', 'summit')}<dt><svg viewBox="0 0 28 10">
          <path d="M14 1.5L18 8.5H10Z" fill="${INK.text}"/>
        </svg></dt><dd>summit</dd></div>
      ${find('museum', 'museum')}<dt><svg class="tall" viewBox="0 0 28 16">
          <path transform="translate(6 0)" d="${MUSEUM_ICON}" fill="${INK.border}" fill-rule="evenodd"/>
        </svg></dt><dd>museum <span class="near"></span></dd></div>
    </dl>
    </div>
    <div class="legend-ramp" aria-hidden="true"></div>`;

  // The header toggles it: on phones a chip opening into a sheet, elsewhere
  // the whole legend folding to its header with its colours along the bottom.
  const head = root.querySelector<HTMLButtonElement>('.legend-head')!;
  const body = root.querySelector<HTMLElement>('.legend-body')!;
  const sync = () => {
    const folded = !PHONE.matches && root.classList.contains('folded');
    const open = PHONE.matches ? root.classList.contains('open') : !folded;
    head.setAttribute('aria-expanded', String(open));
    // A folded body's rows can't be reached by Tab either.
    body.inert = folded;
  };
  const setOpen = (open: boolean) => {
    root.classList.toggle('open', open);
    sync();
  };
  const setFolded = (folded: boolean) => {
    root.classList.toggle('folded', folded);
    sync();
    try {
      localStorage.setItem(FOLDED, folded ? '1' : '0');
    } catch {
      // private mode: the choice just won't be remembered
    }
  };
  try {
    root.classList.toggle('folded', localStorage.getItem(FOLDED) === '1');
  } catch {
    // no storage: start unfolded
  }
  sync();
  PHONE.addEventListener('change', sync);
  head.addEventListener('click', () => {
    if (PHONE.matches) setOpen(!root.classList.contains('open'));
    else setFolded(!root.classList.contains('folded'));
  });

  // On a phone the open sheet covers the map: fold it to show the trip.
  const go = (row: HTMLElement) => {
    setOpen(false);
    onFind(row.dataset.find as FindKind);
  };
  for (const row of root.querySelectorAll<HTMLElement>('[data-find]')) {
    row.addEventListener('click', () => go(row));
    row.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      go(row);
    });
  }
  document.addEventListener('pointerdown', (e) => {
    if (!root.contains(e.target as Node)) setOpen(false);
  });

  const bar = root.querySelector<HTMLElement>('.bar')!;
  const ticks = root.querySelector<HTMLOListElement>('.ticks')!;
  const gradient = Array.from({ length: 13 }, (_, i) => `${ramp(i / 12)} ${(i / 12) * 100}%`);
  bar.style.background = `linear-gradient(to top, ${gradient.join(', ')})`;
  root.querySelector<HTMLElement>('.mini')!.style.background =
    `linear-gradient(to right, ${gradient.join(', ')})`;
  root.querySelector<HTMLElement>('.legend-ramp')!.style.background =
    `linear-gradient(to right, ${gradient.join(', ')})`;

  let shown = '';
  const majorEl = root.querySelector<HTMLElement>('.major')!;
  const minorEl = root.querySelector<HTMLElement>('.minor')!;

  const museumRow = root.querySelector<HTMLElement>('[data-find="museum"]')!;
  museumRow.hidden = true;
  museumRow.addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'mouse') return;
    const r = museumRow.getBoundingClientRect();
    onMuseumHover([r.left, r.top, r.right, r.bottom], { x: e.clientX, y: e.clientY });
  });
  museumRow.addEventListener('pointerleave', (e) => {
    if (e.pointerType === 'mouse') onMuseumHover(null, { x: e.clientX, y: e.clientY });
  });
  const nearEl = museumRow.querySelector<HTMLElement>('.near')!;

  /**
   * Colour range and the contour intervals of the zoom level on screen;
   * `museums`: how many the map around the view has (the row shows only then).
   */
  return function update(lo: number, hi: number, minor: number, major: number, museums: number) {
    museumRow.hidden = museums === 0;
    nearEl.textContent = `${fmt.format(museums)} nearby`;
    majorEl.textContent = `${fmt.format(major)} m`;
    minorEl.textContent = `${fmt.format(minor)} m`;
    const key = `${lo}:${hi}`;
    if (key === shown) return;
    shown = key;
    const span = hi - lo;
    const step = [250, 500, 1000, 2000, 5000].find((s) => span / s <= 5) ?? 10000;
    const items: string[] = [];
    for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) {
      items.push(`<li style="bottom:${((v - lo) / span) * 100}%">${fmt.format(v)}</li>`);
    }
    ticks.innerHTML = items.join('');
    root.classList.add('ready');
  };
}
