//! "What song is playing right now?" — read from the OS media session.
//!
//! Windows: Global System Media Transport Controls (GSMTC), the same thing
//! the volume flyout shows. Spotify desktop, browsers, foobar, VLC … all
//! publish there, no login needed. We poll it on a background thread (cheap,
//! all local) and emit a `nowplaying` event whenever something meaningful
//! changes: another track, another app, play/pause, or a seek.
//!
//! Other platforms: stubs that report nothing. macOS has no open equivalent
//! (MediaRemote is closed to third-party apps); there the Spotify Web API
//! will be the source.

use serde::Serialize;
use std::sync::{Arc, Mutex};

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NowPlaying {
    /// App user model id of the publishing app, e.g. "Spotify.exe"
    pub app: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    /// "playing" | "paused" | "stopped" | "other"
    pub status: String,
    /// position at `sampled_at`, if the app publishes a timeline
    pub position_ms: Option<f64>,
    pub duration_ms: Option<f64>,
    /// unix ms the position was valid at
    pub sampled_at: f64,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MediaSession {
    pub app: String,
    pub title: String,
    pub artist: String,
    pub status: String,
}

#[derive(Default)]
pub struct NowPlayingState {
    pub current: Mutex<Option<NowPlaying>>,
    /// case-insensitive substring of the app id to prefer; None = automatic
    pub prefer: Mutex<Option<String>>,
}

pub type Shared = Arc<NowPlayingState>;

pub fn new() -> Shared {
    Arc::new(NowPlayingState::default())
}

#[tauri::command]
pub fn nowplaying_get(state: tauri::State<'_, Shared>) -> Option<NowPlaying> {
    state.current.lock().ok().and_then(|c| c.clone())
}

#[tauri::command]
pub fn nowplaying_prefer(app: Option<String>, state: tauri::State<'_, Shared>) {
    let app = app.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    eprintln!("[vizzy-np] prefer = {app:?}");
    if let Ok(mut p) = state.prefer.lock() {
        *p = app;
    }
}

#[tauri::command]
pub fn nowplaying_sessions() -> Result<Vec<MediaSession>, String> {
    imp::sessions()
}

/// Start the polling thread. Emits `nowplaying` (payload: `NowPlaying | null`).
pub fn spawn(app: tauri::AppHandle, state: Shared) {
    std::thread::Builder::new()
        .name("vizzy-nowplaying".into())
        .spawn(move || imp::run(app, state))
        .expect("spawn nowplaying thread");
}

fn now_unix_ms() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs_f64() * 1000.0)
        .unwrap_or(0.0)
}

/// True when `next` is worth telling the frontend about.
fn changed(prev: &Option<NowPlaying>, next: &Option<NowPlaying>) -> bool {
    match (prev, next) {
        (None, None) => false,
        (Some(a), Some(b)) => {
            if a.app != b.app
                || a.title != b.title
                || a.artist != b.artist
                || a.album != b.album
                || a.status != b.status
                || a.duration_ms != b.duration_ms
            {
                return true;
            }
            // a seek: the new sample disagrees with where the old one
            // should be by now
            match (a.position_ms, b.position_ms) {
                (Some(pa), Some(pb)) => {
                    let expect = if a.status == "playing" {
                        pa + (b.sampled_at - a.sampled_at)
                    } else {
                        pa
                    };
                    (pb - expect).abs() > 2000.0
                }
                (None, None) => false,
                _ => true,
            }
        }
        _ => true,
    }
}

#[cfg(target_os = "windows")]
mod imp {
    use super::*;
    use tauri::Emitter;
    use windows::Media::Control::{
        GlobalSystemMediaTransportControlsSession as Session,
        GlobalSystemMediaTransportControlsSessionManager as Manager,
        GlobalSystemMediaTransportControlsSessionPlaybackStatus as Status,
    };

    /// 100 ns ticks between 1601-01-01 and 1970-01-01
    const EPOCH_DIFF: i64 = 116_444_736_000_000_000;

