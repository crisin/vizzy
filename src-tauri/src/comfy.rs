//! ComfyUI bake client.
//!
//! vizzy asks a locally running ComfyUI to turn a still image into whatever
//! the parallax scene needs — today a depth map. The job runs offline, once
//! per picture; nothing here is in the render path.
//!
//! This lives in Rust rather than the webview for one blunt reason: ComfyUI
//! serves no CORS headers unless started with `--enable-cors-header`, so a
//! `fetch` from `tauri://localhost` is blocked before it leaves the page.
//!
//! The workflow is passed in from the frontend as ComfyUI's *API format*
//! JSON (Settings → "Export (API)" in ComfyUI), with the literal token
//! `__VIZZY_INPUT_IMAGE__` wherever the uploaded filename belongs. Keeping it
//! a template instead of hardcoding node names matters: which depth nodes
//! exist depends on the custom nodes a given install happens to have.

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use serde::Deserialize;
use std::time::Duration;

/// Placeholder the frontend's workflow template uses for the input image.
const IMAGE_TOKEN: &str = "__VIZZY_INPUT_IMAGE__";
/// How long to wait for a queued prompt. Generous: the first run of a model
/// pays for loading weights from disk, which dwarfs the inference itself.
const JOB_TIMEOUT: Duration = Duration::from_secs(300);
const POLL_INTERVAL: Duration = Duration::from_millis(400);

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(|e| format!("HTTP-Client ließ sich nicht bauen: {e}"))
}

fn base(url: &str) -> String {
    let trimmed = url.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        "http://127.0.0.1:8188".to_string()
    } else if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
        trimmed.to_string()
    } else {
        format!("http://{trimmed}")
    }
}

#[derive(Deserialize)]
struct UploadResponse {
    name: String,
    #[serde(default)]
    subfolder: String,
}

#[derive(Deserialize)]
struct PromptResponse {
    prompt_id: Option<String>,
    error: Option<serde_json::Value>,
    node_errors: Option<serde_json::Value>,
}

/// Reachability check for the settings panel — also tells the user *which*
/// ComfyUI answered, which is the usual confusion when two are running.
#[tauri::command]
pub async fn comfy_ping(url: String) -> Result<String, String> {
    ping(&url).await
}

pub async fn ping(url: &str) -> Result<String, String> {
    let base = base(&url);
    let res = client()?
        .get(format!("{base}/system_stats"))
        .send()
        .await
        .map_err(|e| format!("keine Verbindung zu {base}: {e}"))?;
    if !res.status().is_success() {
        return Err(format!("{base} antwortet mit HTTP {}", res.status()));
    }
    let stats: serde_json::Value = res
        .json()
        .await
        .map_err(|e| format!("unerwartete Antwort von {base}: {e}"))?;

    let system = stats.get("system");
    let comfy = system
        .and_then(|s| s.get("comfyui_version"))
        .and_then(|v| v.as_str())
        .unwrap_or("?");
    let device = stats
        .get("devices")
        .and_then(|d| d.get(0))
        .and_then(|d| d.get("name"))
        .and_then(|v| v.as_str())
        .unwrap_or("unbekanntes Gerät");
    Ok(format!("ComfyUI {comfy} · {device}"))
}

/// Upload an image, run the workflow over it, return every output image.
///
/// `image_b64` is the raw file, base64-encoded: Tauri's IPC takes a JSON
/// payload here, and a `Vec<u8>` would travel as a JSON array of numbers —
/// several times larger than the base64 it replaces.
///
/// The results come back the other way as one blob, framed as
/// `[u32 count][u32 len]*count[bytes]*count`, all little-endian. A depth bake
/// returns one image and a variant bake a dozen; base64-ing a dozen PNGs
/// through JSON would cost more than the framing is worth.
#[tauri::command]
pub async fn comfy_bake(
    url: String,
    workflow: String,
    image_b64: String,
    filename: String,
) -> Result<tauri::ipc::Response, String> {
    let bytes = B64
        .decode(image_b64.as_bytes())
        .map_err(|e| format!("Bild ließ sich nicht dekodieren: {e}"))?;
    let images = bake(&url, &workflow, bytes, &filename).await?;
    Ok(tauri::ipc::Response::new(frame_images(&images)))
}

