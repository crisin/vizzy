//! Spotify Web API — the second now-playing source next to the OS media
//! session (`nowplaying.rs`). It adds what the media session can't tell:
//! a stable track id and the context (which playlist / album it plays from).
//!
//! Auth: Authorization Code + PKCE, no client secret — the user registers
//! their own Spotify app and enters its client id. The redirect goes to a
//! one-shot listener on 127.0.0.1 (Spotify rejects `localhost`).
//! Tokens live in `<app_data>/spotify.json` and never reach the webview.
//!
//! Token handling follows new-helper's backend: refresh 60 s early, one
//! refresh at a time, keep a rotated refresh token, drop the tokens only on
//! `invalid_grant`. Polling: no push from Spotify, so 4 s while playing,
//! 15 s idle, honour Retry-After; the frontend wakes the poller early when
//! the media session reports a new song.
//!
//! Emits `spotify` (`SpotifyNow | null`) on change and `spotify-status`.

use base64::Engine;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager};

pub const REDIRECT_PORT: u16 = 43821;
pub const REDIRECT_URI: &str = "http://127.0.0.1:43821/callback";
/// playlist-read-* so private playlist names resolve, and so the rule editor
/// can list your playlists later without a second consent
const SCOPES: &str = "user-read-currently-playing user-read-playback-state playlist-read-private playlist-read-collaborative";
const FILE: &str = "spotify.json";
const API: &str = "https://api.spotify.com/v1";
const TOKEN_URL: &str = "https://accounts.spotify.com/api/token";

#[derive(Serialize, Deserialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
struct Saved {
    client_id: String,
    refresh_token: Option<String>,
    access_token: Option<String>,
    /// unix ms
    expires_at: f64,
    user: Option<String>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Context {
    /// "playlist" | "album" | "artist" | "collection" | "show" | …
    pub kind: String,
    pub uri: String,
    pub name: Option<String>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SpotifyNow {
    pub track_id: String,
    pub uri: String,
    pub title: String,
    pub artists: Vec<String>,
    pub album: String,
    pub duration_ms: f64,
    pub progress_ms: f64,
    pub is_playing: bool,
    /// unix ms `progress_ms` was valid at
    pub sampled_at: f64,
    pub context: Option<Context>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    client_id: String,
    connected: bool,
    connecting: bool,
    user: Option<String>,
    redirect_uri: &'static str,
    error: Option<String>,
}

pub struct Spotify {
    path: Mutex<Option<PathBuf>>,
    saved: Mutex<Saved>,
    http: reqwest::Client,
    refreshing: tokio::sync::Mutex<()>,
    wake: tokio::sync::Notify,
    last: Mutex<Option<SpotifyNow>>,
    names: Mutex<HashMap<String, Option<String>>>,
    connecting: AtomicBool,
    cancel: AtomicBool,
    error: Mutex<Option<String>>,
}

pub type Shared = Arc<Spotify>;

pub fn new() -> Shared {
    Arc::new(Spotify {
        path: Mutex::new(None),
        saved: Mutex::new(Saved::default()),
        http: reqwest::Client::builder()
            .timeout(Duration::from_secs(10))
            .build()
            .expect("http client"),
        refreshing: tokio::sync::Mutex::new(()),
        wake: tokio::sync::Notify::new(),
        last: Mutex::new(None),
        names: Mutex::new(HashMap::new()),
        connecting: AtomicBool::new(false),
        cancel: AtomicBool::new(false),
        error: Mutex::new(None),
    })
}

enum Fail {
    /// no tokens / refresh token revoked — needs the user
    Disconnected,
    /// 429, seconds to wait
    Rate(u64),
    Other(String),
}

impl From<reqwest::Error> for Fail {
    fn from(e: reqwest::Error) -> Self {
        Fail::Other(e.to_string())
    }
}

fn now_ms() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs_f64() * 1000.0)
        .unwrap_or(0.0)
}

fn b64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