    fn status_str(s: Status) -> &'static str {
        match s {
            Status::Playing => "playing",
            Status::Paused => "paused",
            Status::Stopped | Status::Closed => "stopped",
            _ => "other",
        }
    }

    fn manager() -> windows::core::Result<Manager> {
        Manager::RequestAsync()?.join()
    }

    fn all_sessions(m: &Manager) -> windows::core::Result<Vec<Session>> {
        let v = m.GetSessions()?;
        let mut out = Vec::new();
        for i in 0..v.Size()? {
            out.push(v.GetAt(i)?);
        }
        Ok(out)
    }

    fn session_status(s: &Session) -> &'static str {
        s.GetPlaybackInfo()
            .and_then(|p| p.PlaybackStatus())
            .map(status_str)
            .unwrap_or("other")
    }

    /// Preferred app if set and present; otherwise the system's current
    /// session if it plays, else any playing session, else the current one.
    fn pick(m: &Manager, prefer: Option<&str>) -> Option<Session> {
        let sessions = all_sessions(m).unwrap_or_default();
        if let Some(p) = prefer {
            let p = p.to_lowercase();
            if let Some(s) = sessions.iter().find(|s| {
                s.SourceAppUserModelId()
                    .map(|id| id.to_string().to_lowercase().contains(&p))
                    .unwrap_or(false)
            }) {
                return Some(s.clone());
            }
        }
        let current = m.GetCurrentSession().ok();
        if let Some(c) = &current {
            if session_status(c) == "playing" {
                return current;
            }
        }
        sessions
            .into_iter()
            .find(|s| session_status(s) == "playing")
            .or(current)
    }

    fn read(s: &Session) -> windows::core::Result<NowPlaying> {
        let app = s.SourceAppUserModelId()?.to_string();
        let props = s.TryGetMediaPropertiesAsync()?.join()?;
        let status = session_status(s).to_string();
        let mut position_ms = None;
        let mut duration_ms = None;
        let mut sampled_at = now_unix_ms();
        if let Ok(t) = s.GetTimelineProperties() {
            let start = t.StartTime().map(|d| d.Duration).unwrap_or(0);
            let end = t.EndTime().map(|d| d.Duration).unwrap_or(0);
            let pos = t.Position().map(|d| d.Duration).unwrap_or(0);
            if end > start {
                duration_ms = Some((end - start) as f64 / 10_000.0);
                position_ms = Some((pos - start).max(0) as f64 / 10_000.0);
                if let Ok(u) = t.LastUpdatedTime() {
                    if u.UniversalTime > EPOCH_DIFF {
                        let at = (u.UniversalTime - EPOCH_DIFF) as f64 / 10_000.0;
                        // some apps never stamp it; don't trust the future
                        if at <= sampled_at + 1000.0 {
                            sampled_at = at;
                        }
                    }
                }
            }
        }
        Ok(NowPlaying {
            app,
            title: props.Title()?.to_string(),
            artist: props.Artist()?.to_string(),
            album: props.AlbumTitle().map(|h| h.to_string()).unwrap_or_default(),
            status,
            position_ms,
            duration_ms,
            sampled_at,
        })
    }

    pub fn sessions() -> Result<Vec<MediaSession>, String> {
        let m = manager().map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        for s in all_sessions(&m).map_err(|e| e.to_string())? {
            let app = s.SourceAppUserModelId().map(|h| h.to_string()).unwrap_or_default();
            let (title, artist) = s
                .TryGetMediaPropertiesAsync()
                .and_then(|op| op.join())
                .map(|p| {
                    (
                        p.Title().map(|h| h.to_string()).unwrap_or_default(),
                        p.Artist().map(|h| h.to_string()).unwrap_or_default(),
                    )
                })
                .unwrap_or_default();
            out.push(MediaSession {
                status: session_status(&s).to_string(),
                app,
                title,
                artist,
            });
        }
        Ok(out)
    }

    pub fn run(app: tauri::AppHandle, state: Shared) {
        let mut mgr: Option<Manager> = None;
        let mut last: Option<NowPlaying> = None;
        let mut fails = 0u32;
        loop {
            if mgr.is_none() {
                match manager() {
                    Ok(m) => {
                        eprintln!("[vizzy-np] media session manager ready");
                        mgr = Some(m);
                        fails = 0;
                    }
                    Err(e) => {
                        fails += 1;
                        if fails == 1 || fails % 60 == 0 {
                            eprintln!("[vizzy-np] no media session manager: {e}");
                        }
                        std::thread::sleep(std::time::Duration::from_secs(5));
                        continue;
                    }
                }
            }
            let prefer = state.prefer.lock().ok().and_then(|p| p.clone());
            let next = mgr
                .as_ref()
                .and_then(|m| pick(m, prefer.as_deref()))
                .and_then(|s| read(&s).ok())
                // an app that is up but has nothing loaded
                .filter(|np| !np.title.is_empty());

            if changed(&last, &next) {
                match &next {
                    Some(np) if last.as_ref().map(|l| (&l.title, &l.artist)) != Some((&np.title, &np.artist)) => {
                        eprintln!("[vizzy-np] {} — {} [{}] ({})", np.artist, np.title, np.status, np.app)
                    }
                    None => eprintln!("[vizzy-np] nothing playing"),
                    _ => {}
                }
                if let Ok(mut c) = state.current.lock() {
                    *c = next.clone();
                }
                let _ = app.emit("nowplaying", &next);
            }
            last = next;
            std::thread::sleep(std::time::Duration::from_millis(500));
        }
    }
}

#[cfg(not(target_os = "windows"))]
mod imp {
    use super::*;

    pub fn sessions() -> Result<Vec<MediaSession>, String> {
        Ok(Vec::new())
    }

    pub fn run(_app: tauri::AppHandle, _state: Shared) {
        let _ = (now_unix_ms(), changed(&None, &None));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn np(title: &str, status: &str, pos: Option<f64>, at: f64) -> Option<NowPlaying> {
        Some(NowPlaying {
            app: "Spotify.exe".into(),
            title: title.into(),
            artist: "A".into(),
            album: String::new(),
            status: status.into(),
            position_ms: pos,
            duration_ms: Some(200_000.0),
            sampled_at: at,
        })
    }

    #[test]
    fn steady_playback_is_not_a_change() {
        let a = np("x", "playing", Some(10_000.0), 1_000.0);
        let b = np("x", "playing", Some(10_500.0), 1_500.0);
        assert!(!changed(&a, &b));
    }

    #[test]
    fn seek_track_and_pause_are_changes() {
        let a = np("x", "playing", Some(10_000.0), 1_000.0);
        assert!(changed(&a, &np("x", "playing", Some(60_000.0), 1_500.0)));
        assert!(changed(&a, &np("y", "playing", Some(0.0), 1_500.0)));
        assert!(changed(&a, &np("x", "paused", Some(10_500.0), 1_500.0)));
        assert!(changed(&a, &None));
    }

    #[test]
    fn paused_position_holds() {
        let a = np("x", "paused", Some(10_000.0), 1_000.0);
        assert!(!changed(&a, &np("x", "paused", Some(10_000.0), 9_000.0)));
    }
}

/// `cargo test --lib nowplaying::live -- --ignored --nocapture` — prints what
/// the OS reports right now. Not run by default (depends on the machine).
#[cfg(all(test, target_os = "windows"))]
mod live {
    #[test]
    #[ignore]
    fn print_sessions() {
        for s in super::imp::sessions().unwrap() {
            println!("{s:?}");
        }
    }
}
