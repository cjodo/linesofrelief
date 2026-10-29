//! Just enough Mapbox Vector Tile decoding to read the point features of one
//! layer: properties and the first point. Mirrors src/mvt.ts.
//! Spec: https://github.com/mapbox/vector-tile-spec/tree/master/2.1

use serde_json::{Map, Value};

pub struct Point {
    pub properties: Map<String, Value>,
    /// Tile units, 0..extent inside the tile (the buffer lies outside).
    pub x: i64,
    pub y: i64,
}

pub struct Layer {
    pub extent: u32,
    pub points: Vec<Point>,
}

struct Reader<'a> {
    buf: &'a [u8],
    pos: usize,
}

impl<'a> Reader<'a> {
    fn new(buf: &'a [u8]) -> Self {
        Self { buf, pos: 0 }
    }

    fn more(&self) -> bool {
        self.pos < self.buf.len()
    }

    fn varint(&mut self) -> Option<u64> {
        let mut result = 0u64;
        for shift in (0..64).step_by(7) {
            let b = *self.buf.get(self.pos)?;
            self.pos += 1;
            result |= u64::from(b & 0x7f) << shift;
            if b & 0x80 == 0 {
                return Some(result);
            }
        }
        None
    }

    fn bytes(&mut self) -> Option<&'a [u8]> {
        let len = usize::try_from(self.varint()?).ok()?;
        let end = self.pos.checked_add(len)?;
        let out = self.buf.get(self.pos..end)?;
        self.pos = end;
        Some(out)
    }

    fn fixed<const N: usize>(&mut self) -> Option<[u8; N]> {
        let out = self.buf.get(self.pos..self.pos + N)?.try_into().ok()?;
        self.pos += N;
        Some(out)
    }

    fn skip(&mut self, wire: u64) -> Option<()> {
        match wire {
            0 => drop(self.varint()?),
            1 => drop(self.fixed::<8>()?),
            2 => drop(self.bytes()?),
            5 => drop(self.fixed::<4>()?),
            _ => return None,
        }
        Some(())
    }
}

const fn zigzag(n: u64) -> i64 {
    (n >> 1) as i64 ^ -((n & 1) as i64)
}

fn value(buf: &[u8]) -> Option<Value> {
    let mut r = Reader::new(buf);
    let mut value = Value::Null;
    while r.more() {
        let tag = r.varint()?;
        value = match tag >> 3 {
            1 => Value::String(String::from_utf8_lossy(r.bytes()?).into_owned()),
            2 => f64::from(f32::from_le_bytes(r.fixed()?)).into(),
            3 => f64::from_le_bytes(r.fixed()?).into(),
            4 => (r.varint()? as i64).into(),
            5 => r.varint()?.into(),
            6 => zigzag(r.varint()?).into(),
            7 => (r.varint()? != 0).into(),
            _ => {
                r.skip(tag & 7)?;
                continue;
            }
        };
    }
    Some(value)
}

/// The first point of a geometry: its leading MoveTo.
fn first_point(buf: &[u8]) -> Option<(i64, i64)> {
    let mut r = Reader::new(buf);
    let cmd = r.varint()?;
    if cmd & 7 != 1 || cmd >> 3 == 0 {
        return None;
    }
    Some((zigzag(r.varint()?), zigzag(r.varint()?)))
}

fn read_layer(buf: &[u8]) -> Option<Layer> {
    let mut r = Reader::new(buf);
    let mut extent = 4096;
    let mut keys = Vec::new();
    let mut values = Vec::new();
    let mut raw = Vec::new();
    while r.more() {
        let tag = r.varint()?;
        match tag >> 3 {
            2 => raw.push(r.bytes()?),
            3 => keys.push(String::from_utf8_lossy(r.bytes()?).into_owned()),
            4 => values.push(value(r.bytes()?)?),
            5 => extent = u32::try_from(r.varint()?).ok()?,
            _ => r.skip(tag & 7)?,
        }
    }

    // Features come before keys/values in some encoders, so decode them last.
    let mut points = Vec::new();
    for feature in raw {
        let mut f = Reader::new(feature);
        let mut kind = 0;
        let mut properties = Map::new();
        let mut point = None;
        while f.more() {
            let tag = f.varint()?;
            match tag >> 3 {
                2 => {
                    let mut t = Reader::new(f.bytes()?);
                    while t.more() {
                        let k = keys.get(usize::try_from(t.varint()?).ok()?)?;
                        let v = values.get(usize::try_from(t.varint()?).ok()?)?;
                        properties.insert(k.clone(), v.clone());
                    }
                }
                3 => kind = f.varint()?,
                4 => point = first_point(f.bytes()?),
                _ => f.skip(tag & 7)?,
            }
        }
        if let (1, Some((x, y))) = (kind, point) {
            points.push(Point { properties, x, y });
        }
    }
    Some(Layer { extent, points })
}

fn layer_name(buf: &[u8]) -> Option<&[u8]> {
    let mut r = Reader::new(buf);
    while r.more() {
        let tag = r.varint()?;
        if tag >> 3 == 1 {
            return r.bytes();
        }
        r.skip(tag & 7)?;
    }
    None
}

/// The point features of the layer called `name`, if the tile has one.
pub fn points(tile: &[u8], name: &str) -> Option<Layer> {
    let mut r = Reader::new(tile);
    while r.more() {
        let tag = r.varint()?;
        if tag >> 3 == 3 {
            let buf = r.bytes()?;
            // Only the wanted layer is decoded in full.
            if layer_name(buf)? == name.as_bytes() {
                return read_layer(buf);
            }
        } else {
            r.skip(tag & 7)?;
        }
    }
    None
}
