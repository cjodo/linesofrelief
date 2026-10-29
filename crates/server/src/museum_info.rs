//! A museum's write-up, from English Wikipedia: among the articles near the
//! museum, the one whose title is its name. One query brings each nearby
//! article's distance, one-line description, opening sentences and freely
//! licensed lead photo; a second brings that photo's author and licence.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::BoxError;

const WIKI_API: &str = "https://en.wikipedia.org/w/api.php";
/// Wikimedia asks automated clients to say who they are and how to reach them.
const USER_AGENT: &str = "Topography/1.0 (https://linesofrelief.ink; museum write-ups)";
/// How far from the museum's map position an article may sit.
const RADIUS_M: u32 = 1000;
const NEARBY: u32 = 20;
const SENTENCES: u32 = 4;
const THUMB_PX: u32 = 800;

/// Words that say nothing about which museum it is.
const STOP: [&str; 20] = [
    "the", "of", "and", "a", "an", "at", "in", "on", "for", "de", "du", "la", "le", "les", "des",
    "del", "der", "die", "das", "und",
];
/// Words a lone shared token can't be: "Museum" doesn't make two places one.
const GENERIC: [&str; 10] = [
    "museum", "museums", "gallery", "house", "centre", "center", "park", "art", "history", "hall",
];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Info {
    title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    description: Option<String>,
    extract: String,
    url: String,
    /// Metres from the museum's map position.
    distance: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    photo: Option<Photo>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Photo {
    thumb: Image,
    /// Full resolution: the source for anything made from it later.
    #[serde(skip_serializing_if = "Option::is_none")]
    original: Option<Image>,
    /// Its page on Wikimedia Commons (licence, history, other sizes).
    page: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    artist: Option<String>,
    license: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    license_url: Option<String>,
}

#[derive(Deserialize, Serialize, Clone)]
pub struct Image {
    source: String,
    width: u32,
    height: u32,
}

#[derive(Deserialize)]
struct Response {
    query: Option<Pages>,
}

#[derive(Deserialize)]
struct Pages {
    pages: Vec<Page>,
}

#[derive(Deserialize)]
struct Page {
    title: String,
    description: Option<String>,
    extract: Option<String>,
    fullurl: Option<String>,
    pageimage: Option<String>,
    thumbnail: Option<Image>,
    original: Option<Image>,
    coordinates: Option<Vec<Coordinate>>,
}

#[derive(Deserialize)]
struct Coordinate {
    dist: Option<f64>,
}

/// The write-up for the museum `name` at (lat, lon), or None when no nearby
/// article is plainly about it.
pub async fn lookup(http: &reqwest::Client, name: &str, lat: f64, lon: f64) -> Result<Option<Info>, BoxError> {
    let point = format!("{lat}|{lon}");
    let mut url = reqwest::Url::parse(WIKI_API)?;
    url.query_pairs_mut()
        .append_pair("action", "query")
        .append_pair("format", "json")
        .append_pair("formatversion", "2")
        .append_pair("generator", "geosearch")
        .append_pair("ggscoord", &point)
        .append_pair("ggsradius", &RADIUS_M.to_string())
        .append_pair("ggslimit", &NEARBY.to_string())
        .append_pair("prop", "extracts|pageimages|description|info|coordinates")
        .append_pair("exintro", "1")
        .append_pair("explaintext", "1")
        .append_pair("exsentences", &SENTENCES.to_string())
        .append_pair("exlimit", &NEARBY.to_string())
        .append_pair("piprop", "thumbnail|original|name")
        .append_pair("pithumbsize", &THUMB_PX.to_string())
        // Free images only: lead images can be fair-use logos and posters.
        .append_pair("pilicense", "free")
        .append_pair("inprop", "url")
        .append_pair("colimit", &NEARBY.to_string())
        .append_pair("codistancefrompoint", &point);
    let res: Response = get(http, url).await?.json().await?;
    let pages = res.query.map(|q| q.pages).unwrap_or_default();

    let wanted = tokens(name);
    let best = pages
        .into_iter()
        .filter_map(|p| {
            let score = score(&wanted, &tokens(&p.title))?;
            let dist = p.coordinates.as_ref()?.first()?.dist?;
            Some((score, dist, p))
        })
        .max_by(|a, b| a.0.total_cmp(&b.0).then(b.1.total_cmp(&a.1)));
    let Some((_, dist, page)) = best else { return Ok(None) };
    let (Some(extract), Some(url)) = (page.extract.filter(|e| !e.trim().is_empty()), page.fullurl) else {
        return Ok(None);
    };

    // A photo without its credit can't be shown, so a failed lookup drops it.
    let photo = match (page.pageimage, page.thumbnail) {
        (Some(file), Some(thumb)) => credit(http, &file).await.ok().flatten().map(|c| Photo {
            thumb,
            original: page.original,
            page: c.page,
            artist: c.artist,
            license: c.license,
            license_url: c.license_url,
        }),
        _ => None,
    };

    Ok(Some(Info {
        title: page.title,
        description: page.description,
        extract: extract.trim().to_owned(),
        url,
        distance: dist.round() as u32,
        photo,
    }))
}

struct Credit {
    page: String,
    artist: Option<String>,
    license: String,
    license_url: Option<String>,
}

/// Who made a file, and under what licence.
async fn credit(http: &reqwest::Client, file: &str) -> Result<Option<Credit>, BoxError> {
    let mut url = reqwest::Url::parse(WIKI_API)?;
    url.query_pairs_mut()
        .append_pair("action", "query")
        .append_pair("format", "json")
        .append_pair("formatversion", "2")
        .append_pair("titles", &format!("File:{file}"))
        .append_pair("prop", "imageinfo")
        .append_pair("iiprop", "extmetadata|url")
        .append_pair("iiextmetadatafilter", "LicenseShortName|LicenseUrl|Artist");
    let res: Value = get(http, url).await?.json().await?;
    let info = &res["query"]["pages"][0]["imageinfo"][0];
    let meta = |key: &str| info["extmetadata"][key]["value"].as_str().map(plain).filter(|s| !s.is_empty());
    let (Some(license), Some(page)) = (meta("LicenseShortName"), info["descriptionurl"].as_str()) else {
        return Ok(None);
    };
    Ok(Some(Credit {
        page: page.to_owned(),
        artist: meta("Artist"),
        license,
        license_url: meta("LicenseUrl"),
    }))
}

async fn get(http: &reqwest::Client, url: reqwest::Url) -> Result<reqwest::Response, BoxError> {
    Ok(http
        .get(url)
        .header(reqwest::header::USER_AGENT, USER_AGENT)
        .send()
        .await?
        .error_for_status()?)
}

/// The words that identify a name: lowercase, without a title's
/// "(disambiguation)" and without filler words.
fn tokens(s: &str) -> Vec<String> {
    let s = s.split('(').next().unwrap_or(s).to_lowercase();
    let mut out: Vec<String> = Vec::new();
    for w in s.split(|c: char| !c.is_alphanumeric()) {
        if !w.is_empty() && !STOP.contains(&w) && !out.iter().any(|o| o == w) {
            out.push(w.to_owned());
        }
    }
    out
}

/// How plainly `title` names the museum `name`: the shorter of the two must
/// be (nearly) all in the other, by two words or one telling one.
fn score(name: &[String], title: &[String]) -> Option<f64> {
    let shared: Vec<&String> = title.iter().filter(|t| name.contains(t)).collect();
    let shortest = name.len().min(title.len());
    if shared.is_empty() || shortest == 0 {
        return None;
    }
    if shared.len() < 2 && (shortest != 1 || GENERIC.contains(&shared[0].as_str())) {
        return None;
    }
    let overlap = shared.len() as f64 / shortest as f64;
    if overlap < 0.8 {
        return None;
    }
    // Ties go to the closer match in full (Jaccard).
    let union = name.len() + title.len() - shared.len();
    Some(overlap + 0.5 * shared.len() as f64 / union as f64)
}

/// Text from a snippet of HTML (Commons credits are links).
fn plain(html: &str) -> String {
    let mut out = String::with_capacity(html.len());
    let mut in_tag = false;
    for c in html.chars() {
        match c {
            '<' => in_tag = true,
            '>' => in_tag = false,
            c if !in_tag => out.push(c),
            _ => {}
        }
    }
    let out = out
        .replace("&amp;", "&")
        .replace("&quot;", "\"")
        .replace("&#039;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&nbsp;", " ");
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn matches(name: &str, title: &str) -> bool {
        score(&tokens(name), &tokens(title)).is_some()
    }

    #[test]
    fn names_and_titles() {
        assert!(matches("Whyte Museum of the Canadian Rockies", "Whyte Museum"));
        assert!(matches("Banff Park Museum", "Banff Park Museum"));
        assert!(matches("Musée du Louvre", "Louvre"));
        assert!(matches("Natural History Museum", "Natural History Museum, London"));
        assert!(!matches("Banff Park Museum", "Banff, Alberta"));
        assert!(!matches("Luxton Home & Garden Museum", "Buffalo Nations Luxton Museum"));
        assert!(!matches("Museum", "Museum station"));
        assert!(!matches("Chelsea Space", "Chelsea Bridge"));
    }

    #[test]
    fn credits_are_plain_text() {
        assert_eq!(plain(r#"<a href="//commons.wikimedia.org/wiki/User:D" title="User:D">D &amp; E</a>"#), "D & E");
    }
}
