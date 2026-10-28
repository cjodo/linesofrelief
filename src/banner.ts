import { INK, RAMP } from './config';

/**
 * A greeting for anyone who opens the console: a tiny contour map drawn in
 * text (rings around a summit, coloured along the elevation ramp), then the
 * site in a few lines.
 */

const W = 47;
const H = 15;
const RINGS = 5;
/** Centre on a whole cell, so the summit lands exactly on one character. */
const CX = (W - 1) / 2;
const CY = (H - 1) / 2;

/** Which ring band a cell falls in: 0 at the summit, RINGS and up outside. */
function band(x: number, y: number) {
  const dx = (x - CX) / (CX - 1);
  const dy = (y - CY) / (CY - 0.5);
  const angle = Math.atan2(dy, dx);
  // A slightly uneven mountain: rings bulge on one flank, pinch on the other.
  const wobble = 1 + 0.12 * Math.sin(angle * 2 + 0.6) + 0.06 * Math.cos(angle * 3);
  // ×1.18 keeps the bulging outer ring inside the frame.
  const r = Math.hypot(dx, dy) * wobble * 1.18;
  return Math.floor(r * RINGS);
}

/** A cell is on a contour where its band differs from a neighbour's. */
function cell(x: number, y: number): [string, string] {
  if (x === CX && y === CY) return ['▲', RAMP[RAMP.length - 1]];
  const here = band(x, y);
  const edge = Math.min(here, band(x + 1, y), band(x, y + 1));
  if (edge === here && band(x + 1, y) === here && band(x, y + 1) === here) return [' ', ''];
  if (edge >= RINGS) return [' ', ''];
  // Outer rings low (teal), inner rings high (gold).
  return ['·', RAMP[Math.min(RAMP.length - 1, RINGS - 1 - edge)]];
}

export function greet() {
  const parts: string[] = [];
  const styles: string[] = [];
  const base = `background:${INK.base};font-family:ui-monospace,monospace;font-size:12px;line-height:1.25`;

  for (let y = 0; y < H; y++) {
    // Runs of one colour become one styled segment.
    let run = '';
    let colour = '';
    for (let x = 0; x < W; x++) {
      const [ch, c] = cell(x, y);
      if (c !== colour && run) {
        parts.push(`%c${run}`);
        styles.push(`${base};color:${colour || INK.base}`);
        run = '';
      }
      colour = c;
      run += ch;
    }
    parts.push(`%c${run}  \n`);
    styles.push(`${base};color:${colour || INK.base}`);
  }

  const title = `font:italic 28px Georgia,serif;color:${INK.text};padding:10px 0 2px`;
  const sub = `font:12px ui-monospace,monospace;color:${INK.subtle};letter-spacing:2px`;
  const body = `font:12px ui-monospace,monospace;color:${INK.text};line-height:1.6`;
  const dim = `font:12px ui-monospace,monospace;color:${INK.muted};line-height:1.6`;
  const key = `font:12px ui-monospace,monospace;color:#f6c177;line-height:1.6`;

  console.log(parts.join(''), ...styles);
  console.log(
    '%cTopography\n%cCONTOUR MAPS OF ANY MOUNTAIN ON EARTH',
    title,
    sub,
  );
  console.log(
    '%cContours are traced in your browser by a Rust → WebAssembly kernel, from\n' +
      'elevation tiles, every 25–300 m depending on the zoom.\n' +
      '%cElevation: AWS Terrain Tiles · Map data: © OpenStreetMap contributors,\n' +
      '© OpenMapTiles, via OpenFreeMap · Search: Photon',
    body,
    dim,
  );
  console.log(
    '%c/%c search   %c+ −%c zoom   %c← ↑ → ↓%c pan   %cdrag%c explore',
    key,
    dim,
    key,
    dim,
    key,
    dim,
    key,
    dim,
  );
}
