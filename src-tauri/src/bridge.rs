//! Dev bridge: a tiny HTTP server on 127.0.0.1 that lets a tool outside the
//! app — Claude Code, a script — drive the preset workflow: read what is
//! playing, load a preset, render a preview of a preset JSON and get back
//! an image plus any compile errors, read the log.
//!
//! Off unless switched on in Settings. Binds to loopback only, on a random
//! port, and every request must carry the token written next to the port in
//! `<app data>/bridge.json` — so another local process cannot drive the app
//! by guessing a port.
//!
//! Requests that need the webview (load, preview, screenshot) are forwarded
//! as a `bridge-command` event; the frontend answers with `bridge_reply`,
//! which wakes the waiting HTTP thread.

use std::collections::{HashMap, VecDeque};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{Emitter, Manager};

const LOG_LINES: usize = 300;

#[derive(Default)]
pub struct BridgeState {
    running: AtomicBool,
    port: Mutex<u16>,
    token: Mutex<String>,
    next_id: AtomicU64,
    pending: Mutex<HashMap<u64, mpsc::Sender<String>>>,
    /// latest state pushed by the frontend (JSON text)
    state: Mutex<String>,
    log: Mutex<VecDeque<String>>,
}

pub type Bridge = Arc<BridgeState>;

pub fn new() -> Bridge {
    Arc::new(BridgeState::default())
}

/// Keeps the last lines of the frontend log for `GET /log`.
pub fn push_log(bridge: &Bridge, line: String) {
    let mut log = bridge.log.lock().unwrap();
    log.push_back(line);
    while log.len() > LOG_LINES {
        log.pop_front();
    }
}

fn token() -> String {
    use std::collections::hash_map::RandomState;
    use std::hash::{BuildHasher, Hasher};
    let mut out = String::new();
    for _ in 0..2 {
        let mut h = RandomState::new().build_hasher();
        h.write_u128(
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0),
        );
        out.push_str(&format!("{:016x}", h.finish()));
    }
    out
}

#[derive(serde::Serialize)]
pub struct BridgeInfo {
    port: u16,
    token: String,
    file: String,
}

#[tauri::command]
pub fn bridge_start(app: tauri::AppHandle, bridge: tauri::State<'_, Bridge>) -> Result<BridgeInfo, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let file = dir.join("bridge.json");
    if bridge.running.load(Ordering::SeqCst) {
        return Ok(BridgeInfo {
            port: *bridge.port.lock().unwrap(),
            token: bridge.token.lock().unwrap().clone(),
            file: file.display().to_string(),
        });
    }
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let tok = token();
    *bridge.port.lock().unwrap() = port;
    *bridge.token.lock().unwrap() = tok.clone();
    bridge.running.store(true, Ordering::SeqCst);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let info = serde_json::json!({
        "url": format!("http://127.0.0.1:{port}"),
        "port": port,
        "token": tok,
        "header": "X-Vizzy-Token",
        "docs": "docs/bridge.md in the vizzy repository",
    });
    std::fs::write(&file, serde_json::to_string_pretty(&info).unwrap()).map_err(|e| e.to_string())?;
    eprintln!("[vizzy-bridge] listening on 127.0.0.1:{port}");

    let shared = bridge.inner().clone();
    std::thread::spawn(move || {
        listener.set_nonblocking(true).ok();
        while shared.running.load(Ordering::SeqCst) {
            match listener.accept() {
                Ok((stream, _)) => {
                    let s = shared.clone();
                    let a = app.clone();
                    std::thread::spawn(move || {
                        if let Err(e) = handle(stream, &s, &a) {
                            eprintln!("[vizzy-bridge] {e}");
                        }
                    });
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(50));
                }
                Err(e) => {
                    eprintln!("[vizzy-bridge] accept failed: {e}");
                    break;
                }
            }
        }
        eprintln!("[vizzy-bridge] stopped");
    });
    Ok(BridgeInfo { port, token: tok, file: file.display().to_string() })
}

#[tauri::command]
pub fn bridge_stop(app: tauri::AppHandle, bridge: tauri::State<'_, Bridge>) -> Result<(), String> {
    bridge.running.store(false, Ordering::SeqCst);
    if let Ok(dir) = app.path().app_data_dir() {
        let _ = std::fs::remove_file(dir.join("bridge.json"));
    }
    Ok(())
}

/// The frontend publishes what is on screen; `GET /state` returns it.
#[tauri::command]
pub fn bridge_set_state(json: String, bridge: tauri::State<'_, Bridge>) {
    *bridge.state.lock().unwrap() = json;
}