/// `[u32 count][u32 len]*count[payload]*count`, little-endian.
fn frame_images(images: &[Vec<u8>]) -> Vec<u8> {
    let total: usize =
        4 + images.len() * 4 + images.iter().map(|i| i.len()).sum::<usize>();
    let mut out = Vec::with_capacity(total);
    out.extend_from_slice(&(images.len() as u32).to_le_bytes());
    for img in images {
        out.extend_from_slice(&(img.len() as u32).to_le_bytes());
    }
    for img in images {
        out.extend_from_slice(img);
    }
    out
}

/// The bake itself, free of Tauri types so it can be driven from a test
/// against a stand-in ComfyUI (see `tests/comfy_mock.rs`).
///
/// Returns the images in the order the workflow saved them, which for a
/// batched sampler is the batch order — that is what the morph grid reads as
/// its control-surface order.
pub async fn bake(
    url: &str,
    workflow: &str,
    bytes: Vec<u8>,
    filename: &str,
) -> Result<Vec<Vec<u8>>, String> {
    let base = base(url);
    let http = client()?;

    // 1. upload into ComfyUI's input folder
    let safe_name = sanitize(filename);
    let part = reqwest::multipart::Part::bytes(bytes)
        .file_name(safe_name.clone())
        .mime_str("application/octet-stream")
        .map_err(|e| e.to_string())?;
    let form = reqwest::multipart::Form::new()
        .part("image", part)
        .text("overwrite", "true")
        .text("type", "input");
    let res = http
        .post(format!("{base}/upload/image"))
        .multipart(form)
        .send()
        .await
        .map_err(|e| format!("Upload zu {base} fehlgeschlagen: {e}"))?;
    if !res.status().is_success() {
        return Err(format!("Upload abgelehnt: HTTP {}", res.status()));
    }
    let uploaded: UploadResponse = res
        .json()
        .await
        .map_err(|e| format!("Upload-Antwort unlesbar: {e}"))?;
    // ComfyUI's LoadImage refers to a subfolder'd file as "sub/name.png"
    let image_ref = if uploaded.subfolder.is_empty() {
        uploaded.name
    } else {
        format!("{}/{}", uploaded.subfolder, uploaded.name)
    };

    // 2. fill the template and queue it
    if !workflow.contains(IMAGE_TOKEN) {
        return Err(format!(
            "Workflow enthält den Platzhalter {IMAGE_TOKEN} nicht — ohne ihn \
             weiß ComfyUI nicht, welches Bild gemeint ist"
        ));
    }
    let filled = workflow.replace(IMAGE_TOKEN, &json_escape(&image_ref));
    let prompt: serde_json::Value = serde_json::from_str(&filled)
        .map_err(|e| format!("Workflow ist kein gültiges JSON: {e}"))?;

    let client_id = format!("vizzy-{}", std::process::id());
    let res = http
        .post(format!("{base}/prompt"))
        .json(&serde_json::json!({ "prompt": prompt, "client_id": client_id }))
        .send()
        .await
        .map_err(|e| format!("Prompt konnte nicht abgeschickt werden: {e}"))?;
    let status = res.status();
    let body: PromptResponse = res
        .json()
        .await
        .map_err(|e| format!("Prompt-Antwort unlesbar (HTTP {status}): {e}"))?;
    if let Some(err) = body.error {
        // node_errors is where a missing custom node shows up, which is by
        // far the most common failure — surface it instead of "HTTP 400"
        let detail = body
            .node_errors
            .filter(|n| !n.is_null())
            .map(|n| format!("\n{n}"))
            .unwrap_or_default();
        return Err(format!("ComfyUI lehnt den Workflow ab: {err}{detail}"));
    }
    let prompt_id = body
        .prompt_id
        .ok_or_else(|| "ComfyUI lieferte keine prompt_id".to_string())?;

    // 3. wait for it, then fetch everything the workflow saved
    let outputs = poll_history(&http, &base, &prompt_id).await?;
    let mut images = Vec::with_capacity(outputs.len());
    for output in &outputs {
        let view = http
            .get(format!("{base}/view"))
            .query(&[
                ("filename", output.filename.as_str()),
                ("subfolder", output.subfolder.as_str()),
                ("type", output.kind.as_str()),
            ])
            .send()
            .await
            .map_err(|e| format!("Ergebnis-Download fehlgeschlagen: {e}"))?;
        if !view.status().is_success() {
            return Err(format!(
                "Ergebnis-Download ({}): HTTP {}",
                output.filename,
                view.status()
            ));
        }
        let data = view
            .bytes()
            .await
            .map_err(|e| format!("Ergebnis unvollständig: {e}"))?;
        images.push(data.to_vec());
    }
    Ok(images)
}

