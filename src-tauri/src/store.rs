//! Small JSON documents in the app data directory (`tags.json`, later the
//! preset files). Plain files rather than webview storage, so they can be
//! read, diffed, shared — and written by a tool outside the app.

use std::path::PathBuf;
use tauri::Manager;

/// Only bare file names, optionally one level of sub folder (`presets/x.json`):
/// the frontend must never be able to reach outside the data directory.
fn resolve(app: &tauri::AppHandle, name: &str) -> Result<PathBuf, String> {
    let ok = !name.is_empty()
        && name.len() < 200
        && !name.contains("..")
        && !name.starts_with('/')
        && !name.contains('\\')
        && !name.contains(':')
        && name.split('/').count() <= 2;
    if !ok {
        return Err(format!("invalid data file name: {name}"));
    }
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(dir.join(name))
}

/// `None` when the file does not exist yet.
#[tauri::command]
pub fn data_read(app: tauri::AppHandle, name: String) -> Result<Option<String>, String> {
    let path = resolve(&app, &name)?;
    match std::fs::read_to_string(&path) {
        Ok(s) => Ok(Some(s)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("{}: {e}", path.display())),
    }
}

/// Written to a temp file and renamed, so a crash mid-write never leaves a
/// half file behind.
#[tauri::command]
pub fn data_write(app: tauri::AppHandle, name: String, contents: String) -> Result<(), String> {
    let path = resolve(&app, &name)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, contents).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn data_dir(app: tauri::AppHandle) -> Result<String, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(dir.display().to_string())
}
