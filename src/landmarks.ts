import { LANDMARKS, type Landmark } from '../site/landmarks';
import { INK, MONO } from './config';
import { lonLatToWorld } from './tiles';

/**
 * Famous buildings on the map: a small green tower at each, its name beside
 * it. A click goes to the landmark's page and its render. Drawn over the
 * scene in screen space, so they're there at every scale.
 */

/**
 * The glyph: a tower on a 16×16 grid, centred on 8,8: spire, shaft, a
 * platform, and four legs spread over an arch.
 */
export const LANDMARK_ICON =
  'M8 .5 9 4.2H7Z' +
  'M6.9 4.8H9.1L10.1 8.6H5.9Z' +
  'M4.8 9.2H11.2V10.4H4.8Z' +
  'M5.3 11H10.7L12.9 15.5H10.3Q8 11.9 5.7 15.5H3.1Z';
let iconPath: Path2D | null = null;
/** The glyph's size on screen at text size 1, px, and its half. */
const SIZE = 18;
const HALF = SIZE / 2;
/** Hovered, a badge grows a little (as town badges do). */
const LIFT = 1.25;
/** How far (screen px) from a badge's centre, or its name, still reaches it. */
const REACH_PX = 12;
const FONT = `400 9px ${MONO}`;
const SPACING = '0.14em';

let lifted: string | null = null;

export interface View {
  /** The viewport's top-left in world px, its size, and the zoom. */
  x: number;
  y: number;
  w: number;
  h: number;
  zoom: number;
  /** Text size. */
  scale: number;
}

function placed(l: Landmark, v: View) {
  const p = lonLatToWorld(l.lon, l.lat, v.zoom);
  return { x: p.x - v.x, y: p.y - v.y };
}

const label = (l: Landmark) => l.name.toUpperCase();

export function drawLandmarks(ctx: CanvasRenderingContext2D, v: View) {
  ctx.save();
  ctx.font = FONT;
  ctx.letterSpacing = SPACING;
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  for (const l of LANDMARKS) {
    const { x, y } = placed(l, v);
    if (x < -200 || y < -40 || x > v.w + 40 || y > v.h + 40) continue;
    const k = v.scale * (l.slug === lifted ? LIFT : 1);
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(k, k);
    // The glyph, haloed in the page's colour so it reads over any contour.
    iconPath ??= new Path2D(LANDMARK_ICON);
    ctx.save();
    ctx.scale(SIZE / 16, SIZE / 16);
    ctx.translate(-8, -8);
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = INK.base;
    ctx.stroke(iconPath);
    ctx.fillStyle = INK.landmark;
    ctx.fill(iconPath);
    ctx.restore();
    // Its name in the same green, haloed like every label.
    ctx.lineWidth = 3.5;
    ctx.strokeStyle = INK.base;
    ctx.fillStyle = INK.landmark;
    ctx.strokeText(label(l), HALF + 6, 0);
    ctx.fillText(label(l), HALF + 6, 0);
    ctx.restore();
  }
  ctx.restore();
}

/** The landmark whose badge or name is under screen point (sx, sy). */
export function landmarkAt(ctx: CanvasRenderingContext2D, sx: number, sy: number, v: View) {
  ctx.save();
  ctx.font = FONT;
  ctx.letterSpacing = SPACING;
  let found: Landmark | null = null;
  for (const l of LANDMARKS) {
    const { x, y } = placed(l, v);
    const dx = (sx - x) / v.scale;
    const dy = (sy - y) / v.scale;
    if (Math.hypot(dx, dy) < REACH_PX) found = l;
    else if (dx > 0 && dx < HALF + 6 + ctx.measureText(label(l)).width && Math.abs(dy) < 8) found = l;
    if (found) break;
  }
  ctx.restore();
  return found;
}

/** Lift the hovered badge; true when that changed what's drawn. */
export function liftLandmark(l: Landmark | null) {
  const slug = l?.slug ?? null;
  if (slug === lifted) return false;
  lifted = slug;
  return true;
}
