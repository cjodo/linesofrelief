//! Just enough Mapbox Vector Tile decoding to pick out the point features of
//! one layer that carry a given tag (say class=museum), with a few of their
//! properties. Mirrors src/mvt.ts, but lazily: a busy z14 poi layer holds
//! thousands of features with dozens of names each, and only a handful are
//! wanted, so values are decoded only for the features and keys kept.
//! Spec: https://github.com/mapbox/vector-tile-spec/tree/master/2.1

use serde_json::{Map, Value};

pub struct Point {
    pub properties: Map<String, Value>,
    /// Tile units, 0..extent inside the tile (the buffer lies outside).
    pub x: i64,
    pub y: i64,
}

// Ensure Point is Send for rayon parallelism
unsafe impl Send for Point {}

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

    fn index(&mut self) -> Option<usize> {
        usize::try_from(self.varint()?).ok()
    }

    fn bytes(&mut self) -> Option<&'a [u8]> {
        let len = self.index()?;
        let end = self.pos.checked_add(len)?;
        let out = self.buf.get(self.pos..end)?;
        self.pos = end;
        Some(out)
    }

    fn fixed<const N: usize>(&mut self) -> Option<[u8; N]> {
        let out = self.buf.get(self.pos..self.pos.checked_add(N)?)?.try_into().ok()?;
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

/// A string value's bytes, without decoding (or allocating) it.
fn string_bytes(buf: &[u8]) -> Option<&[u8]> {
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

/// The first point of a geometry: its leading MoveTo.
fn first_point(buf: &[u8]) -> Option<(i64, i64)> {
    let mut r = Reader::new(buf);
    let cmd = r.varint()?;
    if cmd & 7 != 1 || cmd >> 3 == 0 {
        return None;
    }
    Some((zigzag(r.varint()?), zigzag(r.varint()?)))
}

/// What to pick out of a layer: point features tagged `key` = `value`, with
/// the properties named in `keep`.
pub struct Want<'w> {
    pub key: &'w str,
    pub value: &'w str,
    pub keep: &'w [&'w str],
}

fn read_layer(buf: &[u8], want: &Want) -> Option<Layer> {
    let mut r = Reader::new(buf);
    let mut extent = 4096;
    // Keys and values stay raw slices of the tile until needed.
    let mut keys: Vec<&[u8]> = Vec::new();
    let mut values: Vec<&[u8]> = Vec::new();
    let mut features: Vec<&[u8]> = Vec::new();
    while r.more() {
        let tag = r.varint()?;
        match tag >> 3 {
            2 => features.push(r.bytes()?),
            3 => keys.push(r.bytes()?),
            4 => values.push(r.bytes()?),
            5 => extent = u32::try_from(r.varint()?).ok()?,
            _ => r.skip(tag & 7)?,
        }
    }
    let none = || Some(Layer { extent, points: Vec::new() });

    // The tag to match as indices into the tables: integer compares per pair.
    // (Encoders should dedupe values, but nothing requires it.)
    let Some(match_key) = keys.iter().position(|k| *k == want.key.as_bytes()) else { return none() };
    let match_values: Vec<usize> = (0..values.len())
        .filter(|&i| string_bytes(values[i]) == Some(want.value.as_bytes()))
        .collect();
    if match_values.is_empty() {
        return none();
    }
    // Each kept property's index in the layer's key table, where present.
    let keep: Vec<(usize, &str)> = want
        .keep
        .iter()
        .filter_map(|name| Some((keys.iter().position(|k| *k == name.as_bytes())?, *name)))
        .collect();

    // Features come before keys/values in some encoders, so they're read last.
    let mut points = Vec::new();
    for feature in features {
        let mut f = Reader::new(feature);
        let (mut kind, mut tags, mut geometry) = (0, None, None);
        while f.more() {
            let tag = f.varint()?;
            match tag >> 3 {
                2 => tags = Some(f.bytes()?),
                3 => kind = f.varint()?,
                4 => geometry = Some(f.bytes()?),
                _ => f.skip(tag & 7)?,
            }
        }
        let (1, Some(tags), Some(geometry)) = (kind, tags, geometry) else { continue };
        if !has_tag(tags, match_key, &match_values)? {
            continue;
        }
        let Some((x, y)) = first_point(geometry) else { continue };
        let mut properties = Map::new();
        let mut t = Reader::new(tags);
        while t.more() {
            let (k, v) = (t.index()?, t.index()?);
            if let Some((_, name)) = keep.iter().find(|(i, _)| *i == k) {
                properties.insert((*name).to_owned(), value(values.get(v)?)?);
            }
        }
        points.push(Point { properties, x, y });
    }
    Some(Layer { extent, points })
}

/// Whether a feature's packed (key, value) index pairs include `key` with one of `values`.
fn has_tag(tags: &[u8], key: usize, values: &[usize]) -> Option<bool> {
    let mut t = Reader::new(tags);
    while t.more() {
        let (k, v) = (t.index()?, t.index()?);
        if k == key && values.contains(&v) {
            return Some(true);
        }
    }
    Some(false)
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

/// The point features of the layer called `name` that `want` picks out, if
/// the tile has that layer.
pub fn points(tile: &[u8], name: &str, want: &Want) -> Option<Layer> {
    let mut r = Reader::new(tile);
    while r.more() {
        let tag = r.varint()?;
        if tag >> 3 == 3 {
            let buf = r.bytes()?;
            // Only the wanted layer is read past its name.
            if layer_name(buf)? == name.as_bytes() {
                return read_layer(buf, want);
            }
        } else {
            r.skip(tag & 7)?;
        }
    }
    None
}
