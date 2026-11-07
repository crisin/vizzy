mod audio;
mod bridge;
mod llm;
mod newhelper;
mod nowplaying;
/// public so `tests/comfy_mock.rs` can drive the bake against a stand-in server
pub mod comfy;
mod phrasing;
mod spotify;
mod store;
mod tempo;

use std::sync::{mpsc, Arc, Mutex};

struct AudioState {
    shared: audio::SharedAnalysis,
    control: mpsc::Sender<audio::SourceSpec>,
    params: audio::SharedParams,
}

/// Returns the latest analysis frame as raw little-endian f32 bytes:
/// `[header..., bands..., wave...]` — see `audio::HEADER` for the layout.
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

/// Beat detection threshold in standard deviations above the running mean
/// of the spectral flux — lower = more sensitive.
#[tauri::command]
fn set_beat_sensitivity(
    sigma: f32,
    state: tauri::State<'_, AudioState>,
) -> Result<(), String> {
    let sigma = sigma.clamp(0.5, 3.0);
    state
        .params
        .lock()
        .map_err(|e| e.to_string())?
        .beat_sigma = sigma;
    eprintln!("[vizzy-audio] beat sigma = {sigma}");
    Ok(())
}

/// Lets the webview surface errors/status into the dev console output,
/// since the webview's own console is not visible in `tauri dev` logs.
#[tauri::command]
fn frontend_log(msg: String, bridge: tauri::State<'_, bridge::Bridge>) {
    eprintln!("[vizzy-web] {msg}");
    bridge::push_log(&bridge, msg);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let shared: audio::SharedAnalysis = Arc::new(Mutex::new(audio::empty_frame()));
    let params: audio::SharedParams =
        Arc::new(Mutex::new(audio::AnalysisParams::default()));
    let (tx, rx) = mpsc::channel();
    audio::spawn_capture(shared.clone(), rx, params.clone());

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(bridge::new())
        .manage(nowplaying::new())
        .manage(spotify::new())
        .manage(newhelper::new())
        .setup(|app| {
            use tauri::Manager;
            let np = app.state::<nowplaying::Shared>().inner().clone();
            nowplaying::spawn(app.handle().clone(), np);
            let sp = app.state::<spotify::Shared>().inner().clone();
            spotify::spawn(app.handle().clone(), sp);
            let nh = app.state::<newhelper::Shared>().inner().clone();
            newhelper::load(app.handle(), &nh);
            Ok(())
        })
        .manage(AudioState {
            shared,
            control: tx,
            params,
        })
        .invoke_handler(tauri::generate_handler![
            get_analysis_frame,
            list_sources,
            list_apps,
            set_source,
            set_beat_sensitivity,
            frontend_log,
            comfy::comfy_ping,
            comfy::comfy_bake,
            store::data_read,
            store::data_write,
            store::data_dir,
            store::data_list,
            store::data_delete,
            store::data_open_dir,
            bridge::bridge_start,
            bridge::bridge_stop,
            bridge::bridge_set_state,
            bridge::bridge_reply,
            llm::llm_models,
            llm::llm_chat,
            nowplaying::nowplaying_get,
            nowplaying::nowplaying_prefer,
            nowplaying::nowplaying_sessions,
            spotify::spotify_status,
            spotify::spotify_now,
            spotify::spotify_set_client_id,
            spotify::spotify_poll_now,
            spotify::spotify_disconnect,
            spotify::spotify_cancel_connect,
            spotify::spotify_connect,
            spotify::spotify_playlists,
            newhelper::newhelper_status,
            newhelper::newhelper_configure,
            newhelper::newhelper_test,
            newhelper::newhelper_song
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
