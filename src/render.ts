import { MAJOR, RAMP } from './config';
import type { SceneResult } from './contour.worker';
import { drawLabels, drawLines, drawWater, toPath, type Features } from './features';

// --- Colour ramp, interpolated in OKLab for perceptually even steps ---------

type Vec3 = [number, number, number];

const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toSrgb = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

function hexToOklab(hex: string): Vec3 {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => toLinear(c / 255));
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function oklabToCss([L, a, b]: Vec3): string {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const rgb = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ].map((c) => Math.round(Math.min(1, Math.max(0, toSrgb(c))) * 255));
  return `rgb(${rgb.join(' ')})`;
}

const stops = RAMP.map(hexToOklab);

/** Ramp colour at t ∈ [0, 1]. */
export function ramp(t: number): string {
  t = Math.min(1, Math.max(0, t)) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(t));
  const f = t - i;
  const [a, b] = [stops[i], stops[i + 1]];
  return oklabToCss([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f]);
}

// --- Scene → canvas ----------------------------------------------------------

export interface Line {
  path: Path2D;
  color: string;
  major: boolean;
}

export interface Scene {
  originX: number;
  originY: number;
  /** Size in scene pixels (tile pixels at the scene's zoom). */
  width: number;
  height: number;
  /** Screen pixels per scene pixel: 1 for the map, >1 for a coarser preview. */
  scale: number;
  /** Grid downsampling the contours were traced at. */
  ds: number;
  lo: number;
  hi: number;
  lines: Line[];
  features: Features;
}

export function buildScene(r: SceneResult, features: Features, ds: number, scale = 1): Scene {
  // Snap the colour range to index contours so the legend reads cleanly.
  const lo = Math.floor(r.min / MAJOR) * MAJOR;
  const hi = Math.max(lo + MAJOR, Math.ceil(r.max / MAJOR) * MAJOR);
  return {
    originX: r.originX,
    originY: r.originY,
    width: r.width,
    height: r.height,
    scale,
    ds,
    lo,
    hi,
    lines: r.levels.map((c) => ({
      path: toPath(c.coords, c.parts),
      color: ramp((c.value - lo) / (hi - lo)),
      major: c.value % MAJOR === 0,
    })),
    features,
  };
}

function drawContours(ctx: CanvasRenderingContext2D, scene: Scene) {
  const { ds, scale } = scene;
  // Blur and downsampling soften the outermost cells; keep them off-canvas.
  const edge = 2 * ds;
  ctx.save();
  ctx.beginPath();
  ctx.rect(edge, edge, scene.width - 2 * edge, scene.height - 2 * edge);
  ctx.clip();
  ctx.scale(ds, ds);
  ctx.lineJoin = 'round';
  // Minor lines first so index lines sit on top.
  for (const pass of [false, true]) {
    ctx.globalAlpha = pass ? 0.95 : 0.45;
    // Line weights are in screen pixels whatever the scene's resolution.
    ctx.lineWidth = (pass ? 1.25 : 0.6) / (ds * scale);
    for (const line of scene.lines) {
      if (line.major !== pass) continue;
      ctx.strokeStyle = line.color;
      ctx.stroke(line.path);
    }
  }
  ctx.restore();
}

export function draw(
  ctx: CanvasRenderingContext2D,
  scene: Scene,
  viewX: number,
  viewY: number,
  w: number,
  h: number,
) {
  const k = scene.scale;
  const view = { x: viewX / k - scene.originX, y: viewY / k - scene.originY, w: w / k, h: h / k };
  ctx.save();
  ctx.scale(k, k);
  ctx.translate(-view.x, -view.y);
  drawWater(ctx, scene.features, view);
  drawContours(ctx, scene);
  drawLines(ctx, scene.features, view);
  drawLabels(ctx, scene.features, view);
  ctx.restore();
}
