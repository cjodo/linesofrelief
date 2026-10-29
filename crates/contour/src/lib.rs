//! Contour kernel: downsample → blur → multi-level marching squares →
//! joined, simplified polylines.
//!
//! Exposed through a tiny C ABI so the worker can call it without
//! wasm-bindgen. Single-threaded by design (one instance per worker).
//!
//! Output layout after `run`:
//!   coords: f32 x,y pairs in downsampled-grid units (cell centres at +0.5)
//!   meta:   u32 per level: [value, line_count, len_0 .. len_n] (len in points)
//!
//! no_std keeps the module small: no panic messages or formatting machinery.
//! A panic (only possible from a bug) traps.

#![no_std]

extern crate alloc;

use alloc::{vec, vec::Vec};
use core::alloc::{GlobalAlloc, Layout};
use core::ptr::{addr_of_mut, null_mut};

#[cfg(not(target_arch = "wasm32"))]
use rayon::prelude::*;

#[cfg(target_arch = "wasm32")]
use core::arch::wasm32::{memory_grow, memory_size};

// --- Allocator ----------------------------------------------------------------
//
// Every allocation lives for exactly one run: JS copies the results out before
// the next `input_ptr`, which resets the heap. So a bump allocator suffices,
// and is a fraction of the size of a general-purpose one.

extern "C" {
    /// End of static data; the linker places the heap after it.
    static __heap_base: u8;
}

struct Bump;

static mut NEXT: usize = 0;

#[cfg(target_arch = "wasm32")]
const PAGE: usize = 65_536;

fn heap_base() -> usize {
    #[cfg(target_arch = "wasm32")] {
        // SAFETY: linker-provided symbol; only its address is used.
        unsafe { &__heap_base as *const u8 as usize }
    }
    #[cfg(not(target_arch = "wasm32"))] {
        // Fallback for non-WASM targets (e.g., tests)
        0
    }
}

/// Make sure linear memory reaches `end`, growing it if needed.
fn reserve(end: usize) -> bool {
    #[cfg(target_arch = "wasm32")] {
        let have = memory_size(0) * PAGE;
        end <= have || memory_grow(0, (end - have).div_ceil(PAGE)) != usize::MAX
    }
    #[cfg(not(target_arch = "wasm32"))] {
        true // Always allow allocation in non-WASM targets
    }
}

unsafe impl GlobalAlloc for Bump {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let next = if NEXT == 0 { heap_base() } else { NEXT };
        let start = (next + layout.align() - 1) & !(layout.align() - 1);
        let end = start + layout.size();
        if !reserve(end) {
            return null_mut();
        }
        NEXT = end;
        start as *mut u8
    }

    unsafe fn dealloc(&self, _: *mut u8, _: Layout) {}

    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        // The newest allocation can grow in place, which is how Vecs grow here.
        if ptr as usize + layout.size() == NEXT {
            let end = ptr as usize + new_size;
            if !reserve(end) {
                return null_mut();
            }
            NEXT = end;
            return ptr;
        }
        let new = self.alloc(Layout::from_size_align_unchecked(new_size, layout.align()));
        if !new.is_null() {
            core::ptr::copy_nonoverlapping(ptr, new, layout.size().min(new_size));
        }
        new
    }
}

#[cfg(target_arch = "wasm32")]
#[global_allocator]
static ALLOC: Bump = Bump;

#[cfg(target_arch = "wasm32")]
#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    core::arch::wasm32::unreachable()
}

/// `f32::floor` lives in std; values here are far inside i32 range.
fn floor(x: f32) -> f32 {
    let t = x as i32 as f32;
    if t > x {
        t - 1.0
    } else {
        t
    }
}

const NONE: u32 = u32::MAX;

#[derive(Default)]
struct State {
    input: Vec<f32>,
    coords: Vec<f32>,
    meta: Vec<u32>,
    min: f32,
    max: f32,
}

static mut STATE: Option<State> = None;

fn state() -> &'static mut State {
    // SAFETY: wasm instance is single-threaded and callers never re-enter.
    unsafe { (*addr_of_mut!(STATE)).get_or_insert_with(State::default) }
}