struct OutputRef {
    filename: String,
    subfolder: String,
    kind: String,
}

async fn poll_history(
    http: &reqwest::Client,
    base: &str,
    prompt_id: &str,
) -> Result<Vec<OutputRef>, String> {
    let deadline = std::time::Instant::now() + JOB_TIMEOUT;
    loop {
        if std::time::Instant::now() > deadline {
            return Err(format!(
                "ComfyUI wurde nach {}s nicht fertig — läuft der Job noch in der Queue?",
                JOB_TIMEOUT.as_secs()
            ));
        }
        tokio::time::sleep(POLL_INTERVAL).await;

        let res = http
            .get(format!("{base}/history/{prompt_id}"))
            .send()
            .await
            .map_err(|e| format!("History-Abfrage fehlgeschlagen: {e}"))?;
        if !res.status().is_success() {
            continue;
        }
        let history: serde_json::Value = match res.json().await {
            Ok(v) => v,
            Err(_) => continue,
        };
        let Some(entry) = history.get(prompt_id) else {
            continue; // still queued or running
        };

        // a failed run lands in history too, with status.completed == false
        if let Some(status) = entry.get("status") {
            if status.get("completed").and_then(|c| c.as_bool()) == Some(false) {
                let msg = status
                    .get("messages")
                    .map(|m| m.to_string())
                    .unwrap_or_default();
                return Err(format!("ComfyUI-Job fehlgeschlagen: {msg}"));
            }
        }

        let found = all_images(entry);
        if !found.is_empty() {
            return Ok(found);
        }
        // entry present but no images yet — keep waiting
    }
}

/// Every image the run saved, in a stable order.
///
/// Order is the whole point for a variant bake: it becomes the morph grid's
/// control surface, where cell 1 and cell 9 are opposite corners. Within one
/// save node the array is already the batch order; across several save nodes
/// the map keys are node ids, so they are sorted numerically — "10" would
/// otherwise sort before "3".
fn all_images(entry: &serde_json::Value) -> Vec<OutputRef> {
    let Some(outputs) = entry.get("outputs").and_then(|o| o.as_object()) else {
        return Vec::new();
    };
    let mut nodes: Vec<(&String, &serde_json::Value)> = outputs.iter().collect();
    nodes.sort_by_key(|(id, _)| {
        (id.parse::<u64>().unwrap_or(u64::MAX), (*id).clone())
    });

    let mut out = Vec::new();
    for (_node, value) in nodes {
        let Some(images) = value.get("images").and_then(|i| i.as_array()) else {
            continue;
        };
        for img in images {
            let Some(filename) = img.get("filename").and_then(|v| v.as_str()) else {
                continue;
            };
            // ComfyUI also lists previews here; those are not the result
            let kind = img
                .get("type")
                .and_then(|v| v.as_str())
                .unwrap_or("output");
            if kind == "temp" {
                continue;
            }
            out.push(OutputRef {
                filename: filename.to_string(),
                subfolder: img
                    .get("subfolder")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                kind: kind.to_string(),
            });
        }
    }
    out
}

/// Keep the uploaded name tame: it becomes a path inside ComfyUI's input
/// folder and is echoed straight back into the workflow JSON.
fn sanitize(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    let cleaned = cleaned.trim_matches('.').to_string();
    if cleaned.is_empty() {
        "vizzy_input.png".to_string()
    } else {
        format!("vizzy_{cleaned}")
    }
}

