mod audio;

use std::sync::{Arc, Mutex};

struct AudioState(audio::SharedAnalysis);

/// Returns the latest analysis frame as raw little-endian f32 bytes:
/// `[rms, peak, n_bands, n_wave, bands..., wave...]`
#[tauri::command]
fn get_analysis_frame(state: tauri::State<'_, AudioState>) -> tauri::ipc::Response {
    let frame = state.0.lock().unwrap();
    let mut bytes = Vec::with_capacity(frame.len() * 4);
    for v in frame.iter() {
        bytes.extend_from_slice(&v.to_le_bytes());
    }
    tauri::ipc::Response::new(bytes)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let shared: audio::SharedAnalysis = Arc::new(Mutex::new(audio::empty_frame()));
    audio::spawn_capture(shared.clone());

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(AudioState(shared))
        .invoke_handler(tauri::generate_handler![get_analysis_frame])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