/// Reserve `len` floats for the full-resolution input grid and return them.
#[no_mangle]
pub extern "C" fn input_ptr(len: usize) -> *mut f32 {
    // A new run: everything from the last one is dead, so start the heap over.
    // SAFETY: single-threaded; the old state is dropped before the reset.
    unsafe {
        *addr_of_mut!(STATE) = None;
        NEXT = heap_base();
    }
    let s = state();
    s.input.clear();
    s.input.resize(len, 0.0);
    s.input.as_mut_ptr()
}

#[no_mangle]
pub extern "C" fn coords_ptr() -> *const f32 {
    state().coords.as_ptr()
}

#[no_mangle]
pub extern "C" fn coords_len() -> usize {
    state().coords.len()
}

#[no_mangle]
pub extern "C" fn meta_ptr() -> *const u32 {
    state().meta.as_ptr()
}

#[no_mangle]
pub extern "C" fn meta_len() -> usize {
    state().meta.len()
}

#[no_mangle]
pub extern "C" fn min_value() -> f32 {
    state().min
}

#[no_mangle]
pub extern "C" fn max_value() -> f32 {
    state().max
}

/// Contour the input grid (`width`×`height`, full resolution) at every
/// multiple of `interval`, after `ds`×`ds` averaging and a light blur.
/// `epsilon` is the simplification tolerance in downsampled cells.
#[no_mangle]
pub extern "C" fn run(width: u32, height: u32, ds: u32, interval: f32, epsilon: f32) {
    let s = state();
    let ds = ds.max(1) as usize;
    let w0 = width as usize;
    let (w, h) = (w0 / ds, height as usize / ds);

    let mut grid = downsample(&s.input, w0, w, h, ds);
    blur(&mut grid, w, h);

    let (lo, hi) = grid
        .iter()
        .fold((f32::INFINITY, f32::NEG_INFINITY), |(a, b), &v| (a.min(v), b.max(v)));
    s.min = lo;
    s.max = hi;
    s.coords.clear();
    s.meta.clear();
    if w < 2 || h < 2 || !(hi > lo) {
        return;
    }

    let t0 = (floor(lo / interval) + 1.0) * interval;
    if t0 > hi {
        return;
    }
    let levels = floor((hi - t0) / interval) as usize + 1;

    // Bucket cells by the levels that can cross them (counting sort), so each
    // level only visits its own cells instead of rescanning the whole grid.
    let range = |i: usize| -> Option<(usize, usize)> {
        let (a, b, c, d) = (grid[i], grid[i + 1], grid[i + w + 1], grid[i + w]);
        let lo = a.min(b).min(c).min(d);
        let hi = a.max(b).max(c).max(d);
        // Widen by one each side; the per-cell case test discards misses.
        let kmin = floor((lo - t0) / interval) as isize;
        let kmax = floor((hi - t0) / interval) as isize + 1;
        let kmin = kmin.max(0) as usize;
        let kmax = kmax.min(levels as isize - 1);
        (kmax >= kmin as isize).then(|| (kmin, kmax as usize))
    };

    let mut starts = vec![0usize; levels + 1];
    for y in 0..h - 1 {
        for x in 0..w - 1 {
            if let Some((a, b)) = range(y * w + x) {
                for k in a..=b {
                    starts[k + 1] += 1;
                }
            }
        }
    }
    for k in 0..levels {
        starts[k + 1] += starts[k];
    }
    let mut cells = vec![0u32; starts[levels]];
    let mut fill = starts.clone();
    for y in 0..h - 1 {
        for x in 0..w - 1 {
            let i = y * w + x;
            if let Some((a, b)) = range(i) {
                for k in a..=b {
                    cells[fill[k]] = i as u32;
                    fill[k] += 1;
                }
            }
        }
    }

    // Edge ids: horizontal edge (x,y)-(x+1,y) is y*w+x; vertical edge
    // (x,y)-(x,y+1) is w*h + y*w+x. Each edge joins at most two segments.
    let vbase = w * h;
    let mut slot_a = vec![NONE; 2 * w * h];
    let mut slot_b = vec![NONE; 2 * w * h];
    let mut segs: Vec<[u32; 2]> = Vec::new();
    let mut visited: Vec<bool> = Vec::new();
    let mut line: Vec<u32> = Vec::new();
    let mut back: Vec<u32> = Vec::new();
    let mut pts: Vec<[f32; 2]> = Vec::new();
    let mut keep: Vec<bool> = Vec::new();
    let mut stack: Vec<(usize, usize)> = Vec::new();

    for k in 0..levels {
        let t = t0 + k as f32 * interval;
        segs.clear();
        for &ci in &cells[starts[k]..starts[k + 1]] {
            let i = ci as usize;
            let (a, b, c, d) = (grid[i], grid[i + 1], grid[i + w + 1], grid[i + w]);
            let (ha, hb, hc, hd) = (a >= t, b >= t, c >= t, d >= t);
            let case = (ha as u8) << 3 | (hb as u8) << 2 | (hc as u8) << 1 | hd as u8;
            let top = i as u32;
            let bottom = (i + w) as u32;
            let left = (vbase + i) as u32;
            let right = (vbase + i + 1) as u32;
            match case {
                0 | 15 => {}
                // Saddles: the centre value decides which corners connect.
                5 => {
                    if (a + b + c + d) * 0.25 >= t {
                        segs.extend([[left, top], [right, bottom]]);
                    } else {
                        segs.extend([[top, right], [left, bottom]]);
                    }
                }
                10 => {
                    if (a + b + c + d) * 0.25 >= t {
                        segs.extend([[top, right], [left, bottom]]);
                    } else {
                        segs.extend([[left, top], [right, bottom]]);
                    }
                }
                _ => {
                    let mut e = [0u32; 2];
                    let mut n = 0;
                    for (crossed, edge) in
                        [(ha != hb, top), (hb != hc, right), (hc != hd, bottom), (hd != ha, left)]
                    {
                        if crossed {
                            e[n] = edge;
                            n += 1;
                        }
                    }
                    segs.push(e);
                }
            }
        }
        if segs.is_empty() {
            continue;
        }

        for (si, seg) in segs.iter().enumerate() {
            for &e in seg {
                let e = e as usize;
                if slot_a[e] == NONE {
                    slot_a[e] = si as u32;
                } else {
                    slot_b[e] = si as u32;
                }
            }
        }

        let meta_start = s.meta.len();
        s.meta.extend([floor(t + 0.5) as u32, 0]);
        visited.clear();
        visited.resize(segs.len(), false);

        for start in 0..segs.len() {
            if visited[start] {
                continue;
            }
            visited[start] = true;
            let [e0, e1] = segs[start];
            line.clear();
            line.extend([e0, e1]);
            walk(&segs, &slot_a, &slot_b, &mut visited, start as u32, e1, &mut line);
            if line.last() != Some(&e0) {
                back.clear();
                walk(&segs, &slot_a, &slot_b, &mut visited, start as u32, e0, &mut back);
                back.reverse();
                back.extend_from_slice(&line);
                core::mem::swap(&mut line, &mut back);
            }

            pts.clear();
            pts.extend(line.iter().map(|&e| edge_point(&grid, w, vbase, e as usize, t)));
            simplify(&pts, epsilon, &mut keep, &mut stack);
            let mut n = 0;
            for (p, &kept) in pts.iter().zip(&keep) {
                if kept {
                    s.coords.extend(p);
                    n += 1;
                }
            }
            s.meta.push(n);
            s.meta[meta_start + 1] += 1;
        }

        for seg in &segs {
            for &e in seg {
                slot_a[e as usize] = NONE;
                slot_b[e as usize] = NONE;
            }
        }
    }
}

