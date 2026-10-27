import { INK, MONO, SERIF, TILE } from './config';
import type { TileFeatures } from './contour.worker';
import type { Geometry, Label, LabelKind } from './tiles';

/** The visible window, relative to the scene origin. */
export interface View {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface TilePaths {
  ox: number;
  oy: number;
  ocean: Path2D | null;
  lake: Path2D | null;
  river: Path2D | null;
  border: Path2D | null;
}

interface PlacedLabel {
  label: Label;
  text: string;
  box: [number, number, number, number];
}

export interface Features {
  tiles: TilePaths[];
  labels: PlacedLabel[];
}

/** Polylines from packed coords; closed rings repeat their first point. */
export function toPath(coords: Float32Array, parts: Uint32Array): Path2D {
  const p = new Path2D();
  let k = 0;
  for (const count of parts) {
    for (let i = 0; i < count; i++, k += 2) {
      if (i === 0) p.moveTo(coords[k], coords[k + 1]);
      else p.lineTo(coords[k], coords[k + 1]);
    }
  }
  return p;
}

const pathOf = (g: Geometry) => (g.parts.length ? toPath(g.coords, g.parts) : null);

// --- Label styles ------------------------------------------------------------

interface LabelStyle {
  font: string;
  color: string;
  spacing: number;
  upper: boolean;
  order: number;
  /** Clear space kept around the label. */
  gap: number;
}

const STYLE: Record<LabelKind, LabelStyle> = {
  city: { font: `400 11px ${MONO}`, color: INK.text, spacing: 3, upper: true, order: 0, gap: 16 },
  peak: { font: `italic 400 16px ${SERIF}`, color: INK.text, spacing: 0.3, upper: false, order: 1, gap: 64 },
  water: { font: `italic 400 15px ${SERIF}`, color: INK.shore, spacing: 1.2, upper: false, order: 2, gap: 24 },
  town: { font: `400 9.5px ${MONO}`, color: INK.subtle, spacing: 2.4, upper: true, order: 3, gap: 16 },
  village: { font: `300 9px ${MONO}`, color: INK.muted, spacing: 2, upper: true, order: 4, gap: 12 },
};
const ELE_FONT = `300 9px ${MONO}`;

/** Settlement dot radius; names sit just above the dot. */
export const DOT: Partial<Record<LabelKind, number>> = { city: 3, town: 2.2, village: 1.6 };
const DOT_GAP = 5;
const fmt = new Intl.NumberFormat('en-US');

function setStyle(ctx: CanvasRenderingContext2D, font: string, spacing: number) {
  ctx.font = font;
  ctx.letterSpacing = `${spacing}px`;
}

function overlaps(a: PlacedLabel['box'], b: PlacedLabel['box'], gap: number) {
  return a[0] < b[2] + gap && a[2] + gap > b[0] && a[1] < b[3] + gap && a[3] + gap > b[1];
}

/**
 * Greedy, priority-ordered placement. The scale is fixed, so this runs once
 * per scene rather than per frame.
 */
function placeLabels(ctx: CanvasRenderingContext2D, labels: Label[], w: number, h: number) {
  const sorted = [...labels].sort(
    (a, b) => STYLE[a.kind].order - STYLE[b.kind].order || a.rank - b.rank,
  );
  const placed: PlacedLabel[] = [];
  ctx.save();
  for (const label of sorted) {
    if (label.x < 0 || label.y < 0 || label.x > w || label.y > h) continue;
    const s = STYLE[label.kind];
    const text = s.upper ? label.name.toUpperCase() : label.name;
    setStyle(ctx, s.font, s.spacing);
    let width = ctx.measureText(text).width;
    let box: PlacedLabel['box'];
    if (label.kind === 'peak') {
      setStyle(ctx, ELE_FONT, 1.5);
      width = Math.max(width, ctx.measureText(`${fmt.format(label.ele!)} m`).width);
      box = [label.x - width / 2, label.y - 6, label.x + width / 2, label.y + 34];
    } else {
      const size = parseFloat(s.font.split(' ').find((p) => p.endsWith('px'))!);
      const dot = DOT[label.kind];
      box = dot
        ? [label.x - width / 2, label.y - dot - DOT_GAP - size - 2, label.x + width / 2, label.y + dot + 1]
        : [label.x - width / 2, label.y - size / 2 - 2, label.x + width / 2, label.y + size / 2 + 2];
    }
    const gap = s.gap;
    if (placed.some((p) => overlaps(p.box, box, Math.max(gap, STYLE[p.label.kind].gap)))) continue;
    placed.push({ label, text, box });
  }
  ctx.restore();
  return placed;
}

export function buildFeatures(
  ctx: CanvasRenderingContext2D,
  tiles: TileFeatures[],
  labels: Label[],
  width: number,
  height: number,
): Features {
  return {
    tiles: tiles.map((t) => ({
      ox: t.ox,
      oy: t.oy,
      ocean: pathOf(t.ocean),
      lake: pathOf(t.lake),
      river: pathOf(t.river),
      border: pathOf(t.border),
    })),
    labels: placeLabels(ctx, labels, width, height),
  };
}

// --- Drawing -----------------------------------------------------------------

/** Engraved-map waterlining for the open sea. */
let hatch: CanvasPattern | null = null;
function oceanHatch(ctx: CanvasRenderingContext2D) {
  if (!hatch) {
    const c = document.createElement('canvas');
    c.width = 8;
    c.height = 5;
    const g = c.getContext('2d')!;
    g.fillStyle = INK.shore;
    g.globalAlpha = 0.16;
    g.fillRect(0, 0, 8, 1);
    hatch = ctx.createPattern(c, 'repeat');
  }
  return hatch!;
}

/**
 * Vector tiles carry a buffer past their edges; clipping each tile to its
 * own square keeps overlapping fills and strokes from doubling up at seams.
 */
function eachVisibleTile(
  ctx: CanvasRenderingContext2D,
  f: Features,
  v: View,
  fn: (t: TilePaths) => void,
) {
  for (const t of f.tiles) {
    if (t.ox > v.x + v.w || t.oy > v.y + v.h || t.ox + TILE < v.x || t.oy + TILE < v.y) continue;
    ctx.save();
    ctx.translate(t.ox, t.oy);
    ctx.beginPath();
    ctx.rect(0, 0, TILE, TILE);
    ctx.clip();
    fn(t);
    ctx.restore();
  }
}

export function drawWater(ctx: CanvasRenderingContext2D, f: Features, v: View) {
  eachVisibleTile(ctx, f, v, (t) => {
    if (t.ocean) {
      ctx.fillStyle = INK.water;
      ctx.globalAlpha = 0.14;
      ctx.fill(t.ocean);
      ctx.globalAlpha = 1;
      ctx.fillStyle = oceanHatch(ctx);
      ctx.fill(t.ocean);
    }
    if (t.lake) {
      ctx.fillStyle = INK.water;
      ctx.globalAlpha = 0.32;
      ctx.fill(t.lake);
    }
  });
}

export function drawLines(ctx: CanvasRenderingContext2D, f: Features, v: View) {
  eachVisibleTile(ctx, f, v, (t) => {
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.strokeStyle = INK.shore;
    ctx.globalAlpha = 0.7;
    ctx.lineWidth = 0.8;
    if (t.ocean) ctx.stroke(t.ocean);
    if (t.lake) ctx.stroke(t.lake);
    if (t.river) {
      ctx.globalAlpha = 0.9;
      ctx.lineWidth = 1.4;
      ctx.stroke(t.river);
    }
    if (t.border) {
      ctx.strokeStyle = INK.border;
      ctx.globalAlpha = 0.85;
      ctx.lineWidth = 1.1;
      ctx.setLineDash([7, 4, 1.5, 4]);
      ctx.stroke(t.border);
      ctx.setLineDash([]);
    }
  });
}

function haloText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number) {
  ctx.strokeText(text, x, y);
  ctx.fillText(text, x, y);
}

