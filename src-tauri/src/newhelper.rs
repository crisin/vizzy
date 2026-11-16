//! new-helper (the lyrics knowledge base) as an optional data source: what
//! it knows about the playing song — tags, mood, saved/favourite, lyric
//! sections with timestamps. Used as extra rule context ("tag" rules) and
//! as markers in the choreo timeline. The other way round, vizzy sends it
//! takes: what the lyrics worker heard during a song (`lyrics_take.rs`,
//! PLAN-aufnahme.md).
//!
//! Auth is a personal API token created in new-helper (Einstellungen →
//! Verbundene Apps). URL and token live in `<app_data>/newhelper.json`; the
//! token never goes to the webview. Requests run here, not in the webview,
//! so new-helper's CORS settings don't matter.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::Manager;

const FILE: &str = "newhelper.json";
const CACHE_TTL: Duration = Duration::from_secs(600);

#[derive(Serialize, Deserialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
struct Saved {
    base_url: String,
    token: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    base_url: String,
    has_token: bool,
}

pub struct NewHelper {
    path: Mutex<Option<PathBuf>>,
    saved: Mutex<Saved>,
    http: reqwest::Client,
    cache: Mutex<HashMap<String, (Instant, serde_json::Value)>>,
}

pub type Shared = Arc<NewHelper>;

pub fn new() -> Shared {
    Arc::new(NewHelper {
        path: Mutex::new(None),
        saved: Mutex::new(Saved::default()),
        http: reqwest::Client::builder()
            .timeout(Duration::from_secs(8))
            .build()
            .expect("http client"),
        cache: Mutex::new(HashMap::new()),
    })
}

pub fn load(app: &tauri::AppHandle, nh: &Shared) {
    let Ok(dir) = app.path().app_data_dir() else { return };
    let path = dir.join(FILE);
    if let Ok(s) = std::fs::read_to_string(&path) {
        if let Ok(saved) = serde_json::from_str::<Saved>(&s) {
            *nh.saved.lock().unwrap() = saved;
        }
    }
    *nh.path.lock().unwrap() = Some(path);
}

impl NewHelper {
    fn save(&self) {
        let Some(path) = self.path.lock().unwrap().clone() else { return };
        let json = serde_json::to_string_pretty(&*self.saved.lock().unwrap()).unwrap_or_default();
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let tmp = path.with_extension("tmp");
        if std::fs::write(&tmp, json).is_ok() {
            let _ = std::fs::rename(&tmp, &path);
        }
    }

    fn status(&self) -> Status {
        let s = self.saved.lock().unwrap();
        Status { base_url: s.base_url.clone(), has_token: !s.token.is_empty() }
    }

    async fn get(&self, path: &str, query: &[(&str, &str)]) -> Result<serde_json::Value, String> {
        let (base, token) = {
            let s = self.saved.lock().unwrap();
            (s.base_url.trim_end_matches('/').to_string(), s.token.clone())
        };
        if base.is_empty() || token.is_empty() {
            return Err("new-helper ist nicht eingerichtet".into());
        }
        let mut url = url::Url::parse(&format!("{base}{path}")).map_err(|e| format!("URL ungültig: {e}"))?;
        url.query_pairs_mut().extend_pairs(query.iter().filter(|(_, v)| !v.is_empty()));
        let res = self
            .http
            .get(url)
            .bearer_auth(token)
            .send()
            .await
            .map_err(|e| format!("new-helper nicht erreichbar: {e}"))?;
        match res.status().as_u16() {
            200 => res.json().await.map_err(|e| e.to_string()),
            401 => Err("Token ungültig oder widerrufen".into()),
            404 => Err("Diese new-helper-Version kennt die vizzy-Schnittstelle noch nicht".into()),
            s => Err(format!("new-helper antwortet {s}")),
        }
    }
}

impl NewHelper {
    async fn post(&self, path: &str, body: &serde_json::Value) -> Result<serde_json::Value, String> {
        let (base, token) = {
            let s = self.saved.lock().unwrap();
            (s.base_url.trim_end_matches('/').to_string(), s.token.clone())
        };
        if base.is_empty() || token.is_empty() {
            return Err("new-helper ist nicht eingerichtet".into());
        }
        let url = url::Url::parse(&format!("{base}{path}")).map_err(|e| format!("URL ungültig: {e}"))?;
        let res = self
            .http
            .post(url)
            .bearer_auth(token)
            .json(body)
            .send()
            .await
            .map_err(|e| format!("new-helper nicht erreichbar: {e}"))?;
        match res.status().as_u16() {
            200 | 201 => res.json().await.map_err(|e| e.to_string()),
            400 => {
                // Nest says what it did not like: { message: string | string[] }
                let v: serde_json::Value = res.json().await.unwrap_or_default();
                let why = match &v["message"] {
                    serde_json::Value::Array(a) => a.iter().filter_map(|m| m.as_str()).take(3).collect::<Vec<_>>().join("; "),
                    m => m.as_str().unwrap_or("").to_string(),
                };
                Err(format!("Lyrics Helper lehnt die Aufnahme ab: {why}"))
            }
            401 => Err("Token ungültig oder widerrufen".into()),
            404 => Err("Diese Lyrics-Helper-Version nimmt noch keine Aufnahmen an".into()),
            413 => Err("Die Aufnahme ist zu groß".into()),
            s => Err(format!("new-helper antwortet {s}")),
        }
    }
}