/// Follow connected segments from `edge` (leaving segment `cur`), pushing
/// each newly reached edge onto `out`.
fn walk(
    segs: &[[u32; 2]],
    slot_a: &[u32],
    slot_b: &[u32],
    visited: &mut [bool],
    mut cur: u32,
    mut edge: u32,
    out: &mut Vec<u32>,
) {
    loop {
        let e = edge as usize;
        let next = if slot_a[e] == cur { slot_b[e] } else { slot_a[e] };
        if next == NONE || visited[next as usize] {
            return;
        }
        visited[next as usize] = true;
        let [p, q] = segs[next as usize];
        edge = if p == edge { q } else { p };
        out.push(edge);
        cur = next;
    }
}

fn edge_point(grid: &[f32], w: usize, vbase: usize, e: usize, t: f32) -> [f32; 2] {
    if e < vbase {
        let (v0, v1) = (grid[e], grid[e + 1]);
        let f = (t - v0) / (v1 - v0);
        [(e % w) as f32 + f + 0.5, (e / w) as f32 + 0.5]
    } else {
        let i = e - vbase;
        let (v0, v1) = (grid[i], grid[i + w]);
        let f = (t - v0) / (v1 - v0);
        [(i % w) as f32 + 0.5, (i / w) as f32 + f + 0.5]
    }
}

