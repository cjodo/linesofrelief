/**
 * A slowly spinning wireframe globe: the pre-rendered world texture
 * (public/globe.png, made by scripts/globe.ts: contour lines and a graticule
 * on a transparent ground) wrapped round a sphere you can see through, on a
 * 2D canvas, no 3D library. Each pixel of the disc knows, once, which point
 * it shows on the near side and on the far side; a frame only slides the
 * longitudes along, so spinning costs two texture lookups per pixel.
 */

export interface GlobeOptions {
  /** Seconds per turn. */
  period?: number;
  /** The axis leans the north pole towards the viewer by this much (radians). */
  tilt?: number;
  /** The longitude facing the viewer at the start (degrees). */
  facing?: number;
}

/** The light comes from the upper left, in front: near lines catch it. */
const LIGHT = normalise([-0.45, 0.5, 0.75]);
/** Near-side lines run from this brightness (at the limb) to LIT (facing the light). */
const DIM = 0.75;
const LIT = 1.15;
/** Far-side lines show through at this strength. */
const THROUGH = 0.3;
/** At most this many frames a second: it turns slowly, so more would be waste. */
const FPS = 30;

function normalise([x, y, z]: number[]) {
  const n = Math.hypot(x, y, z);
  return [x / n, y / n, z / n];
}

export async function createGlobe(
  canvas: HTMLCanvasElement,
  textureUrl: string,
  { period = 150, tilt = 0.32, facing = -100 }: GlobeOptions = {},
) {
  const img = new Image();
  img.decoding = 'async';
  img.src = textureUrl;
  await img.decode();
  const [tw, th] = [img.naturalWidth, img.naturalHeight];
  const scratch = document.createElement('canvas');
  [scratch.width, scratch.height] = [tw, th];
  const sctx = scratch.getContext('2d', { willReadFrequently: true })!;
  sctx.drawImage(img, 0, 0);
  // One 32-bit word per texel (little-endian RGBA): a frame copies words.
  const texture = new Uint32Array(sctx.getImageData(0, 0, tw, th).data.buffer);

  const ctx = canvas.getContext('2d')!;
  let size = 0;
  let frame: ImageData;
  let pixels: Uint32Array;
  /**
   * Per disc pixel: where it writes; the texture row and longitude at rest
   * (texels) of the near point and of the far point behind it; the near
   * point's light.
   */
  let at: Uint32Array;
  let nearRow: Uint32Array;
  let nearLon: Float32Array;
  let farRow: Uint32Array;
  let farLon: Float32Array;
  let light: Float32Array;

  function layout() {
    const dpr = Math.min(2, devicePixelRatio || 1);
    const next = Math.round(canvas.clientWidth * dpr);
    if (next === size || next === 0) return;
    size = next;
    canvas.width = canvas.height = size;
    frame = ctx.createImageData(size, size);
    pixels = new Uint32Array(frame.data.buffer);
    const r = size / 2 - 1;
    const c = size / 2;
    const cos = Math.cos(tilt);
    const sin = Math.sin(tilt);
    /** Texture row and longitude (texels) of the point (x, y, z) in view space. */
    const lookup = (x: number, y: number, z: number): [number, number] => {
      // Into the globe's frame: undo the tilt about the screen's x axis.
      const wy = y * cos + z * sin;
      const wz = -y * sin + z * cos;
      const latitude = Math.asin(Math.max(-1, Math.min(1, wy)));
      return [Math.min(th - 1, Math.floor((0.5 - latitude / Math.PI) * th)), (Math.atan2(x, wz) / (2 * Math.PI)) * tw];
    };
    // Room for every pixel; trimmed to the disc after.
    const cap = size * size;
    at = new Uint32Array(cap);
    nearRow = new Uint32Array(cap);
    nearLon = new Float32Array(cap);
    farRow = new Uint32Array(cap);
    farLon = new Float32Array(cap);
    light = new Float32Array(cap);
    let n = 0;
    for (let py = 0; py < size; py++) {
      for (let px = 0; px < size; px++) {
        const x = (px + 0.5 - c) / r;
        const y = (c - py - 0.5) / r;
        if (x * x + y * y > 1) continue;
        const z = Math.sqrt(1 - x * x - y * y);
        at[n] = py * size + px;
        [nearRow[n], nearLon[n]] = lookup(x, y, z);
        [farRow[n], farLon[n]] = lookup(x, y, -z);
        const lambert = Math.max(0, x * LIGHT[0] + y * LIGHT[1] + z * LIGHT[2]);
        light[n] = DIM + (LIT - DIM) * lambert;
        n++;
      }
    }
    at = at.slice(0, n);
    nearRow = nearRow.slice(0, n);
    nearLon = nearLon.slice(0, n);
    farRow = farRow.slice(0, n);
    farLon = farLon.slice(0, n);
    light = light.slice(0, n);
  }

  /** The texel at `row` for longitude `lon` + `turn` (texels), wrapping round. */
  const texel = (row: number, lon: number, turn: number) => {
    let u = Math.floor(lon + turn) % tw;
    if (u < 0) u += tw;
    return texture[row * tw + u];
  };

  /** Draw with longitude `turn` (texels) facing the viewer. */
  function draw(turn: number) {
    pixels.fill(0);
    for (let i = 0; i < at.length; i++) {
      let c = texel(nearRow[i], nearLon[i], turn);
      let k = light[i];
      let alpha = c >>> 24;
      if (alpha === 0) {
        // Nothing on the near side here: the far side shows through, faintly.
        c = texel(farRow[i], farLon[i], turn);
        alpha = (c >>> 24) * THROUGH;
        if (alpha === 0) continue;
        k = 1;
      }
      const r = Math.min(255, (c & 0xff) * k);
      const g = Math.min(255, ((c >>> 8) & 0xff) * k);
      const b = Math.min(255, ((c >>> 16) & 0xff) * k);
      pixels[at[i]] = (alpha << 24) | (b << 16) | (g << 8) | r;
    }
    ctx.putImageData(frame, 0, 0);
  }

  const start = ((facing + 180) / 360) * tw;
  const still = matchMedia('(prefers-reduced-motion: reduce)');
  let visible = true;
  let raf = 0;
  let last = 0;
  const t0 = performance.now();
  // Earth turns eastward: the longitude facing us runs west over time.
  const turnAt = (now: number) => start - (((now - t0) / 1000) * tw) / period;

  function tick(now: number) {
    raf = 0;
    if (now - last >= 1000 / FPS) {
      last = now;
      draw(turnAt(now));
    }
    schedule();
  }
  function schedule() {
    if (!raf && visible && !still.matches && !document.hidden) raf = requestAnimationFrame(tick);
  }

  layout();
  draw(start);
  new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting;
    schedule();
  }).observe(canvas);
  document.addEventListener('visibilitychange', schedule);
  still.addEventListener('change', schedule);
  new ResizeObserver(() => {
    const before = size;
    layout();
    if (size !== before) draw(turnAt(performance.now()));
  }).observe(canvas);
  schedule();
}
