/**
 * A slowly spinning globe: the pre-rendered world texture (public/globe.png,
 * made by scripts/globe.ts) wrapped round a sphere on a 2D canvas, no 3D
 * library. Each pixel of the disc knows, once, which latitude and longitude
 * it shows and how it's lit; a frame only slides the longitudes along, so
 * spinning costs one texture lookup per pixel.
 */

export interface GlobeOptions {
  /** Seconds per turn. */
  period?: number;
  /** The axis leans the north pole towards the viewer by this much (radians). */
  tilt?: number;
  /** The longitude facing the viewer at the start (degrees). */
  facing?: number;
}

/** The light comes from the upper left, in front: a lit face and a dark limb. */
const LIGHT = normalise([-0.45, 0.5, 0.75]);
/** The unlit side keeps this much: night is dim, not black. */
const AMBIENT = 0.45;
/** Full light lifts the texture this much, so thin lowland lines still read. */
const LIT = 1.3;
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
  // One 32-bit word per texel: a frame copies words, no per-channel work.
  const texture = new Uint32Array(sctx.getImageData(0, 0, tw, th).data.buffer);

  const ctx = canvas.getContext('2d')!;
  let size = 0;
  let frame: ImageData;
  let pixels: Uint32Array;
  /**
   * Per disc pixel: where it writes, its texture row, its longitude at rest
   * (texels), its light, and its alpha (1 inside, fading over the edge pixel).
   */
  let at: Uint32Array;
  let row: Uint32Array;
  let lon: Float32Array;
  let light: Float32Array;
  let edge: Float32Array;

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
    // Room for every pixel; trimmed to the disc after.
    const cap = size * size;
    [at, row, lon, light, edge] = [
      new Uint32Array(cap),
      new Uint32Array(cap),
      new Float32Array(cap),
      new Float32Array(cap),
      new Float32Array(cap),
    ];
    let n = 0;
    for (let py = 0; py < size; py++) {
      for (let px = 0; px < size; px++) {
        const x = (px + 0.5 - c) / r;
        const y = (c - py - 0.5) / r;
        const d = Math.hypot(x, y);
        if (d > 1 + 1 / r) continue;
        const z = Math.sqrt(Math.max(0, 1 - x * x - y * y));
        // Into the globe's frame: undo the tilt about the screen's x axis.
        const wy = y * cos + z * sin;
        const wz = -y * sin + z * cos;
        const latitude = Math.asin(Math.max(-1, Math.min(1, wy)));
        const longitude = Math.atan2(x, wz);
        const lambert = Math.max(0, x * LIGHT[0] + y * LIGHT[1] + z * LIGHT[2]);
        const shade = AMBIENT + (LIT - AMBIENT) * lambert;
        // A one-pixel soft edge instead of a jagged one.
        const alpha = Math.max(0, Math.min(1, (1 - d) * r + 0.5));
        at[n] = py * size + px;
        row[n] = Math.min(th - 1, Math.floor((0.5 - latitude / Math.PI) * th));
        lon[n] = (longitude / (2 * Math.PI)) * tw;
        light[n] = shade;
        edge[n] = alpha;
        n++;
      }
    }
    [at, row, lon, light, edge] = [at.slice(0, n), row.slice(0, n), lon.slice(0, n), light.slice(0, n), edge.slice(0, n)];
  }

  /** Draw with longitude `turn` (texels) facing the viewer. */
  function draw(turn: number) {
    pixels.fill(0);
    for (let i = 0; i < at.length; i++) {
      let u = Math.floor(lon[i] + turn) % tw;
      if (u < 0) u += tw;
      const c = texture[row[i] * tw + u];
      // Little-endian RGBA in one word: shade the colour, set the alpha.
      const k = light[i];
      const r = Math.min(255, (c & 0xff) * k);
      const g = Math.min(255, ((c >>> 8) & 0xff) * k);
      const b = Math.min(255, ((c >>> 16) & 0xff) * k);
      pixels[at[i]] = ((edge[i] * 255) << 24) | (b << 16) | (g << 8) | r;
    }
    ctx.putImageData(frame, 0, 0);
  }

  const start = ((facing + 180) / 360) * tw;
  const still = matchMedia('(prefers-reduced-motion: reduce)');
  let visible = true;
  let raf = 0;
  let last = 0;
  const t0 = performance.now();

  function tick(now: number) {
    raf = 0;
    if (now - last >= 1000 / FPS) {
      last = now;
      // Earth turns eastward: the longitude facing us runs west over time.
      draw(start - (((now - t0) / 1000) * tw) / period);
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
    if (size !== before) draw(start - (((performance.now() - t0) / 1000) * tw) / period);
  }).observe(canvas);
  schedule();
}
