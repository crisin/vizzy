//! Drives the ComfyUI bake client against a stand-in server
//! (`tests/mock_comfy.py`) so the upload → queue → poll → download chain is
//! exercised for real, not just compiled. The mock runs no model; what is
//! under test is the transport and the error paths.
//!
//! Skipped when `python` is not on PATH.

use std::io::BufRead;
use std::process::{Child, Command, Stdio};

const WORKFLOW: &str = r#"{
  "1": {"class_type": "LoadImage", "inputs": {"image": "__VIZZY_INPUT_IMAGE__"}},
  "3": {"class_type": "SaveImage", "inputs": {"images": ["1", 0]}}
}"#;

struct Mock {
    child: Child,
    port: u16,
}

impl Drop for Mock {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn start_mock() -> Option<Mock> {
    let script = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/mock_comfy.py");
    let mut child = Command::new("python")
        .arg("-I") // isolated: no site dirs, no cwd on sys.path
        .arg(script)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;

    // the mock prints the port it bound to as its first line
    let stdout = child.stdout.take()?;
    let mut line = String::new();
    let mut reader = std::io::BufReader::new(stdout);
    reader.read_line(&mut line).ok()?;
    let port: u16 = line.trim().parse().ok()?;
    Some(Mock { child, port })
}

macro_rules! mock_or_skip {
    () => {
        match start_mock() {
            Some(m) => m,
            None => {
                eprintln!("skipping: python mock could not be started");
                return;
            }
        }
    };
}

#[tokio::test]
async fn ping_reports_the_install() {
    let mock = mock_or_skip!();
    let url = format!("http://127.0.0.1:{}", mock.port);
    let info = vizzy_lib::comfy::ping(&url).await.expect("ping");
    assert!(info.contains("0.3.99-mock"), "got {info}");
    assert!(info.contains("mock device"), "got {info}");
}

#[tokio::test]
async fn bake_uploads_queues_polls_and_downloads() {
    let mock = mock_or_skip!();
    let url = format!("http://127.0.0.1:{}", mock.port);
    let out = vizzy_lib::comfy::bake(&url, WORKFLOW, b"not-really-a-png".to_vec(), "holiday snap.png")
        .await
        .expect("bake");
    // the PNG the mock hands back, byte for byte
    assert_eq!(&out[..8], b"\x89PNG\r\n\x1a\n");
    assert!(out.len() > 20);
}

#[tokio::test]
async fn missing_placeholder_is_caught_before_anything_is_sent() {
    let mock = mock_or_skip!();
    let url = format!("http://127.0.0.1:{}", mock.port);
    let err = vizzy_lib::comfy::bake(&url, r#"{"1": {}}"#, vec![1, 2, 3], "x.png")
        .await
        .unwrap_err();
    assert!(err.contains("__VIZZY_INPUT_IMAGE__"), "got {err}");
}

#[tokio::test]
async fn invalid_workflow_json_is_reported_as_such() {
    let mock = mock_or_skip!();
    let url = format!("http://127.0.0.1:{}", mock.port);
    let err = vizzy_lib::comfy::bake(&url, "{ __VIZZY_INPUT_IMAGE__ ", vec![1], "x.png")
        .await
        .unwrap_err();
    assert!(err.contains("kein gültiges JSON"), "got {err}");
}

/// The common real-world failure: the workflow names a node the install does
/// not have. ComfyUI answers 400 with `node_errors`, and that detail is what
/// the user needs to see.
#[tokio::test]
async fn rejected_workflow_surfaces_comfy_node_errors() {
    let mock = mock_or_skip!();
    let url = format!("http://127.0.0.1:{}", mock.port);
    let workflow = r#"{
      "1": {"class_type": "LoadImage", "inputs": {"image": "__VIZZY_INPUT_IMAGE__"}},
      "2": {"class_type": "DoesNotExist", "inputs": {"image": ["1", 0]}}
    }"#;
    let err = vizzy_lib::comfy::bake(&url, workflow, vec![1], "x.png")
        .await
        .unwrap_err();
    assert!(err.contains("lehnt den Workflow ab"), "got {err}");
    assert!(err.contains("class not found"), "got {err}");
}

#[tokio::test]
async fn unreachable_server_fails_fast_and_says_where() {
    // port 1 is reserved and nothing listens there
    let err = vizzy_lib::comfy::ping("http://127.0.0.1:1").await.unwrap_err();
    assert!(err.contains("keine Verbindung"), "got {err}");
}
