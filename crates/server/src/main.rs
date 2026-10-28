//! Topography server: serves the built site and proxies everything external
//! (elevation tiles, map tiles, place search) through a Redis cache shared by
//! every visitor, so each upstream object is fetched once, not once per client.
//!
//! Env: PORT (8080), REDIS_URL (redis://127.0.0.1:6379), STATIC_DIR (dist),
//! PORT_FILE (optional: the port actually bound is written there).
//! If PORT is taken, the next free port is used. Without Redis it still
//! works, as a plain proxy.

use std::{net::SocketAddr, sync::Arc, time::Duration};

use axum::{
    extract::{Path, Query, Request, State},
    http::{header, HeaderValue, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::get,
    Router,
};
use redis::{aio::ConnectionManager, AsyncCommands};
use serde::Deserialize;
use tokio::sync::OnceCell;
use tower_http::{compression::CompressionLayer, services::ServeDir};

const TERRAIN: &str = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium";
const VECTOR_TILEJSON: &str = "https://tiles.openfreemap.org/planet";
const PHOTON: &str = "https://photon.komoot.io/api/";
const PHOTON_REVERSE: &str = "https://photon.komoot.io/reverse";
const SEARCH_TAGS: [&str; 6] = [
    "natural:peak",
    "natural:volcano",
    "natural:mountain_range",
    "place:country",
    "place:city",
    "place:town",
];

const DAY: u64 = 86_400;
/// Redis is a cache: never let a missing or slow one hold up startup or a request.
const REDIS_CONNECT: Duration = Duration::from_secs(3);
const REDIS_OP: Duration = Duration::from_millis(500);
/// An empty GeoJSON FeatureCollection is ~44 bytes; tiles are far larger.
const EMPTY_BYTES: usize = 64;

/// How long each kind of object lives in Redis, and in browsers.
struct Policy {
    redis_ttl: u64,
    cache_control: &'static str,
    content_type: &'static str,
}

/// Elevation never changes.
const TERRAIN_POLICY: Policy = Policy {
    redis_ttl: 30 * DAY,
    cache_control: "public, max-age=31536000, immutable",
    content_type: "image/png",
};
/// OpenFreeMap publishes new map data weekly.
const VECTOR_POLICY: Policy = Policy {
    redis_ttl: 7 * DAY,
    cache_control: "public, max-age=604800",
    content_type: "application/x-protobuf",
};
const SEARCH_POLICY: Policy = Policy {
    redis_ttl: DAY,
    cache_control: "public, max-age=3600",
    content_type: "application/json",
};

/// Places don't move: a reverse lookup holds for a month.
const REVERSE_POLICY: Policy = Policy {
    redis_ttl: 30 * DAY,
    cache_control: "public, max-age=86400",
    content_type: "application/json",
};

struct App {
    http: reqwest::Client,
    redis: Option<ConnectionManager>,
    /// Versioned OpenFreeMap tile URL template, resolved once.
    vector_template: OnceCell<String>,
}

type Shared = Arc<App>;

#[tokio::main]
async fn main() {
    let port: u16 = std::env::var("PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(8080);
    let static_dir = std::env::var("STATIC_DIR").unwrap_or_else(|_| "dist".into());
    let redis_url = std::env::var("REDIS_URL").unwrap_or_else(|_| "redis://127.0.0.1:6379".into());

    // The connection manager retries forever on its own, so bound the first connect.
    let redis = match redis::Client::open(redis_url.as_str()) {
        Ok(client) => match tokio::time::timeout(REDIS_CONNECT, ConnectionManager::new(client)).await {
            Ok(Ok(manager)) => {
                println!("redis cache: {}", redis_url.split('@').last().unwrap_or_default());
                Some(manager)
            }
            Ok(Err(e)) => {
                eprintln!("redis unavailable ({e}); running without the shared cache");
                None
            }
            Err(_) => {
                eprintln!("redis did not answer in {REDIS_CONNECT:?}; running without the shared cache");
                None
            }
        },
        Err(e) => {
            eprintln!("bad REDIS_URL ({e}); running without the shared cache");
            None
        }
    };

    let app = Arc::new(App {
        http: reqwest::Client::builder()
            .timeout(Duration::from_secs(20))
            .user_agent("topography-server (contour map tile cache)")
            .build()
            .expect("http client"),
        redis,
        vector_template: OnceCell::new(),
    });

    let router = Router::new()
        .route("/tiles/terrain/{z}/{x}/{file}", get(terrain))
        .route("/tiles/vector/{z}/{x}/{file}", get(vector))
        .route("/api/search", get(search))
        .route("/api/reverse", get(reverse))
        .with_state(app)
        .fallback_service(ServeDir::new(static_dir))
        .layer(middleware::from_fn(browser_cache))
        .layer(CompressionLayer::new());

    let listener = bind(port).await;
    let port = listener.local_addr().expect("local addr").port();
    if let Ok(file) = std::env::var("PORT_FILE") {
        std::fs::write(&file, port.to_string()).expect("write PORT_FILE");
    }
    println!("topography server on http://localhost:{port}");
    axum::serve(listener, router).await.expect("serve");
}

/// Bind `port`, or the next free one after it if it's already in use.
async fn bind(port: u16) -> tokio::net::TcpListener {
    const TRIES: u16 = 20;
    for p in port..port.saturating_add(TRIES) {
        match tokio::net::TcpListener::bind(SocketAddr::from(([0, 0, 0, 0], p))).await {
            Ok(listener) => {
                if p != port {
                    eprintln!("port {port} is in use; using {p}");
                }
                return listener;
            }
            Err(e) if e.kind() == std::io::ErrorKind::AddrInUse => continue,
            Err(e) => panic!("bind {p}: {e}"),
        }
    }
    panic!("no free port in {port}..{}", port.saturating_add(TRIES));
}

// --- Routes ------------------------------------------------------------------

async fn terrain(State(app): State<Shared>, Path((z, x, file)): Path<(u32, u32, String)>) -> Response {
    let Some((z, x, y)) = tile(z, x, &file, ".png") else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    let key = format!("terrain:{z}/{x}/{y}");
    cached(&app, &key, &TERRAIN_POLICY, || async move {
        Ok(format!("{TERRAIN}/{z}/{x}/{y}.png"))
    })
    .await
}

async fn vector(State(app): State<Shared>, Path((z, x, file)): Path<(u32, u32, String)>) -> Response {
    let Some((z, x, y)) = tile(z, x, &file, ".pbf") else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    // Keyed without the data version, so a weekly release doesn't empty the cache.
    let key = format!("vector:{z}/{x}/{y}");
    let app2 = app.clone();
    cached(&app, &key, &VECTOR_POLICY, || async move {
        let template = app2
            .vector_template
            .get_or_try_init(|| async {
                #[derive(Deserialize)]
                struct TileJson {
                    tiles: Vec<String>,
                }
                let tj: TileJson = app2.http.get(VECTOR_TILEJSON).send().await?.json().await?;
                tj.tiles.into_iter().next().ok_or_else(|| BoxError::from("empty tilejson"))
            })
            .await?;
        Ok(template
            .replace("{z}", &z.to_string())
            .replace("{x}", &x.to_string())
            .replace("{y}", &y.to_string()))
    })
    .await
}

#[derive(Deserialize)]
struct SearchQuery {
    q: String,
}

async fn search(State(app): State<Shared>, Query(SearchQuery { q }): Query<SearchQuery>) -> Response {
    let q = q.trim().to_lowercase();
    if q.chars().count() < 2 || q.len() > 100 {
        return StatusCode::BAD_REQUEST.into_response();
    }
    // v2: cities and towns joined the results; older cached answers lack them.
    let key = format!("search:v2:{q}");
    cached(&app, &key, &SEARCH_POLICY, || async move {
        let mut url = reqwest::Url::parse(PHOTON)?;
        {
            let mut params = url.query_pairs_mut();
            // More than the 7 shown: the browser re-ranks across kinds, then trims.
            params.append_pair("q", &q).append_pair("limit", "10").append_pair("lang", "en");
            for tag in SEARCH_TAGS {
                params.append_pair("osm_tag", tag);
            }
        }
        Ok(url.to_string())
    })
    .await
}

#[derive(Deserialize)]
struct Point {
    lat: f64,
    lon: f64,
}

/// What is near this point? Fallback naming for views the map tiles can't name.
async fn reverse(State(app): State<Shared>, Query(Point { lat, lon }): Query<Point>) -> Response {
    if !(-90.0..=90.0).contains(&lat) || !(-180.0..=180.0).contains(&lon) {
        return StatusCode::BAD_REQUEST.into_response();
    }
    // ~1 km cells: nearby views share an answer.
    let (lat, lon) = (format!("{lat:.2}"), format!("{lon:.2}"));
    let key = format!("reverse:{lat},{lon}");
    cached(&app, &key, &REVERSE_POLICY, || async move {
        let mut url = reqwest::Url::parse(PHOTON_REVERSE)?;
        url.query_pairs_mut()
            .append_pair("lat", &lat)
            .append_pair("lon", &lon)
            .append_pair("limit", "1")
            .append_pair("lang", "en")
            // Wide, for empty land; the client names the region if it's far.
            .append_pair("radius", "500");
        Ok(url.to_string())
    })
    .await
}

/// Let browsers keep the site's own files: hashed build assets for a year,
/// pages revalidated every load (so a deploy shows at once), the rest a while.
/// Routes that set their own Cache-Control (tiles, API) keep it.
async fn browser_cache(req: Request, next: Next) -> Response {
    let path = req.uri().path().to_owned();
    let mut res = next.run(req).await;
    if !res.status().is_success() || res.headers().contains_key(header::CACHE_CONTROL) {
        return res;
    }
    let policy = if path.starts_with("/assets/") {
        "public, max-age=31536000, immutable"
    } else if path.ends_with('/') || path.ends_with(".html") {
        "no-cache"
    } else if path.starts_with("/og/")
        || path.starts_with("/prerender/")
        || path.ends_with(".png")
        || path.ends_with(".jpg")
    {
        "public, max-age=86400"
    } else {
        "public, max-age=3600"
    };
    res.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static(policy));
    res
}

// --- Cache ---------------------------------------------------------------------

type BoxError = Box<dyn std::error::Error + Send + Sync>;

/// Serve `key` from Redis, or fetch the upstream URL once and store it.
async fn cached<F, Fut>(app: &App, key: &str, policy: &Policy, upstream: F) -> Response
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = Result<String, BoxError>>,
{
    if let Some(mut redis) = app.redis.clone() {
        let get = tokio::time::timeout(REDIS_OP, redis.get::<_, Option<Vec<u8>>>(key));
        if let Ok(Ok(Some(body))) = get.await {
            return respond(body, policy, "hit");
        }
    }

    let fetched = async {
        let url = upstream().await?;
        let res = app.http.get(url).send().await?.error_for_status()?;
        Ok::<_, BoxError>(res.bytes().await?.to_vec())
    }
    .await;

    match fetched {
        Ok(body) => {
            if let Some(mut redis) = app.redis.clone() {
                // Empty answers (no search hits, nothing nearby) are cheap to
                // ask again and may change, so they only keep for a day.
                let ttl = if body.len() < EMPTY_BYTES { policy.redis_ttl.min(DAY) } else { policy.redis_ttl };
                // A failed or slow write only costs a refetch later.
                let set = redis.set_ex::<_, _, ()>(key, body.as_slice(), ttl);
                let _ = tokio::time::timeout(REDIS_OP, set).await;
            }
            respond(body, policy, "miss")
        }
        Err(e) => {
            eprintln!("upstream {key}: {e}");
            StatusCode::BAD_GATEWAY.into_response()
        }
    }
}

fn respond(body: Vec<u8>, policy: &Policy, cache: &'static str) -> Response {
    (
        [
            (header::CONTENT_TYPE, HeaderValue::from_static(policy.content_type)),
            (header::CACHE_CONTROL, HeaderValue::from_static(policy.cache_control)),
            (header::HeaderName::from_static("x-cache"), HeaderValue::from_static(cache)),
        ],
        body,
    )
        .into_response()
}

/// Validate z/x/y from a path like ".../12/659/1435.png".
fn tile(z: u32, x: u32, file: &str, ext: &str) -> Option<(u32, u32, u32)> {
    let y: u32 = file.strip_suffix(ext)?.parse().ok()?;
    let n = 1u32.checked_shl(z).filter(|_| z <= 15)?;
    (x < n && y < n).then_some((z, x, y))
}
