//! The same chain as `comfy_mock.rs`, but against a *real* ComfyUI.
//!
//! The mock pins the wire format; only a real server pins the assumptions
//! behind it — that ComfyUI accepts the upload, that a prompt id comes back,
//! that `/history` eventually reports `completed`, and that `/view` hands
//! over the bytes. Opt in with the server's address:
//!
//! ```text
//! VIZZY_COMFY_URL=http://127.0.0.1:8188 cargo test --test comfy_live -- --ignored
//! ```
//!
//! Without the variable every test here skips, so the suite stays runnable
//! on a machine with no ComfyUI.

/// 8×8 PNG — ComfyUI only has to decode it, nothing here looks at pixels.
const PROBE: &[u8] = include_bytes!("probe.png");

/// Core nodes only, no checkpoint, no custom nodes: whatever install this
/// points at can run it.
const WORKFLOW: &str = r#"{
  "1": {"class_type": "LoadImage", "inputs": {"image": "__VIZZY_INPUT_IMAGE__", "upload": "image"}},
  "2": {"class_type": "ImageInvert", "inputs": {"image": ["1", 0]}},
  "3": {"class_type": "SaveImage", "inputs": {"images": ["2", 0], "filename_prefix": "vizzy_live_test"}}
}"#;

fn url_or_skip() -> Option<String> {
    match std::env::var("VIZZY_COMFY_URL") {
        Ok(u) if !u.trim().is_empty() => Some(u),
        _ => {
            eprintln!("skipped: set VIZZY_COMFY_URL to a running ComfyUI");
            None
        }
    }
}

macro_rules! url_or_skip {
    () => {
        match url_or_skip() {
            Some(u) => u,
            None => return,
        }
    };
}

#[tokio::test]
#[ignore = "needs a running ComfyUI; see the module docs"]
async fn ping_describes_a_real_install() {
    let url = url_or_skip!();
    let desc = vizzy_lib::comfy::ping(&url).await.expect("ping failed");
    eprintln!("ping: {desc}");
    assert!(!desc.trim().is_empty());
}

#[tokio::test]
#[ignore = "needs a running ComfyUI; see the module docs"]
async fn bake_round_trips_through_a_real_server() {
    let url = url_or_skip!();
    let images = vizzy_lib::comfy::bake(&url, WORKFLOW, PROBE.to_vec(), "vizzy probe.png")
        .await
        .expect("bake failed");

    assert_eq!(images.len(), 1, "one SaveImage node, one image back");
    // PNG magic — proof the bytes survived the framing, not just the count
    assert_eq!(&images[0][..8], b"\x89PNG\r\n\x1a\n", "not a PNG");
    eprintln!("bake returned {} bytes", images[0].len());
}

/// A filename the server must not take at face value. ComfyUI puts uploads
/// in its input directory by name, so the client sanitizes before sending.
#[tokio::test]
#[ignore = "needs a running ComfyUI; see the module docs"]
async fn hostile_filename_is_accepted_and_contained() {
    let url = url_or_skip!();
    let images = vizzy_lib::comfy::bake(&url, WORKFLOW, PROBE.to_vec(), "../../evil.png")
        .await
        .expect("bake failed");
    assert_eq!(images.len(), 1);
}

/// The realistic failure on a fresh install: the workflow names a node this
/// ComfyUI does not have. The message has to carry ComfyUI's own reason.
#[tokio::test]
#[ignore = "needs a running ComfyUI; see the module docs"]
async fn missing_node_surfaces_the_servers_own_error() {
    let url = url_or_skip!();
    let workflow = r#"{
      "1": {"class_type": "LoadImage", "inputs": {"image": "__VIZZY_INPUT_IMAGE__", "upload": "image"}},
      "2": {"class_type": "VizzyNodeThatCannotExist", "inputs": {"image": ["1", 0]}}
    }"#;
    let err = vizzy_lib::comfy::bake(&url, workflow, PROBE.to_vec(), "probe.png")
        .await
        .expect_err("a missing node must not succeed");
    eprintln!("error: {err}");
    assert!(err.contains("lehnt den Workflow ab"), "got {err}");
}