/// The filename is substituted into a JSON *string* before parsing, so it has
/// to survive as a JSON string body.
fn json_escape(s: &str) -> String {
    let encoded = serde_json::Value::String(s.to_string()).to_string();
    encoded[1..encoded.len() - 1].to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base_fills_in_scheme_and_default() {
        assert_eq!(base(""), "http://127.0.0.1:8188");
        assert_eq!(base("   "), "http://127.0.0.1:8188");
        assert_eq!(base("localhost:8188"), "http://localhost:8188");
        assert_eq!(base("http://box:8188/"), "http://box:8188");
        assert_eq!(base("https://comfy.example"), "https://comfy.example");
    }

    #[test]
    fn sanitize_keeps_names_inside_the_input_folder() {
        assert_eq!(sanitize("holiday.png"), "vizzy_holiday.png");
        // separators become underscores and the leading dots are trimmed, so
        // nothing can walk out of ComfyUI's input folder
        assert_eq!(sanitize("../../etc/passwd"), "vizzy__.._etc_passwd");
        assert!(!sanitize("../../etc/passwd").contains('/'));
        assert_eq!(sanitize("a b\"c.png"), "vizzy_a_b_c.png");
        assert_eq!(sanitize(""), "vizzy_input.png");
        assert_eq!(sanitize("..."), "vizzy_input.png");
    }

    #[test]
    fn json_escape_survives_reinsertion_into_the_template() {
        let template = format!(r#"{{"image": "{}"}}"#, IMAGE_TOKEN);
        let nasty = r#"sub/a"b\c.png"#;
        let filled = template.replace(IMAGE_TOKEN, &json_escape(nasty));
        let parsed: serde_json::Value = serde_json::from_str(&filled).unwrap();
        assert_eq!(parsed["image"], nasty);
    }

    #[test]
    fn all_images_reads_the_history_shape() {
        let entry = serde_json::json!({
            "outputs": {
                "9": { "images": [
                    { "filename": "d_00001_.png", "subfolder": "", "type": "output" }
                ]}
            }
        });
        let got = all_images(&entry);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].filename, "d_00001_.png");
        assert_eq!(got[0].kind, "output");
    }

    #[test]
    fn all_images_ignores_nodes_without_images_and_previews() {
        let entry = serde_json::json!({
            "outputs": {
                "7": { "text": ["nope"] },
                "8": { "images": [
                    { "filename": "preview.png", "subfolder": "", "type": "temp" }
                ]}
            }
        });
        assert!(all_images(&entry).is_empty());
    }

    /// A variant bake's order *is* the control surface, so it has to survive
    /// both the batch array and node ids that do not sort as strings.
    #[test]
    fn all_images_keeps_batch_order_and_sorts_nodes_numerically() {
        let img = |n: &str| {
            serde_json::json!({ "filename": n, "subfolder": "", "type": "output" })
        };
        let entry = serde_json::json!({
            "outputs": {
                "10": { "images": [img("second.png")] },
                "3":  { "images": [img("a.png"), img("b.png"), img("c.png")] }
            }
        });
        let names: Vec<_> = all_images(&entry)
            .into_iter()
            .map(|o| o.filename)
            .collect();
        assert_eq!(names, ["a.png", "b.png", "c.png", "second.png"]);
    }

    #[test]
    fn framing_round_trips() {
        let images = vec![vec![1u8, 2, 3], vec![], vec![9u8; 300]];
        let blob = frame_images(&images);
        assert_eq!(&blob[0..4], &3u32.to_le_bytes());
        assert_eq!(&blob[4..8], &3u32.to_le_bytes());
        assert_eq!(&blob[8..12], &0u32.to_le_bytes());
        assert_eq!(&blob[12..16], &300u32.to_le_bytes());
        assert_eq!(blob.len(), 4 + 12 + 3 + 0 + 300);
        assert_eq!(&blob[16..19], &[1, 2, 3]);
    }
}
