/**
 * Minimal PNG decoder for elevation tiles: 8-bit RGB or RGBA, not interlaced
 * (what Terrarium tiles are). Returns raw pixels and the channel count.
 */
import { inflateSync } from 'node:zlib';

export function decodePng(buf: Uint8Array): { width: number; height: number; channels: number; pixels: Uint8Array } {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (view.getUint32(0) !== 0x89504e47) throw new Error('not a PNG');
  let at = 8;
  let width = 0;
  let height = 0;
  let channels = 0;
  const idat: Uint8Array[] = [];
  while (at < buf.length) {
    const length = view.getUint32(at);
    const type = String.fromCharCode(...buf.subarray(at + 4, at + 8));
    const data = buf.subarray(at + 8, at + 8 + length);
    if (type === 'IHDR') {
      const d = new DataView(data.buffer, data.byteOffset, data.byteLength);
      width = d.getUint32(0);
      height = d.getUint32(4);
      const [depth, colour, , , interlace] = data.subarray(8, 13);
      if (depth !== 8 || interlace !== 0 || (colour !== 2 && colour !== 6)) {
        throw new Error(`unsupported PNG (depth ${depth}, colour ${colour}, interlace ${interlace})`);
      }
      channels = colour === 2 ? 3 : 4;
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    at += 12 + length;
  }

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const pixels = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const out = y * stride;
    const prev = out - stride;
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? pixels[out + i - channels] : 0; // left
      const b = y > 0 ? pixels[prev + i] : 0; // up
      const c = y > 0 && i >= channels ? pixels[prev + i - channels] : 0; // up-left
      let v = raw[src + i];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      pixels[out + i] = v & 0xff;
    }
  }
  return { width, height, channels, pixels };
}
