use rayon::prelude::*;
use std::time::Instant;

// Original serial implementation
fn downsample_serial(src: &[f32], w0: usize, w: usize, h: usize, ds: usize) -> Vec<f32> {
    let mut out = vec![0.0; w * h];
    let norm = 1.0 / (ds * ds) as f32;
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
    out
}

// Parallel implementation using rayon
fn downsample_parallel(src: &[f32], w0: usize, w: usize, h: usize, ds: usize) -> Vec<f32> {
    let mut out = vec![0.0; w * h];
    let norm = 1.0 / (ds * ds) as f32;
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
    out
}

// Original serial implementation
fn blur_serial(g: &mut [f32], w: usize, h: usize) {
    let mut tmp = vec![0.0; g.len()];
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

// Parallel implementation using rayon
fn blur_parallel(g: &mut [f32], w: usize, h: usize) {
    let mut tmp = vec![0.0; g.len()];
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

fn main() {
    // Create a synthetic elevation grid (1000x1000)
    let width = 1000;
    let height = 1000;
    let len = width * height;
    let mut input = vec![0.0f32; len as usize];
    
    // Fill the grid with synthetic data (sinusoidal pattern)
    for y in 0..height {
        for x in 0..width {
            let idx = y * width + x;
            input[idx as usize] = ((x as f32 / 100.0).sin() + (y as f32 / 100.0).cos()) * 10.0;
        }
    }
    
    // Use the results to prevent optimization
    let mut sum = 0.0;
    
    // Profile downsample_parallel
    let start = Instant::now();
    for _ in 0..10 {
        let result = downsample_parallel(&input, width, width / 4, height / 4, 4);
        sum += result[0];
    }
    let duration = start.elapsed();
    println!("downsample_parallel: {:?} (sum: {})", duration, sum);
    
    // Profile downsample_serial
    let start = Instant::now();
    for _ in 0..10 {
        let result = downsample_serial(&input, width, width / 4, height / 4, 4);
        sum += result[0];
    }
    let duration = start.elapsed();
    println!("downsample_serial: {:?} (sum: {})", duration, sum);
    
    // Profile blur_parallel
    let mut grid = input.clone();
    let start = Instant::now();
    for _ in 0..10 {
        blur_parallel(&mut grid, width, height);
        sum += grid[0];
    }
    let duration = start.elapsed();
    println!("blur_parallel: {:?} (sum: {})", duration, sum);
    
    // Profile blur_serial
    let mut grid = input.clone();
    let start = Instant::now();
    for _ in 0..10 {
        blur_serial(&mut grid, width, height);
        sum += grid[0];
    }
    let duration = start.elapsed();
    println!("blur_serial: {:?} (sum: {})", duration, sum);
}