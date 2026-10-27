import { INK, MAJOR, MINOR } from './config';
import { DOT } from './features';
import { ramp } from './render';

const fmt = new Intl.NumberFormat('en-US');

export function createLegend(root: HTMLElement) {
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
        <dd>index <span>${MAJOR} m</span></dd></div>
      <div><dt><svg viewBox="0 0 28 10"><line x1="0" y1="5" x2="28" y2="5" stroke="${INK.text}" stroke-width="0.7" opacity="0.6"/></svg></dt>
        <dd>intermediate <span>${MINOR} m</span></dd></div>
    </dl>
    <h3>Water</h3>
    <dl class="key">
      <div><dt><svg viewBox="0 0 28 10">
          <rect x="0" y="0" width="28" height="10" fill="${INK.water}" fill-opacity="0.14"/>
          ${[2, 5, 8].map((y) => `<line x1="0" y1="${y}" x2="28" y2="${y}" stroke="${INK.shore}" stroke-opacity="0.35" stroke-width="0.6"/>`).join('')}
          <rect x="0.4" y="0.4" width="27.2" height="9.2" fill="none" stroke="${INK.shore}" stroke-opacity="0.7" stroke-width="0.8"/>
        </svg></dt><dd>ocean</dd></div>
      <div><dt><svg viewBox="0 0 28 10">
          <rect x="0.4" y="0.4" width="27.2" height="9.2" rx="4.6" fill="${INK.water}" fill-opacity="0.32" stroke="${INK.shore}" stroke-opacity="0.7" stroke-width="0.8"/>
        </svg></dt><dd>lake</dd></div>
      <div><dt><svg viewBox="0 0 28 10">
          <path d="M1 6C6 2 9 8 14 5S22 3 27 5" fill="none" stroke="${INK.shore}" stroke-opacity="0.9" stroke-width="1.4" stroke-linecap="round"/>
        </svg></dt><dd>river</dd></div>
    </dl>
    <h3>Settlements</h3>
    <dl class="key settlements">
      ${(['city', 'town', 'village'] as const)
        .map(
          (k) => `<div><dt><svg viewBox="0 0 28 10">
          <circle cx="14" cy="5" r="${DOT[k]}" fill="${k === 'city' ? INK.text : k === 'town' ? INK.subtle : INK.muted}"/>
        </svg></dt><dd class="${k}">${k}</dd></div>`,
        )
        .join('')}
    </dl>
    <h3>Map</h3>
    <dl class="key">
      <div><dt><svg viewBox="0 0 28 10">
          <line x1="0" y1="5" x2="28" y2="5" stroke="${INK.border}" stroke-opacity="0.85" stroke-width="1.1" stroke-dasharray="7 4 1.5 4"/>
        </svg></dt><dd>national border</dd></div>
      <div><dt><svg viewBox="0 0 28 10">
          <path d="M14 1.5L18 8.5H10Z" fill="${INK.text}"/>
        </svg></dt><dd>summit</dd></div>
    </dl>
    </div>`;

  // On phones the legend folds into a chip; the header toggles it.
  const head = root.querySelector<HTMLButtonElement>('.legend-head')!;
  const setOpen = (open: boolean) => {
    root.classList.toggle('open', open);
    head.setAttribute('aria-expanded', String(open));
  };
  head.addEventListener('click', () => setOpen(!root.classList.contains('open')));
  document.addEventListener('pointerdown', (e) => {
    if (!root.contains(e.target as Node)) setOpen(false);
  });

  const bar = root.querySelector<HTMLElement>('.bar')!;
  const ticks = root.querySelector<HTMLOListElement>('.ticks')!;
  const gradient = Array.from({ length: 13 }, (_, i) => `${ramp(i / 12)} ${(i / 12) * 100}%`);
  bar.style.background = `linear-gradient(to top, ${gradient.join(', ')})`;
  root.querySelector<HTMLElement>('.mini')!.style.background =
    `linear-gradient(to right, ${gradient.join(', ')})`;

  let shown = '';
  return function update(lo: number, hi: number) {
    const key = `${lo}:${hi}`;
    if (key === shown) return;
    shown = key;
    const span = hi - lo;
    const step = [MAJOR, 500, 1000, 2000, 5000].find((s) => span / s <= 5) ?? 10000;
    const items: string[] = [];
    for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) {
      items.push(`<li style="bottom:${((v - lo) / span) * 100}%">${fmt.format(v)}</li>`);
    }
    ticks.innerHTML = items.join('');
    root.classList.add('ready');
  };
}
