import { INK, MONO, SERIF } from './config';
import { draw, type Scene } from './render';

/**
 * "Export this view": re-draws the current scene offscreen at print density
 * (not a screenshot, so it is crisp on any display), adds the site's vignette,
 * a caption and the data credits the map licences require, and downloads it.
 */

export interface View {
  scene: Scene;
  /** World pixel of the top-left corner, and the size in CSS pixels. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** The view's zoom (the scene may be a stand-in from another one). */
  zoom: number;
  name?: string;
  lat: number;
  lon: number;
}

/** Never export below this density, whatever the screen. */
const MIN_SCALE = 2;
const PAD = 32;
const CREDIT = '© OpenStreetMap contributors · © OpenMapTiles · Elevation: AWS Terrain Tiles';

const lonLat = (lat: number, lon: number) =>
  `${Math.abs(lat).toFixed(4)}° ${lat >= 0 ? 'N' : 'S'}   ${Math.abs(lon).toFixed(4)}° ${lon >= 0 ? 'E' : 'W'}`;

const slug = (s: string) =>
  s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

function text(
  g: CanvasRenderingContext2D,
  s: string,
  x: number,
  y: number,
  font: string,
  color: string,
  spacing = 0,
) {
  g.font = font;
  g.letterSpacing = `${spacing}px`;
  g.strokeText(s, x, y);
  g.fillStyle = color;
  g.fillText(s, x, y);
}

function render(v: View): HTMLCanvasElement {
  const k = Math.max(MIN_SCALE, Math.ceil(window.devicePixelRatio || 1));
  const c = document.createElement('canvas');
  c.width = Math.round(v.w * k);
  c.height = Math.round(v.h * k);
  const g = c.getContext('2d')!;
  g.setTransform(k, 0, 0, k, 0, 0);

  g.fillStyle = INK.base;
  g.fillRect(0, 0, v.w, v.h);
  draw(g, v.scene, v.x, v.y, v.w, v.h, v.zoom);

  // The same soft vignette the page lays over the map.
  const r = Math.hypot(v.w, v.h) / 2;
  const vignette = g.createRadialGradient(v.w / 2, v.h / 2, r * 0.45, v.w / 2, v.h / 2, r);
  vignette.addColorStop(0, 'rgba(12, 11, 18, 0)');
  vignette.addColorStop(1, 'rgba(12, 11, 18, 0.7)');
  g.fillStyle = vignette;
  g.fillRect(0, 0, v.w, v.h);

  // A low fade so the caption and credits sit clear of the map's own labels.
  const scrim = g.createLinearGradient(0, v.h - 150, 0, v.h);
  scrim.addColorStop(0, 'rgba(25, 23, 36, 0)');
  scrim.addColorStop(1, 'rgba(25, 23, 36, 0.92)');
  g.fillStyle = scrim;
  g.fillRect(0, v.h - 150, v.w, 150);

  g.lineJoin = 'round';
  g.strokeStyle = INK.base;
  g.lineWidth = 4;
  g.textBaseline = 'alphabetic';
  g.textAlign = 'left';
  const name = v.name ?? lonLat(v.lat, v.lon);
  text(g, 'TOPOGRAPHY', PAD, v.h - PAD - 66, `400 11px ${MONO}`, INK.muted, 3);
  text(g, name, PAD, v.h - PAD - 24, `italic 400 44px ${SERIF}`, INK.text);
  text(g, lonLat(v.lat, v.lon), PAD, v.h - PAD, `400 11px ${MONO}`, INK.subtle, 2);
  g.textAlign = 'right';
  text(g, CREDIT, v.w - PAD, v.h - PAD, `400 9px ${MONO}`, INK.muted, 1);
  return c;
}

export function createExport(button: HTMLButtonElement, current: () => View | null) {
  button.addEventListener('click', () => {
    const view = current();
    if (!view || button.classList.contains('working')) return;
    button.classList.add('working');
    // Let the button state paint before the (synchronous) re-draw.
    requestAnimationFrame(() => {
      const canvas = render(view);
      canvas.toBlob((blob) => {
        button.classList.remove('working');
        if (!blob) return;
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        const where = `${view.lat.toFixed(4)}_${view.lon.toFixed(4)}`;
        a.download = `topography-${view.name ? `${slug(view.name)}-` : ''}${where}.png`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
      }, 'image/png');
    });
  });
}