fn random_token(n: usize) -> String {
    let mut buf = vec![0u8; n];
    getrandom::fill(&mut buf).expect("os random");
    b64(&buf)
}

fn challenge(verifier: &str) -> String {
    use sha2::Digest;
    b64(&sha2::Sha256::digest(verifier.as_bytes()))
}

impl Spotify {
    fn load(&self, app: &tauri::AppHandle) {
        let Ok(dir) = app.path().app_data_dir() else { return };
        let path = dir.join(FILE);
        if let Ok(s) = std::fs::read_to_string(&path) {
            if let Ok(saved) = serde_json::from_str::<Saved>(&s) {
                *self.saved.lock().unwrap() = saved;
            }
        }
        *self.path.lock().unwrap() = Some(path);
    }

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
        Status {
            client_id: s.client_id.clone(),
            connected: s.refresh_token.is_some(),
            connecting: self.connecting.load(Ordering::SeqCst),
            user: s.user.clone(),
            redirect_uri: REDIRECT_URI,
            error: self.error.lock().unwrap().clone(),
        }
    }

    fn set_error(&self, e: Option<String>) {
        *self.error.lock().unwrap() = e;
    }

    fn emit_status(&self, app: &tauri::AppHandle) {
        let _ = app.emit("spotify-status", self.status());
    }

    fn drop_tokens(&self) {
        let mut s = self.saved.lock().unwrap();
        s.refresh_token = None;
        s.access_token = None;
        s.expires_at = 0.0;
        drop(s);
        self.save();
    }

    /// Stores a token response; keeps the old refresh token unless Spotify
    /// rotated it.
    fn store_tokens(&self, t: &TokenResponse) {
        let mut s = self.saved.lock().unwrap();
        s.access_token = Some(t.access_token.clone());
        s.expires_at = now_ms() + t.expires_in as f64 * 1000.0;
        if let Some(r) = &t.refresh_token {
            s.refresh_token = Some(r.clone());
        }
        drop(s);
        self.save();
    }

    async fn token(&self) -> Result<String, Fail> {
        let valid = |s: &Saved| {
            s.access_token
                .clone()
                .filter(|_| s.expires_at - 60_000.0 > now_ms())
        };
        if let Some(t) = valid(&self.saved.lock().unwrap()) {
            return Ok(t);
        }
        let _guard = self.refreshing.lock().await;
        // somebody else may have refreshed while we waited
        let (client_id, refresh) = {
            let s = self.saved.lock().unwrap();
            if let Some(t) = valid(&s) {
                return Ok(t);
            }
            (s.client_id.clone(), s.refresh_token.clone())
        };
        let Some(refresh) = refresh else { return Err(Fail::Disconnected) };
        let res = self
            .http
            .post(TOKEN_URL)
            .form(&[
                ("grant_type", "refresh_token"),
                ("refresh_token", refresh.as_str()),
                ("client_id", client_id.as_str()),
            ])
            .send()
            .await?;
        let status = res.status();
        if status.is_success() {
            let t: TokenResponse = res.json().await?;
            self.store_tokens(&t);
            return Ok(t.access_token);
        }
        let body = res.text().await.unwrap_or_default();
        if status.as_u16() == 400 && body.contains("invalid_grant") {
            eprintln!("[vizzy-spotify] refresh token revoked — reconnect needed");
            self.drop_tokens();
            self.set_error(Some("Spotify-Zugang abgelaufen – bitte neu verbinden".into()));
            return Err(Fail::Disconnected);
        }
        // 429 / 5xx / anything else: temporary, keep the tokens
        Err(Fail::Other(format!("token refresh {status}: {body}")))
    }

    /// GET with one retry on 401 (token revoked early).
    async fn get(&self, url: &str) -> Result<Option<serde_json::Value>, Fail> {
        for attempt in 0..2 {
            let token = self.token().await?;
            let res = self.http.get(url).bearer_auth(&token).send().await?;
            match res.status().as_u16() {
                200 => return Ok(Some(res.json().await?)),
                204 => return Ok(None),
                401 if attempt == 0 => {
                    self.saved.lock().unwrap().expires_at = 0.0;
                    continue;
                }
                429 => {
                    let wait = res
                        .headers()
                        .get("retry-after")
                        .and_then(|v| v.to_str().ok())
                        .and_then(|v| v.parse::<u64>().ok())
                        .unwrap_or(30);
                    return Err(Fail::Rate(wait.max(1)));
                }
                s => {
                    let body = res.text().await.unwrap_or_default();
                    return Err(Fail::Other(format!("GET {url} → {s}: {body}")));
                }
            }
        }
        Err(Fail::Other("unauthorized".into()))
    }

    async fn context_name(&self, kind: &str, uri: &str) -> Option<String> {
        if let Some(n) = self.names.lock().unwrap().get(uri) {
            return n.clone();
        }
        let id = uri.rsplit(':').next().unwrap_or_default();
        let name = match kind {
            "playlist" => self
                .get(&format!("{API}/playlists/{id}?fields=name"))
                .await
                .ok()
                .flatten()
                .and_then(|v| v["name"].as_str().map(String::from)),
            "collection" => Some("Lieblingssongs".into()),
            _ => None,
        };
        // also cache misses (a playlist we may not read) — no re-asking every poll
        self.names.lock().unwrap().insert(uri.to_string(), name.clone());
        name
    }

    async fn fetch_now(&self) -> Result<Option<SpotifyNow>, Fail> {
        let Some(v) = self.get(&format!("{API}/me/player/currently-playing")).await? else {
            return Ok(None);
        };
        let item = &v["item"];
        // podcasts, ads, local files without id: nothing we can identify
        let Some(track_id) = item["id"].as_str() else { return Ok(None) };
        let context = match (v["context"]["type"].as_str(), v["context"]["uri"].as_str()) {
            (Some(kind), Some(uri)) => {
                // Liked Songs come as `spotify:user:<id>:collection`
                let kind = if uri.ends_with(":collection") { "collection" } else { kind };
                Some(Context {
                    kind: kind.to_string(),
                    uri: uri.to_string(),
                    name: if kind == "album" {
                        item["album"]["name"].as_str().map(String::from)
                    } else {
                        self.context_name(kind, uri).await
                    },
                })
            }
            _ => None,
        };
        Ok(Some(SpotifyNow {
            track_id: track_id.to_string(),
            uri: item["uri"].as_str().unwrap_or_default().to_string(),
            title: item["name"].as_str().unwrap_or_default().to_string(),
            artists: item["artists"]
                .as_array()
                .map(|a| a.iter().filter_map(|x| x["name"].as_str().map(String::from)).collect())
                .unwrap_or_default(),
            album: item["album"]["name"].as_str().unwrap_or_default().to_string(),
            duration_ms: item["duration_ms"].as_f64().unwrap_or(0.0),
            progress_ms: v["progress_ms"].as_f64().unwrap_or(0.0),
            is_playing: v["is_playing"].as_bool().unwrap_or(false),
            sampled_at: now_ms(),
            context,
        }))
    }
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    expires_in: u64,
    refresh_token: Option<String>,
}

