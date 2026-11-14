//! Overlay mode: vizzy lies over the whole screen, see-through and
//! click-through, always on top — the PC stays usable underneath.
//!
//! The window is created transparent (`tauri.conf.json`); in normal mode
//! the page paints its own opaque background, in overlay mode it does not
//! and dims itself with CSS opacity. Here: always on top, clicks pass
//! through, no frame, the bounds of the monitor it is on — and back.
//!
//! While clicks pass through, vizzy never gets keyboard focus, so the way
//! out is a global shortcut (Ctrl+Alt+V), plus Ctrl+Alt+↑/↓ for the opacity.
//! The frontend hears both as the `overlay` event.
//!
//! Windows is the platform this is built for. On macOS the window is not
//! transparent without the private API, so the mode is still on top and
//! click-through but opaque (`PLAN-ux.md`, platform code degrades).

use serde::Serialize;
use std::sync::Mutex;
use tauri::{Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewWindow};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

/// What the window looked like before the overlay took it over.
struct Saved {
    pos: PhysicalPosition<i32>,
    size: PhysicalSize<u32>,
    maximized: bool,
    fullscreen: bool,
    decorated: bool,
}

#[derive(Default)]
pub struct Overlay {
    saved: Mutex<Option<Saved>>,
}

pub type Shared = std::sync::Arc<Overlay>;

pub fn new() -> Shared {
    Default::default()
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Event {
    /// "toggle", "up", "down" — from a global shortcut
    action: &'static str,
}

fn toggle_key() -> Shortcut {
    Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::KeyV)
}
fn up_key() -> Shortcut {
    Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::ArrowUp)
}
fn down_key() -> Shortcut {
    Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::ArrowDown)
}

/// The global-shortcut plugin, with our three keys forwarded as events.
pub fn plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri_plugin_global_shortcut::Builder::new()
        .with_handler(|app, shortcut, event| {
            if event.state() != ShortcutState::Pressed {
                return;
            }
            let action = if *shortcut == toggle_key() {
                "toggle"
            } else if *shortcut == up_key() {
                "up"
            } else if *shortcut == down_key() {
                "down"
            } else {
                return;
            };
            let _ = app.emit("overlay", Event { action });
        })
        .build()
}

/// Ctrl+Alt+V is always there (it is how one gets into the mode from
/// anywhere, too); the opacity keys only while the overlay is on, so they
/// do not take Ctrl+Alt+↑/↓ from other programs the rest of the time.
pub fn register(app: &tauri::AppHandle) {
    if let Err(e) = app.global_shortcut().register(toggle_key()) {
        eprintln!("[vizzy-overlay] Ctrl+Alt+V not available: {e}");
    }
}

fn main_window(app: &tauri::AppHandle) -> Result<WebviewWindow, String> {
    app.get_webview_window("main").ok_or_else(|| "kein Hauptfenster".to_string())
}

/// Switches the overlay on or off. Idempotent.
#[tauri::command]
pub fn overlay_set(on: bool, app: tauri::AppHandle, me: tauri::State<'_, Shared>) -> Result<(), String> {
    let w = main_window(&app)?;
    let mut saved = me.saved.lock().unwrap();
    let err = |e: tauri::Error| e.to_string();
    let keys = app.global_shortcut();
    if on {
        if saved.is_some() {
            return Ok(());
        }
        let monitor = w.current_monitor().map_err(err)?.ok_or("kein Bildschirm gefunden")?;
        *saved = Some(Saved {
            pos: w.outer_position().map_err(err)?,
            size: w.outer_size().map_err(err)?,
            maximized: w.is_maximized().unwrap_or(false),
            fullscreen: w.is_fullscreen().unwrap_or(false),
            decorated: w.is_decorated().unwrap_or(true),
        });
        if w.is_fullscreen().unwrap_or(false) {
            w.set_fullscreen(false).map_err(err)?;
        }
        if w.is_maximized().unwrap_or(false) {
            w.unmaximize().map_err(err)?;
        }
        w.set_decorations(false).map_err(err)?;
        w.set_shadow(false).ok();
        w.set_position(*monitor.position()).map_err(err)?;
        w.set_size(*monitor.size()).map_err(err)?;
        w.set_always_on_top(true).map_err(err)?;
        w.set_ignore_cursor_events(true).map_err(err)?;
        let _ = keys.register(up_key());
        let _ = keys.register(down_key());
    } else {
        let Some(s) = saved.take() else { return Ok(()) };
        let _ = keys.unregister(up_key());
        let _ = keys.unregister(down_key());
        w.set_ignore_cursor_events(false).map_err(err)?;
        w.set_always_on_top(false).map_err(err)?;
        w.set_decorations(s.decorated).map_err(err)?;
        w.set_shadow(true).ok();
        w.set_size(s.size).map_err(err)?;
        w.set_position(s.pos).map_err(err)?;
        if s.maximized {
            w.maximize().map_err(err)?;
        }
        if s.fullscreen {
            w.set_fullscreen(true).map_err(err)?;
        }
        let _ = w.set_focus();
    }
    Ok(())
}