/// most lines Lyrics Helper takes in one take
const TAKE_MAX_LINES: usize = 500;

/// A take file as Lyrics Helper wants it: with a Spotify id, without our
/// own bookkeeping.
fn take_body(mut take: serde_json::Value) -> Result<serde_json::Value, String> {
    if take["spotifyId"].as_str().is_none_or(|s| s.is_empty()) {
        return Err("Ohne Spotify-ID kann Lyrics Helper die Aufnahme keinem Song zuordnen".into());
    }
    let lines = take["lines"].as_array().map_or(0, |a| a.len());
    if lines == 0 {
        return Err("Die Aufnahme hat keine Zeilen".into());
    }
    if lines > TAKE_MAX_LINES {
        return Err(format!("Die Aufnahme hat {lines} Zeilen, Lyrics Helper nimmt höchstens {TAKE_MAX_LINES}"));
    }
    if let Some(o) = take.as_object_mut() {
        o.remove("uploaded");
    }
    Ok(take)
}

/// Sends one take (`lyrics-takes/<file>.json`) to Lyrics Helper and notes
/// in the file that, and when, it went up. Returns that note.
#[tauri::command]
pub async fn newhelper_upload_take(
    name: String,
    app: tauri::AppHandle,
    nh: tauri::State<'_, Shared>,
) -> Result<serde_json::Value, String> {
    let file = name
        .strip_prefix(&format!("{}/", crate::lyrics_take::DIR))
        .filter(|f| !f.is_empty() && f.ends_with(".json") && !f.contains(['/', '\\', ':']) && !f.contains(".."))
        .ok_or("keine Aufnahme-Datei")?;
    let path = app.path().app_data_dir().map_err(|e| e.to_string())?.join(crate::lyrics_take::DIR).join(file);
    let text = std::fs::read_to_string(&path).map_err(|e| format!("{}: {e}", path.display()))?;
    let mut take: serde_json::Value = serde_json::from_str(&text).map_err(|e| format!("Aufnahme nicht lesbar: {e}"))?;
    let body = take_body(take.clone())?;
    let nh = nh.inner().clone();
    nh.post("/integrations/vizzy/takes", &body).await?;
    // the song has a take now; ask again rather than trust the cache
    nh.cache.lock().unwrap().clear();
    let note = serde_json::json!({
        "at": crate::lyrics_log::iso(crate::lyrics_log::now_ms()),
        "lines": body["lines"].as_array().map_or(0, |a| a.len()),
    });
    take["uploaded"] = note.clone();
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, serde_json::to_string_pretty(&take).unwrap_or_default())
        .and_then(|_| std::fs::rename(&tmp, &path))
        .map_err(|e| format!("hochgeladen, aber nicht vermerkt: {e}"))?;
    Ok(note)
}

#[tauri::command]
pub fn newhelper_status(nh: tauri::State<'_, Shared>) -> Status {
    nh.status()
}

/// `token: None` keeps the stored one (changing only the URL).
#[tauri::command]
pub fn newhelper_configure(base_url: String, token: Option<String>, nh: tauri::State<'_, Shared>) -> Status {
    {
        let mut s = nh.saved.lock().unwrap();
        s.base_url = base_url.trim().to_string();
        if let Some(t) = token {
            s.token = t.trim().to_string();
        }
    }
    nh.cache.lock().unwrap().clear();
    nh.save();
    nh.status()
}

#[tauri::command]
pub async fn newhelper_test(nh: tauri::State<'_, Shared>) -> Result<(), String> {
    let nh = nh.inner().clone();
    nh.get("/integrations/vizzy/ping", &[]).await.map(|_| ())
}