/// True when `next` is worth telling the frontend about.
fn changed(prev: &Option<SpotifyNow>, next: &Option<SpotifyNow>) -> bool {
    match (prev, next) {
        (None, None) => false,
        (Some(a), Some(b)) => {
            if a.track_id != b.track_id || a.is_playing != b.is_playing || a.context != b.context {
                return true;
            }
            let expect = if a.is_playing {
                a.progress_ms + (b.sampled_at - a.sampled_at)
            } else {
                a.progress_ms
            };
            (b.progress_ms - expect).abs() > 2000.0
        }
        _ => true,
    }
}

/// Load saved tokens and start the poller.
pub fn spawn(app: tauri::AppHandle, sp: Shared) {
    sp.load(&app);
    tauri::async_runtime::spawn(async move {
        loop {
            let connected = sp.saved.lock().unwrap().refresh_token.is_some();
            if !connected {
                let _ = tokio::time::timeout(Duration::from_secs(30), sp.wake.notified()).await;
                continue;
            }
            let wait = match sp.fetch_now().await {
                Ok(next) => {
                    let mut last = sp.last.lock().unwrap();
                    if changed(&last, &next) {
                        if let Some(n) = &next {
                            if last.as_ref().map(|l| &l.track_id) != Some(&n.track_id) {
                                eprintln!(
                                    "[vizzy-spotify] {} — {} [{}]{}",
                                    n.artists.join(", "),
                                    n.title,
                                    if n.is_playing { "playing" } else { "paused" },
                                    n.context
                                        .as_ref()
                                        .map(|c| format!(" aus {} {}", c.kind, c.name.clone().unwrap_or_default()))
                                        .unwrap_or_default()
                                );
                            }
                        }
                        let _ = app.emit("spotify", &next);
                    }
                    let playing = next.as_ref().map(|n| n.is_playing).unwrap_or(false);
                    *last = next;
                    drop(last);
                    if sp.error.lock().unwrap().take().is_some() {
                        sp.emit_status(&app);
                    }
                    if playing { 4 } else { 15 }
                }
                Err(Fail::Rate(s)) => {
                    eprintln!("[vizzy-spotify] rate limited, waiting {s}s");
                    s
                }
                Err(Fail::Disconnected) => {
                    *sp.last.lock().unwrap() = None;
                    let _ = app.emit("spotify", Option::<SpotifyNow>::None);
                    sp.emit_status(&app);
                    continue;
                }
                Err(Fail::Other(e)) => {
                    eprintln!("[vizzy-spotify] {e}");
                    15
                }
            };
            let _ = tokio::time::timeout(Duration::from_secs(wait), sp.wake.notified()).await;
        }
    });
}