export function drawLabels(ctx: CanvasRenderingContext2D, f: Features, v: View) {
  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = INK.base;
  ctx.lineWidth = 3.5;
  for (const { label, text, box } of f.labels) {
    if (box[2] < v.x || box[0] > v.x + v.w || box[3] < v.y || box[1] > v.y + v.h) continue;
    const s = STYLE[label.kind];
    ctx.globalAlpha = 0.92;
    ctx.fillStyle = s.color;
    setStyle(ctx, s.font, s.spacing);
    const dot = DOT[label.kind];
    if (dot) {
      ctx.beginPath();
      ctx.arc(label.x, label.y, dot, 0, Math.PI * 2);
      ctx.lineWidth = 2.5;
      ctx.stroke();
      ctx.fill();
      ctx.lineWidth = 3.5;
      ctx.textBaseline = 'alphabetic';
      haloText(ctx, text, label.x, label.y - dot - DOT_GAP);
      ctx.textBaseline = 'middle';
      continue;
    }
    if (label.kind !== 'peak') {
      haloText(ctx, text, label.x, label.y);
      continue;
    }
    ctx.beginPath();
    ctx.moveTo(label.x, label.y - 4);
    ctx.lineTo(label.x + 4, label.y + 3);
    ctx.lineTo(label.x - 4, label.y + 3);
    ctx.closePath();
    ctx.stroke();
    ctx.fill();
    haloText(ctx, text, label.x, label.y + 16);
    setStyle(ctx, ELE_FONT, 1.5);
    ctx.fillStyle = INK.subtle;
    haloText(ctx, `${fmt.format(label.ele!)} m`, label.x, label.y + 29);
  }
  ctx.restore();
}
