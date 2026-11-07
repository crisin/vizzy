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

#[derive(serde::Serialize)]
pub struct DataEntry {
    /// path relative to the data directory, e.g. `presets/x.json`
    name: String,
    /// modification time, ms since the epoch — the frontend polls this to
    /// notice files written by something else (an editor, Claude Code)
    modified: u64,
}

/// JSON files in one sub folder of the data directory (empty when missing).
#[tauri::command]
pub fn data_list(app: tauri::AppHandle, dir: String) -> Result<Vec<DataEntry>, String> {
    let base = resolve(&app, &format!("{dir}/x"))?;
    let folder = base.parent().ok_or("no folder")?.to_path_buf();
    let mut out = Vec::new();
    let Ok(rd) = std::fs::read_dir(&folder) else {
        return Ok(out);
    };
    for entry in rd.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let modified = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        if let Some(file) = path.file_name().and_then(|n| n.to_str()) {
            out.push(DataEntry { name: format!("{dir}/{file}"), modified });
        }
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

#[tauri::command]
pub fn data_delete(app: tauri::AppHandle, name: String) -> Result<(), String> {
    let path = resolve(&app, &name)?;
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

/// Opens a folder of the data directory in the system file manager. Done
/// here rather than through the opener plugin's JS API so no path scope has
/// to be granted to the webview.
#[tauri::command]
pub fn data_open_dir(app: tauri::AppHandle, dir: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let path = resolve(&app, &format!("{dir}/x"))?;
    let folder = path.parent().ok_or("no folder")?.to_path_buf();
    std::fs::create_dir_all(&folder).map_err(|e| e.to_string())?;
    app.opener()
        .open_path(folder.display().to_string(), None::<&str>)
        .map_err(|e| e.to_string())
}