// ---------------------------------------------------------------- commands

#[tauri::command]
pub fn spotify_status(sp: tauri::State<'_, Shared>) -> Status {
    sp.status()
}

#[tauri::command]
pub fn spotify_now(sp: tauri::State<'_, Shared>) -> Option<SpotifyNow> {
    sp.last.lock().unwrap().clone()
}

#[tauri::command]
pub fn spotify_set_client_id(
    client_id: String,
    app: tauri::AppHandle,
    sp: tauri::State<'_, Shared>,
) -> Status {
    let id = client_id.trim().to_string();
    let mut s = sp.saved.lock().unwrap();
    if s.client_id != id {
        // tokens belong to the old app
        *s = Saved { client_id: id, ..Saved::default() };
        drop(s);
        sp.save();
    } else {
        drop(s);
    }
    sp.emit_status(&app);
    sp.status()
}

/// The media session saw a new song — ask Spotify now instead of in 4–15 s.
#[tauri::command]
pub fn spotify_poll_now(sp: tauri::State<'_, Shared>) {
    sp.wake.notify_one();
}

#[tauri::command]
pub fn spotify_disconnect(app: tauri::AppHandle, sp: tauri::State<'_, Shared>) -> Status {
    sp.drop_tokens();
    sp.saved.lock().unwrap().user = None;
    sp.save();
    *sp.last.lock().unwrap() = None;
    let _ = app.emit("spotify", Option::<SpotifyNow>::None);
    sp.emit_status(&app);
    sp.status()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaylistInfo {
    uri: String,
    name: String,
    owner: String,
}

/// Your playlists (owned + followed), for picking one in the rule editor.
#[tauri::command]
pub async fn spotify_playlists(sp: tauri::State<'_, Shared>) -> Result<Vec<PlaylistInfo>, String> {
    let sp = sp.inner().clone();
    let mut out = Vec::new();
    let mut url = Some(format!("{API}/me/playlists?limit=50"));
    // 10 pages = 500 playlists is plenty for a picker
    for _ in 0..10 {
        let Some(u) = url.take() else { break };
        let v = match sp.get(&u).await {
            Ok(Some(v)) => v,
            Ok(None) => break,
            Err(Fail::Disconnected) => return Err("Spotify nicht verbunden".into()),
            Err(Fail::Rate(s)) => return Err(format!("Spotify-Limit, in {s} s nochmal")),
            Err(Fail::Other(e)) => return Err(e),
        };
        for p in v["items"].as_array().into_iter().flatten() {
            let (Some(uri), Some(name)) = (p["uri"].as_str(), p["name"].as_str()) else { continue };
            sp.names.lock().unwrap().insert(uri.to_string(), Some(name.to_string()));
            out.push(PlaylistInfo {
                uri: uri.to_string(),
                name: name.to_string(),
                owner: p["owner"]["display_name"].as_str().unwrap_or_default().to_string(),
            });
        }
        url = v["next"].as_str().map(String::from);
    }
    Ok(out)
}

#[tauri::command]
pub fn spotify_cancel_connect(sp: tauri::State<'_, Shared>) {
    sp.cancel.store(true, Ordering::SeqCst);
}

/// Opens the consent page in the browser and waits (up to 3 min) for the
/// redirect to our loopback listener.
#[tauri::command]
pub async fn spotify_connect(app: tauri::AppHandle, sp: tauri::State<'_, Shared>) -> Result<Status, String> {
    let sp = sp.inner().clone();
    let client_id = sp.saved.lock().unwrap().client_id.clone();
    if client_id.is_empty() {
        return Err("Erst die Client-ID deiner Spotify-App eintragen.".into());
    }
    if sp.connecting.swap(true, Ordering::SeqCst) {
        return Err("Verbindung läuft bereits – im Browser bestätigen.".into());
    }
    sp.cancel.store(false, Ordering::SeqCst);
    sp.set_error(None);
    sp.emit_status(&app);
    let result = connect_flow(&app, &sp, &client_id).await;
    sp.connecting.store(false, Ordering::SeqCst);
    if let Err(e) = &result {
        eprintln!("[vizzy-spotify] connect failed: {e}");
        sp.set_error(Some(e.clone()));
    }
    sp.emit_status(&app);
    result.map(|_| sp.status())
}

async fn connect_flow(app: &tauri::AppHandle, sp: &Shared, client_id: &str) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;

    let verifier = random_token(48);
    let state = random_token(16);
    let listener = std::net::TcpListener::bind(("127.0.0.1", REDIRECT_PORT))
        .map_err(|e| format!("Port {REDIRECT_PORT} ist belegt ({e})"))?;
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;

    let mut auth = url::Url::parse("https://accounts.spotify.com/authorize").unwrap();
    auth.query_pairs_mut()
        .append_pair("client_id", client_id)
        .append_pair("response_type", "code")
        .append_pair("redirect_uri", REDIRECT_URI)
        .append_pair("code_challenge_method", "S256")
        .append_pair("code_challenge", &challenge(&verifier))
        .append_pair("scope", SCOPES)
        .append_pair("state", &state);
    app.opener()
        .open_url(auth.as_str(), None::<&str>)
        .map_err(|e| format!("Browser ließ sich nicht öffnen: {e}"))?;

    let sp2 = sp.clone();
    let code = tauri::async_runtime::spawn_blocking(move || wait_for_callback(listener, &state, &sp2))
        .await
        .map_err(|e| e.to_string())??;

    let res = sp
        .http
        .post(TOKEN_URL)
        .form(&[
            ("grant_type", "authorization_code"),
            ("code", code.as_str()),
            ("redirect_uri", REDIRECT_URI),
            ("client_id", client_id),
            ("code_verifier", verifier.as_str()),
        ])
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        let s = res.status();
        return Err(format!("Token-Tausch fehlgeschlagen ({s}): {}", res.text().await.unwrap_or_default()));
    }
    let t: TokenResponse = res.json().await.map_err(|e| e.to_string())?;
    if t.refresh_token.is_none() {
        return Err("Spotify hat keinen Refresh-Token geliefert".into());
    }
    sp.store_tokens(&t);
    let user = sp
        .get(&format!("{API}/me"))
        .await
        .ok()
        .flatten()
        .and_then(|v| v["display_name"].as_str().or(v["id"].as_str()).map(String::from));
    eprintln!("[vizzy-spotify] connected as {user:?}");
    sp.saved.lock().unwrap().user = user;
    sp.save();
    sp.wake.notify_one();
    Ok(())
}