/// Ramer–Douglas–Peucker; marks surviving points in `keep`.
fn simplify(pts: &[[f32; 2]], eps: f32, keep: &mut Vec<bool>, stack: &mut Vec<(usize, usize)>) {
    let n = pts.len();
    keep.clear();
    keep.resize(n, false);
    if n == 0 {
        return;
    }
    keep[0] = true;
    keep[n - 1] = true;
    let eps2 = eps * eps;
    stack.push((0, n - 1));
    while let Some((a, b)) = stack.pop() {
        if b <= a + 1 {
            continue;
        }
        let [ax, ay] = pts[a];
        let [bx, by] = pts[b];
        let (dx, dy) = (bx - ax, by - ay);
        let len2 = dx * dx + dy * dy;
        let (mut best, mut idx) = (0.0f32, a);
        for (i, &[px, py]) in pts.iter().enumerate().take(b).skip(a + 1) {
            let d2 = if len2 > 0.0 {
                let cross = dx * (py - ay) - dy * (px - ax);
                cross * cross / len2
            } else {
                (px - ax) * (px - ax) + (py - ay) * (py - ay)
            };
            if d2 > best {
                best = d2;
                idx = i;
            }
        }
        if best > eps2 {
            keep[idx] = true;
            stack.push((a, idx));
            stack.push((idx, b));
        }
    }
}

fn downsample(src: &[f32], w0: usize, w: usize, h: usize, ds: usize) -> Vec<f32> {
    let mut out = vec![0.0; w * h];
    let norm = 1.0 / (ds * ds) as f32;
    
    #[cfg(not(target_arch = "wasm32"))]
    {
        out.par_chunks_mut(w).enumerate().for_each(|(y, row)| {
            for x in 0..w {
                let mut sum = 0.0;
                for dy in 0..ds {
                    let row_src = (y * ds + dy) * w0 + x * ds;
                    sum += src[row_src..row_src + ds].iter().sum::<f32>();
                }
                row[x] = sum * norm;
            }
        });
    }
    
    #[cfg(target_arch = "wasm32")]
    {
        for y in 0..h {
            for x in 0..w {
                let mut sum = 0.0;
                for dy in 0..ds {
                    let row = (y * ds + dy) * w0 + x * ds;
                    sum += src[row..row + ds].iter().sum::<f32>();
                }
                out[y * w + x] = sum * norm;
            }
        }
    }
    
    out
}

/// Separable 3-tap box blur, edges clamped.
fn blur(g: &mut [f32], w: usize, h: usize) {
    let mut tmp = vec![0.0; g.len()];
    
    #[cfg(not(target_arch = "wasm32"))]
    {
        // Horizontal pass
        tmp.par_chunks_mut(w).enumerate().for_each(|(y, row)| {
            let row_start = y * w;
            for x in 0..w {
                let l = g[row_start + x.saturating_sub(1)];
                let r = g[row_start + (x + 1).min(w - 1)];
                row[x] = (l + g[row_start + x] + r) / 3.0;
            }
        });
        
        // Vertical pass
        g.par_chunks_mut(w).enumerate().for_each(|(y, row)| {
            let up = y.saturating_sub(1) * w;
            let down = (y + 1).min(h - 1) * w;
            for x in 0..w {
                row[x] = (tmp[up + x] + tmp[y * w + x] + tmp[down + x]) / 3.0;
            }
        });
    }
    
    #[cfg(target_arch = "wasm32")]
    {
        // Horizontal pass
        for y in 0..h {
            let row = y * w;
            for x in 0..w {
                let l = g[row + x.saturating_sub(1)];
                let r = g[row + (x + 1).min(w - 1)];
                tmp[row + x] = (l + g[row + x] + r) / 3.0;
            }
        }
        // Vertical pass
        for y in 0..h {
            let up = y.saturating_sub(1) * w;
            let down = (y + 1).min(h - 1) * w;
            for x in 0..w {
                g[y * w + x] = (tmp[up + x] + tmp[y * w + x] + tmp[down + x]) / 3.0;
            }
        }
    }
}
