use criterion::{criterion_group, criterion_main, Criterion};
use rayon::prelude::*;
use serde_json::{Map, Value};

// Mock Point struct
#[derive(Debug, Clone)]
struct Point {
    properties: Map<String, Value>,
    x: i64,
    y: i64,
}

// Mock Layer struct
struct Layer {
    extent: u32,
    points: Vec<Point>,
}

// Mock MVT tile with museums
fn mock_mvt_tile() -> Layer {
    // Create a layer with 1000 mock museums
    let mut points = Vec::with_capacity(1000);
    for i in 0..1000 {
        let mut properties = Map::new();
        properties.insert("class".into(), "museum".into());
        properties.insert("name".into(), format!("Museum {}", i).into());
        points.push(Point {
            properties,
            x: (i % 100) as i64,
            y: (i / 100) as i64,
        });
    }
    Layer {
        extent: 4096,
        points,
    }
}

fn benchmark_museums_in(c: &mut Criterion) {
    let layer = mock_mvt_tile();
    
    // Benchmark serial processing
    c.bench_function("museums_in_serial", |b| {
        b.iter(|| {
            let mut out = Vec::new();
            for p in &layer.points {
                let mut museum = p.properties.clone();
                museum.insert("lat".into(), 0.0.into());
                museum.insert("lon".into(), 0.0.into());
                out.push(serde_json::Value::Object(museum));
            }
        });
    });
    
    // Benchmark parallel processing
    c.bench_function("museums_in_parallel", |b| {
        b.iter(|| {
            let mut out: Vec<serde_json::Value> = layer.points.par_iter()
                .map(|p| {
                    let mut museum = p.properties.clone();
                    museum.insert("lat".into(), 0.0.into());
                    museum.insert("lon".into(), 0.0.into());
                    serde_json::Value::Object(museum)
                })
                .collect();
        });
    });
}

criterion_group!(benches, benchmark_museums_in);
criterion_main!(benches);