const PAGE_OK: &str = "<!doctype html><meta charset=utf-8><title>vizzy</title><body style=\"font:16px system-ui;background:#0b0d14;color:#e2e8f0;display:grid;place-items:center;height:90vh\"><div><h2>vizzy ist mit Spotify verbunden</h2><p>Du kannst dieses Fenster schließen.</p></div>";

fn respond(stream: &mut std::net::TcpStream, code: &str, body: &str) {
    use std::io::Write;
    let _ = write!(
        stream,
        "HTTP/1.1 {code}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
}

fn wait_for_callback(listener: std::net::TcpListener, state: &str, sp: &Shared) -> Result<String, String> {
    use std::io::Read;
    let deadline = Instant::now() + Duration::from_secs(180);
    loop {
        if sp.cancel.load(Ordering::SeqCst) {
            return Err("abgebrochen".into());
        }
        if Instant::now() > deadline {
            return Err("Zeit abgelaufen – keine Bestätigung im Browser".into());
        }
        let (mut stream, _) = match listener.accept() {
            Ok(c) => c,
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(100));
                continue;
            }
            Err(e) => return Err(e.to_string()),
        };
        let _ = stream.set_nonblocking(false);
        let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
        let mut buf = [0u8; 4096];
        let n = stream.read(&mut buf).unwrap_or(0);
        let req = String::from_utf8_lossy(&buf[..n]);
        let path = req.split_whitespace().nth(1).unwrap_or("/");
        let Ok(url) = url::Url::parse(&format!("http://127.0.0.1{path}")) else {
            respond(&mut stream, "400 Bad Request", "");
            continue;
        };
        if url.path() != "/callback" {
            respond(&mut stream, "404 Not Found", "");
            continue;
        }
        let q: HashMap<String, String> = url.query_pairs().into_owned().collect();
        if q.get("state").map(String::as_str) != Some(state) {
            respond(&mut stream, "400 Bad Request", "state mismatch");
            continue;
        }
        if let Some(err) = q.get("error") {
            respond(&mut stream, "200 OK", "<p>Abgelehnt. Du kannst das Fenster schließen.</p>");
            return Err(format!("Spotify: {err}"));
        }
        if let Some(code) = q.get("code") {
            respond(&mut stream, "200 OK", PAGE_OK);
            return Ok(code.clone());
        }
        respond(&mut stream, "400 Bad Request", "");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pkce_challenge_matches_rfc7636() {
        // RFC 7636 appendix B
        assert_eq!(
            challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }

    #[test]
    fn verifier_is_url_safe_and_long_enough() {
        let v = random_token(48);
        assert!(v.len() >= 43 && v.len() <= 128);
        assert!(v.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'));
    }

    fn now(id: &str, playing: bool, pos: f64, at: f64) -> Option<SpotifyNow> {
        Some(SpotifyNow {
            track_id: id.into(),
            uri: String::new(),
            title: String::new(),
            artists: vec![],
            album: String::new(),
            duration_ms: 200_000.0,
            progress_ms: pos,
            is_playing: playing,
            sampled_at: at,
            context: None,
        })
    }

    #[test]
    fn change_detection() {
        let a = now("x", true, 10_000.0, 0.0);
        assert!(!changed(&a, &now("x", true, 14_000.0, 4_000.0)));
        assert!(changed(&a, &now("y", true, 0.0, 4_000.0)));
        assert!(changed(&a, &now("x", false, 14_000.0, 4_000.0)));
        assert!(changed(&a, &now("x", true, 90_000.0, 4_000.0)));
    }
}
