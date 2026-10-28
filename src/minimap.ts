import { INK, TILE } from './config';
import { toPath } from './features';
import { loadVector } from './tiles';

/**
 * A small world map with a "you are here" marker. The map is the single
 * zoom-0 tile (one request), drawn once; the marker is a CSS overlay, so
 * panning only moves two hairlines and a ring.
 */

/** Latitudes kept on the minimap: polar Mercator stretch adds nothing here. */
const NORTH = 78;
const SOUTH = -58;

/** Web-mercator y (0..TILE at zoom 0) for a latitude. */
const mercY = (lat: number) => {
  const s = Math.sin((lat * Math.PI) / 180);
  return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * TILE;
};
const TOP = mercY(NORTH);
const BOTTOM = mercY(SOUTH);

export function createMinimap(root: HTMLElement) {
  const canvas = root.querySelector('canvas')!;
  const marker = root.querySelector<HTMLElement>('.you')!;

  function size() {
    const width = root.clientWidth;
    return { width, height: Math.round((width * (BOTTOM - TOP)) / TILE) };
  }

  async function paint() {
    const { width, height } = size();
    if (!width) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.height = `${height}px`;
    const { ocean, border } = await loadVector(0, 0, 0);
    const g = canvas.getContext('2d')!;
    const k = width / TILE;
    g.setTransform(dpr * k, 0, 0, dpr * k, 0, -TOP * dpr * k);

    g.fillStyle = INK.subtle;
    g.globalAlpha = 0.16;
    g.fillRect(0, TOP, TILE, BOTTOM - TOP); // land: everything the ocean doesn't cover
    g.globalAlpha = 1;
    const sea = toPath(ocean.coords, ocean.parts);
    g.fillStyle = INK.base;
    g.fill(sea);
    g.lineWidth = 0.6 / k;
    g.strokeStyle = INK.shore;
    g.globalAlpha = 0.35;
    g.stroke(sea);
    g.strokeStyle = INK.subtle;
    g.globalAlpha = 0.25;
    g.lineWidth = 0.5 / k;
    g.stroke(toPath(border.coords, border.parts));
    root.classList.add('ready');
  }

  /** Centre of the view in world pixels at the view's `zoom`. */
  function update(x: number, y: number, zoom: number) {
    const { width, height } = size();
    const k = width / (TILE * 2 ** zoom);
    const px = Math.min(width, Math.max(0, x * k));
    const py = Math.min(height, Math.max(0, y * k - (TOP * width) / TILE));
    marker.style.setProperty('--x', `${px}px`);
    marker.style.setProperty('--y', `${py}px`);
  }

  paint().catch(() => root.classList.add('failed'));
  let resize = 0;
  window.addEventListener('resize', () => {
    clearTimeout(resize);
    resize = window.setTimeout(() => void paint(), 200);
  });
  return update;
}
