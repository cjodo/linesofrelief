/**
 * Minimal Mapbox Vector Tile decoder: just enough protobuf to read layers,
 * feature properties and geometry. Replaces @mapbox/vector-tile + pbf.
 * Spec: https://github.com/mapbox/vector-tile-spec/tree/master/2.1
 */

export type Value = string | number | boolean;
export type Ring = { x: number; y: number }[];

export interface Feature {
  /** 1 point, 2 line, 3 polygon. */
  type: number;
  properties: Record<string, Value>;
  /** Decoded on demand; closed rings repeat their first point. */
  loadGeometry(): Ring[];
}

export interface Layer {
  extent: number;
  features: Feature[];
}

const utf8 = new TextDecoder();

class Reader {
  pos: number;
  end: number;
  readonly buf: Uint8Array;
  readonly view: DataView;

  constructor(buf: Uint8Array, pos = 0, end = buf.length) {
    this.buf = buf;
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    this.pos = pos;
    this.end = end;
  }

  /** Unsigned varint, exact up to 2^53. */
  varint(): number {
    let result = 0;
    let mul = 1;
    let b: number;
    do {
      b = this.buf[this.pos++];
      result += (b & 0x7f) * mul;
      mul *= 128;
    } while (b & 0x80);
    return result;
  }

  /** Byte range of a length-delimited field. */
  bytes(): [number, number] {
    const len = this.varint();
    const start = this.pos;
    this.pos += len;
    return [start, this.pos];
  }

  string(): string {
    const [a, b] = this.bytes();
    return utf8.decode(this.buf.subarray(a, b));
  }

  skip(wire: number) {
    if (wire === 0) this.varint();
    else if (wire === 1) this.pos += 8;
    else if (wire === 2) this.bytes();
    else if (wire === 5) this.pos += 4;
    else throw new Error(`unsupported wire type ${wire}`);
  }
}

const zigzag = (n: number) => (n % 2 === 1 ? -(n + 1) / 2 : n / 2);
/** int64 arrives as a 64-bit two's-complement varint. */
const int64 = (n: number) => (n >= 2 ** 63 ? n - 2 ** 64 : n);

function readValue(r: Reader): Value {
  let value: Value = '';
  while (r.pos < r.end) {
    const tag = r.varint();
    const field = tag >> 3;
    if (field === 1) value = r.string();
    else if (field === 2) {
      value = r.view.getFloat32(r.pos, true);
      r.pos += 4;
    } else if (field === 3) {
      value = r.view.getFloat64(r.pos, true);
      r.pos += 8;
    } else if (field === 4) value = int64(r.varint());
    else if (field === 5) value = r.varint();
    else if (field === 6) value = zigzag(r.varint());
    else if (field === 7) value = r.varint() !== 0;
    else r.skip(tag & 7);
  }
  return value;
}

function geometry(buf: Uint8Array, start: number, end: number): Ring[] {
  const r = new Reader(buf, start, end);
  const rings: Ring[] = [];
  let ring: Ring | null = null;
  let x = 0;
  let y = 0;
  while (r.pos < r.end) {
    const cmd = r.varint();
    const id = cmd & 7;
    const count = cmd >> 3;
    if (id === 7) {
      // ClosePath
      if (ring?.length) ring.push({ ...ring[0] });
      continue;
    }
    for (let i = 0; i < count; i++) {
      x += zigzag(r.varint());
      y += zigzag(r.varint());
      if (id === 1) {
        // MoveTo starts a new ring or line
        ring = [];
        rings.push(ring);
      }
      ring!.push({ x, y });
    }
  }
  return rings;
}

function readLayer(buf: Uint8Array, start: number, end: number): [string, Layer] {
  const r = new Reader(buf, start, end);
  let name = '';
  let extent = 4096;
  const keys: string[] = [];
  const values: Value[] = [];
  const raw: [number, number][] = [];
  while (r.pos < r.end) {
    const tag = r.varint();
    const field = tag >> 3;
    if (field === 1) name = r.string();
    else if (field === 2) raw.push(r.bytes());
    else if (field === 3) keys.push(r.string());
    else if (field === 4) {
      const [a, b] = r.bytes();
      values.push(readValue(new Reader(buf, a, b)));
    } else if (field === 5) extent = r.varint();
    else r.skip(tag & 7);
  }

  // Features come before keys/values in some encoders, so decode them last.
  const features = raw.map(([a, b]): Feature => {
    const f = new Reader(buf, a, b);
    let type = 0;
    let geom: [number, number] = [0, 0];
    const properties: Record<string, Value> = {};
    while (f.pos < f.end) {
      const tag = f.varint();
      const field = tag >> 3;
      if (field === 2) {
        const [ta, tb] = f.bytes();
        const t = new Reader(buf, ta, tb);
        while (t.pos < t.end) {
          const k = t.varint();
          properties[keys[k]] = values[t.varint()];
        }
      } else if (field === 3) type = f.varint();
      else if (field === 4) geom = f.bytes();
      else f.skip(tag & 7);
    }
    return { type, properties, loadGeometry: () => geometry(buf, geom[0], geom[1]) };
  });
  return [name, { extent, features }];
}

export function decodeTile(data: ArrayBuffer): Record<string, Layer> {
  const buf = new Uint8Array(data);
  const r = new Reader(buf);
  const layers: Record<string, Layer> = {};
  while (r.pos < r.end) {
    const tag = r.varint();
    if (tag >> 3 === 3) {
      const [a, b] = r.bytes();
      const [name, layer] = readLayer(buf, a, b);
      layers[name] = layer;
    } else r.skip(tag & 7);
  }
  return layers;
}
