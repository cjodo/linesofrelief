//! Topography server: serves the built site and proxies everything external
//! (elevation tiles, map tiles, place search) through a Redis cache shared by
//! every visitor, so each upstream object is fetched once, not once per client.
//!
//! Env: PORT (8080), REDIS_URL (redis://127.0.0.1:6379), STATIC_DIR (dist).
//! Without Redis it still works, as a plain proxy.

use std::{net::SocketAddr, sync::Arc, time::Duration};

use axum::{
    extract::{Path, Query, State},
    http::{header, HeaderValue, StatusCode},
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
const SEARCH_TAGS: [&str; 4] = ["natural:peak", "natural:volcano", "natural:mountain_range", "place:country"];

const DAY: u64 = 86_400;

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

    let redis = match redis::Client::open(redis_url.as_str()) {
        Ok(client) => match ConnectionManager::new(client).await {
            Ok(manager) => Some(manager),
            Err(e) => {
                eprintln!("redis unavailable ({e}); running without the shared cache");
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
        .with_state(app)
        .fallback_service(ServeDir::new(static_dir))
        .layer(CompressionLayer::new());

    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    let listener = tokio::net::TcpListener::bind(addr).await.expect("bind");
    println!("topography server on http://localhost:{port}");
    axum::serve(listener, router).await.expect("serve");
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
    let key = format!("search:{q}");
    cached(&app, &key, &SEARCH_POLICY, || async move {
        let mut url = reqwest::Url::parse(PHOTON)?;
        {
            let mut params = url.query_pairs_mut();
            params.append_pair("q", &q).append_pair("limit", "7").append_pair("lang", "en");
            for tag in SEARCH_TAGS {
                params.append_pair("osm_tag", tag);
            }
        }
        Ok(url.to_string())
    })
    .await
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
        if let Ok(Some(body)) = redis.get::<_, Option<Vec<u8>>>(key).await {
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
                // A failed write only costs a refetch later.
                let _: Result<(), _> = redis.set_ex(key, body.as_slice(), policy.redis_ttl).await;
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
