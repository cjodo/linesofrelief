/**
 * A slowly spinning wireframe globe: the pre-rendered world texture
 * (public/globe.png, made by scripts/globe.ts: anti-aliased contour lines and
 * a graticule on a transparent ground) wrapped round a sphere you can see
 * through. Plain WebGL2, no 3D library: one fragment shader works out, for
 * each pixel, the point it shows on the near side and on the far side behind
 * it. The GPU's filtering (bilinear, mipmapped) keeps the lines steady as
 * they turn; stepping texel by texel is what made them shimmer.
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

function normalise([x, y, z]: number[]) {
  const n = Math.hypot(x, y, z);
  return [x / n, y / n, z / n];
}

const VERTEX = `#version 300 es
in vec2 corner;
out vec2 p;
void main() {
  p = corner; // -1..1, y up
  gl_Position = vec4(corner, 0.0, 1.0);
}`;

const FRAGMENT = `#version 300 es
precision highp float;
uniform sampler2D world;
uniform float turn;   // texture u facing the viewer, 0..1
uniform float tilt;
uniform float pixel;  // one pixel, in units of the radius
uniform vec3 light;
in vec2 p;
out vec4 colour;
const float PI = 3.14159265;

// The texture at view-space point q on the unit sphere.
vec4 look(vec3 q) {
  // Into the globe's frame: undo the tilt about the screen's x axis.
  float wy = q.y * cos(tilt) + q.z * sin(tilt);
  float wz = -q.y * sin(tilt) + q.z * cos(tilt);
  vec2 uv = vec2(atan(q.x, wz) / (2.0 * PI) + turn, 0.5 - asin(clamp(wy, -1.0, 1.0)) / PI);
  // Where longitude wraps, its screen derivative jumps and the mip level
  // would too, drawing a seam: take the smaller of it and a half-turn copy's.
  vec2 dx = dFdx(uv), dy = dFdy(uv);
  float dx2 = dFdx(fract(uv.x + 0.5)), dy2 = dFdy(fract(uv.x + 0.5));
  dx.x = abs(dx.x) < abs(dx2) ? dx.x : dx2;
  dy.x = abs(dy.x) < abs(dy2) ? dy.x : dy2;
  return textureGrad(world, uv, dx, dy);
}

void main() {
  float r2 = dot(p, p);
  // No early discard: derivatives need every pixel of a quad to run.
  float z = sqrt(max(0.0, 1.0 - r2));
  vec4 near = look(vec3(p, z));
  vec4 far = look(vec3(p, -z));
  float k = mix(${DIM.toFixed(3)}, ${LIT.toFixed(3)}, max(0.0, dot(vec3(p, z), light)));
  // Premultiplied: near lines lit, the far side faint wherever the near side is clear.
  float through = ${THROUGH.toFixed(3)} * (1.0 - near.a);
  vec4 c = vec4(near.rgb * k + far.rgb * through, near.a + far.a * through);
  // A soft one-pixel rim, and nothing outside the disc.
  colour = c * clamp((1.0 - sqrt(r2)) / pixel + 0.5, 0.0, 1.0);
}`;

function compile(gl: WebGL2RenderingContext, type: number, source: string) {
  const shader = gl.createShader(type)!;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) ?? 'shader');
  return shader;
}

export async function createGlobe(
  canvas: HTMLCanvasElement,
  textureUrl: string,
  { period = 150, tilt = 0.32, facing = -100 }: GlobeOptions = {},
) {
  const gl = canvas.getContext('webgl2', { premultipliedAlpha: true, antialias: false });
  // Without WebGL2 the page simply goes without its globe.
  if (!gl) {
    canvas.hidden = true;
    return;
  }
  const img = new Image();
  img.decoding = 'async';
  img.src = textureUrl;
  await img.decode();

  const program = gl.createProgram()!;
  gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERTEX));
  gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAGMENT));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? 'link');
  gl.useProgram(program);

  // One quad over the whole canvas; the shader draws the disc.
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const corner = gl.getAttribLocation(program, 'corner');
  gl.enableVertexAttribArray(corner);
  gl.vertexAttribPointer(corner, 2, gl.FLOAT, false, 0, 0);

  // Premultiplied on upload, so mipmaps average soft line edges correctly.
  gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
  gl.generateMipmap(gl.TEXTURE_2D);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  const uniform = (name: string) => gl.getUniformLocation(program, name);
  const uTurn = uniform('turn');
  const uPixel = uniform('pixel');
  gl.uniform1f(uniform('tilt'), tilt);
  gl.uniform3fv(uniform('light'), LIGHT);

  function layout() {
    const dpr = Math.min(2, devicePixelRatio || 1);
    const size = Math.round(canvas.clientWidth * dpr);
    if (size === 0 || size === canvas.width) return;
    canvas.width = canvas.height = size;
    gl!.viewport(0, 0, size, size);
    gl!.uniform1f(uPixel, 2 / size);
  }

  const start = (facing + 180) / 360;
  const t0 = performance.now();
  // Earth turns eastward: the longitude facing us runs west over time.
  function draw(now: number) {
    gl!.uniform1f(uTurn, start - (now - t0) / 1000 / period);
    gl!.drawArrays(gl!.TRIANGLE_STRIP, 0, 4);
  }

  const still = matchMedia('(prefers-reduced-motion: reduce)');
  let visible = true;
  let raf = 0;
  function tick(now: number) {
    raf = 0;
    draw(now);
    schedule();
  }
  function schedule() {
    if (!raf && visible && !still.matches && !document.hidden) raf = requestAnimationFrame(tick);
  }

  layout();
  draw(t0);
  new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting;
    schedule();
  }).observe(canvas);
  document.addEventListener('visibilitychange', schedule);
  still.addEventListener('change', schedule);
  new ResizeObserver(() => {
    layout();
    draw(performance.now());
  }).observe(canvas);
  schedule();
}
