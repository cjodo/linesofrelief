import { parseCoords } from './coords';

/**
 * The coordinate readout above the minimap, which is also a box to type in:
 * it shows where the centre is until focused, then takes coordinates in any
 * form search does (src/coords.ts). Enter goes there; Escape or leaving the
 * box puts the readout back.
 */

/** How long a refused entry stays marked. */
const INVALID_MS = 700;

export function createCoordEntry(
  input: HTMLInputElement,
  onGo: (at: { lat: number; lon: number }) => void,
) {
  let timer = 0;
  /** What the readout shows when nobody is typing. */
  let shown = '';

  const fit = () => {
    // Browsers without `field-sizing` size the box from this.
    input.size = Math.max(8, input.value.length);
  };
  input.addEventListener('input', fit);
  input.addEventListener('focus', () => input.select());
  input.addEventListener('blur', () => {
    input.classList.remove('invalid');
    input.value = shown;
    fit();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      input.blur();
      return;
    }
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const at = parseCoords(input.value);
    if (!at) {
      clearTimeout(timer);
      input.classList.remove('invalid');
      void input.offsetWidth; // restart the nudge
      input.classList.add('invalid');
      timer = window.setTimeout(() => input.classList.remove('invalid'), INVALID_MS);
      return;
    }
    input.blur();
    onGo(at);
  });

  /** Show `text` (where the centre is), unless the reader is typing. */
  return function show(text: string) {
    shown = text;
    if (document.activeElement === input || input.value === text) return;
    input.value = text;
    fit();
  };
}
