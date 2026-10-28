/**
 * Four-step text size (a a A A). Scales every rem-based size through
 * --text-scale on <html> and is remembered per browser. index.html applies
 * the stored value before first paint, so there is no jump on load.
 */

export const TEXT_SCALES = [1, 1.1, 1.2, 1.3];
const STORE = 'topography:text-scale';

export function storedScale(): number {
  try {
    const v = Number(localStorage.getItem(STORE));
    return TEXT_SCALES.includes(v) ? v : 1;
  } catch {
    return 1;
  }
}

export function createTextSize(root: HTMLElement, onChange: (scale: number) => void) {
  const buttons = [...root.querySelectorAll<HTMLButtonElement>('button')];

  function apply(scale: number, persist: boolean) {
    document.documentElement.style.setProperty('--text-scale', String(scale));
    for (const b of buttons) b.setAttribute('aria-checked', String(Number(b.dataset.scale) === scale));
    if (persist) {
      try {
        localStorage.setItem(STORE, String(scale));
      } catch {
        // private mode: the choice just won't be remembered
      }
    }
  }

  for (const b of buttons) {
    b.addEventListener('click', () => {
      const scale = Number(b.dataset.scale);
      apply(scale, true);
      onChange(scale);
    });
  }
  // Arrow keys move within the group, as a radio group should.
  root.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    e.stopPropagation(); // not a map pan
    const i = buttons.findIndex((b) => b.getAttribute('aria-checked') === 'true');
    const next = buttons[Math.max(0, Math.min(buttons.length - 1, i + (e.key === 'ArrowRight' ? 1 : -1)))];
    next.focus();
    next.click();
  });

  apply(storedScale(), false);
}
