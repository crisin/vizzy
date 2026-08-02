mod audio;

use std::sync::{mpsc, Arc, Mutex};

struct AudioState {
    shared: audio::SharedAnalysis,
    control: mpsc::Sender<audio::SourceSpec>,
}

/// Returns the latest analysis frame as raw little-endian f32 bytes:
/// `[rms, peak, n_bands, n_wave, bands..., wave...]`
#[tauri::command]
fn get_analysis_frame(state: tauri::State<'_, AudioState>) -> tauri::ipc::Response {
    let frame = state.shared.lock().unwrap();
    let mut bytes = Vec::with_capacity(frame.len() * 4);
    for v in frame.iter() {
        bytes.extend_from_slice(&v.to_le_bytes());
    }
    tauri::ipc::Response::new(bytes)
}

#[tauri::command]
fn list_sources() -> Result<Vec<audio::SourceInfo>, String> {
    audio::list_sources()
}

#[tauri::command]
fn list_apps() -> Result<Vec<audio::AppInfo>, String> {
    audio::list_apps()
}

#[tauri::command]
fn set_source(
    spec: audio::SourceSpec,
    state: tauri::State<'_, AudioState>,
) -> Result<(), String> {
    state.control.send(spec).map_err(|e| e.to_string())
}

/// Lets the webview surface errors/status into the dev console output,
/// since the webview's own console is not visible in `tauri dev` logs.
#[tauri::command]
fn frontend_log(msg: String) {
    eprintln!("[vizzy-web] {msg}");
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let shared: audio::SharedAnalysis = Arc::new(Mutex::new(audio::empty_frame()));
    let (tx, rx) = mpsc::channel();
    audio::spawn_capture(shared.clone(), rx);

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(AudioState {
            shared,
            control: tx,
        })
        .invoke_handler(tauri::generate_handler![
            get_analysis_frame,
            list_sources,
            list_apps,
            set_source,
            frontend_log
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