/// The frontend's answer to a forwarded command.
#[tauri::command]
pub fn bridge_reply(id: u64, json: String, bridge: tauri::State<'_, Bridge>) {
    if let Some(tx) = bridge.pending.lock().unwrap().remove(&id) {
        let _ = tx.send(json);
    }
}

fn respond(stream: &mut TcpStream, status: &str, body: &str) -> std::io::Result<()> {
    let head = format!(
        "HTTP/1.1 {status}\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    stream.write_all(head.as_bytes())?;
    stream.write_all(body.as_bytes())?;
    stream.flush()
}

fn handle(stream: TcpStream, bridge: &BridgeState, app: &tauri::AppHandle) -> Result<(), String> {
    stream.set_nonblocking(false).ok();
    stream.set_read_timeout(Some(Duration::from_secs(10))).ok();
    let mut reader = BufReader::new(stream.try_clone().map_err(|e| e.to_string())?);
    let mut line = String::new();
    reader.read_line(&mut line).map_err(|e| e.to_string())?;
    let mut parts = line.split_whitespace();
    let method = parts.next().unwrap_or("").to_string();
    let path = parts.next().unwrap_or("").split('?').next().unwrap_or("").to_string();
    let mut len = 0usize;
    let mut tok = String::new();
    loop {
        let mut h = String::new();
        reader.read_line(&mut h).map_err(|e| e.to_string())?;
        let h = h.trim_end();
        if h.is_empty() {
            break;
        }
        if let Some((k, v)) = h.split_once(':') {
            let k = k.trim().to_ascii_lowercase();
            if k == "content-length" {
                len = v.trim().parse().unwrap_or(0);
            } else if k == "x-vizzy-token" {
                tok = v.trim().to_string();
            }
        }
    }
    let mut body = vec![0u8; len.min(8 * 1024 * 1024)];
    reader.read_exact(&mut body).map_err(|e| e.to_string())?;
    let body = String::from_utf8_lossy(&body).to_string();
    let mut out = stream;

    if tok != *bridge.token.lock().unwrap() {
        return respond(&mut out, "401 Unauthorized", r#"{"error":"missing or wrong X-Vizzy-Token (see bridge.json)"}"#)
            .map_err(|e| e.to_string());
    }

    let reply = match (method.as_str(), path.as_str()) {
        ("GET", "/state") => {
            let s = bridge.state.lock().unwrap().clone();
            Ok(if s.is_empty() { "{}".to_string() } else { s })
        }
        ("GET", "/log") => {
            let log: Vec<String> = bridge.log.lock().unwrap().iter().cloned().collect();
            Ok(serde_json::to_string(&log).unwrap())
        }
        ("POST", "/load") | ("POST", "/preview") | ("POST", "/screenshot") | ("POST", "/save") => {
            forward(bridge, app, &path[1..], &body)
        }
        _ => Err(("404 Not Found", r#"{"error":"unknown endpoint — see docs/bridge.md"}"#.to_string())),
    };
    match reply {
        Ok(json) => respond(&mut out, "200 OK", &json),
        Err((status, json)) => respond(&mut out, status, &json),
    }
    .map_err(|e| e.to_string())
}

/// Hands a request to the webview and waits for its answer.
fn forward(bridge: &BridgeState, app: &tauri::AppHandle, kind: &str, body: &str) -> Result<String, (&'static str, String)> {
    let payload: serde_json::Value = if body.trim().is_empty() {
        serde_json::json!({})
    } else {
        serde_json::from_str(body).map_err(|e| ("400 Bad Request", format!(r#"{{"error":"body is not JSON: {e}"}}"#)))?
    };
    let id = bridge.next_id.fetch_add(1, Ordering::SeqCst) + 1;
    let (tx, rx) = mpsc::channel();
    bridge.pending.lock().unwrap().insert(id, tx);
    app.emit("bridge-command", serde_json::json!({ "id": id, "kind": kind, "body": payload }))
        .map_err(|e| ("500 Internal Server Error", format!(r#"{{"error":"{e}"}}"#)))?;
    match rx.recv_timeout(Duration::from_secs(30)) {
        Ok(json) => Ok(json),
        Err(_) => {
            bridge.pending.lock().unwrap().remove(&id);
            Err(("504 Gateway Timeout", r#"{"error":"the app did not answer in 30 s — is the window open?"}"#.to_string()))
        }
    }
}