/// What new-helper knows about a song (cached for 10 minutes).
#[tauri::command]
pub async fn newhelper_song(
    spotify_id: Option<String>,
    title: String,
    artist: String,
    nh: tauri::State<'_, Shared>,
) -> Result<serde_json::Value, String> {
    let nh = nh.inner().clone();
    let sid = spotify_id.unwrap_or_default();
    let key = format!("{sid}|{title}|{artist}");
    if let Some((at, v)) = nh.cache.lock().unwrap().get(&key) {
        if at.elapsed() < CACHE_TTL {
            return Ok(v.clone());
        }
    }
    let v = nh
        .get(
            "/integrations/vizzy/song",
            &[("spotifyId", sid.as_str()), ("title", title.as_str()), ("artist", artist.as_str())],
        )
        .await?;
    nh.cache.lock().unwrap().insert(key, (Instant::now(), v.clone()));
    Ok(v)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};

    /// One-shot HTTP stand-in: answers `status` + `body`, hands back the request.
    fn serve_once(status: &'static str, body: &'static str) -> (String, std::thread::JoinHandle<String>) {
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = format!("http://{}", l.local_addr().unwrap());
        let h = std::thread::spawn(move || {
            let (mut s, _) = l.accept().unwrap();
            let mut buf = [0u8; 4096];
            let n = s.read(&mut buf).unwrap();
            let req = String::from_utf8_lossy(&buf[..n]).to_string();
            write!(
                s,
                "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            )
            .unwrap();
            req
        });
        (addr, h)
    }

    fn client(base: &str, token: &str) -> Shared {
        let nh = new();
        *nh.saved.lock().unwrap() = Saved { base_url: format!("{base}/"), token: token.into() };
        nh
    }

    #[tokio::test]
    async fn sends_token_and_query_and_returns_the_json() {
        let (base, h) = serve_once("200 OK", r#"{"found":true,"tags":[{"tag":"party","type":"CONTEXT"}]}"#);
        let nh = client(&base, "nh_test");
        let v = nh
            .get("/integrations/vizzy/song", &[("spotifyId", ""), ("title", "Kokain"), ("artist", "Bonez MC")])
            .await
            .unwrap();
        assert_eq!(v["tags"][0]["tag"], "party");
        let req = h.join().unwrap();
        assert!(req.starts_with("GET /integrations/vizzy/song?title=Kokain&artist=Bonez+MC "), "{req}");
        assert!(req.to_lowercase().contains("authorization: bearer nh_test"));
    }

    #[tokio::test]
    async fn explains_a_bad_token() {
        let (base, h) = serve_once("401 Unauthorized", "{}");
        let err = client(&base, "nh_bad").get("/integrations/vizzy/ping", &[]).await.unwrap_err();
        h.join().unwrap();
        assert!(err.contains("Token"), "{err}");
    }

    #[tokio::test]
    async fn posts_a_take_and_passes_on_why_it_was_refused() {
        let take = serde_json::json!({
            "v": 1, "spotifyId": "sp1", "title": "Song", "uploaded": { "at": "x", "lines": 1 },
            "lines": [{ "text": "la", "startMs": 0, "endMs": 900, "repeat": false }],
        });
        let body = take_body(take.clone()).unwrap();
        assert!(body.get("uploaded").is_none(), "our own note stays here");

        let (base, h) = serve_once("201 Created", r#"{"id":"t1","created":true,"lines":1}"#);
        let v = client(&base, "nh_test").post("/integrations/vizzy/takes", &body).await.unwrap();
        assert_eq!(v["created"], true);
        let req = h.join().unwrap();
        assert!(req.starts_with("POST /integrations/vizzy/takes "), "{req}");
        assert!(req.to_lowercase().contains("authorization: bearer nh_test"));

        let (base, h) = serve_once("400 Bad Request", r#"{"message":["clock must be one of: media, songchange"]}"#);
        let err = client(&base, "nh_test").post("/integrations/vizzy/takes", &body).await.unwrap_err();
        h.join().unwrap();
        assert!(err.contains("lehnt die Aufnahme ab: clock must be"), "{err}");

        // an older Lyrics Helper without the endpoint
        let (base, h) = serve_once("404 Not Found", "{}");
        let err = client(&base, "nh_test").post("/integrations/vizzy/takes", &body).await.unwrap_err();
        h.join().unwrap();
        assert!(err.contains("noch keine Aufnahmen"), "{err}");
    }

    #[test]
    fn a_take_needs_a_spotify_id_and_a_sane_size() {
        let line = serde_json::json!({ "text": "la", "startMs": 0, "endMs": 1, "repeat": false });
        let no_id = serde_json::json!({ "spotifyId": null, "lines": [line] });
        assert!(take_body(no_id).unwrap_err().contains("Spotify-ID"));
        let empty = serde_json::json!({ "spotifyId": "sp1", "lines": [] });
        assert!(take_body(empty).unwrap_err().contains("keine Zeilen"));
        let huge = serde_json::json!({ "spotifyId": "sp1", "lines": vec![line; 501] });
        assert!(take_body(huge).unwrap_err().contains("501 Zeilen"));
    }

    #[tokio::test]
    async fn refuses_without_configuration() {
        let err = new().get("/integrations/vizzy/ping", &[]).await.unwrap_err();
        assert!(err.contains("nicht eingerichtet"));
    }
}
