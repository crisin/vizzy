//! Client for a local language model behind an OpenAI-compatible chat
//! endpoint — Ollama, LM Studio, llama.cpp's server all speak it. Runs here
//! rather than in the webview because those servers send no CORS headers.

use std::time::Duration;

#[derive(serde::Deserialize)]
pub struct ChatMessage {
    role: String,
    content: String,
}

fn base(url: &str) -> String {
    let u = url.trim().trim_end_matches('/');
    // accept both "http://host:11434" and ".../v1"
    u.trim_end_matches("/v1").to_string()
}

/// Model names the server offers (`GET /v1/models`).
#[tauri::command]
pub async fn llm_models(url: String) -> Result<Vec<String>, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;
    let res = client
        .get(format!("{}/v1/models", base(&url)))
        .send()
        .await
        .map_err(|e| format!("Server nicht erreichbar: {e}"))?;
    if !res.status().is_success() {
        return Err(format!("Server antwortet {}", res.status()));
    }
    let v: serde_json::Value = res.json().await.map_err(|e| e.to_string())?;
    Ok(v["data"]
        .as_array()
        .map(|a| a.iter().filter_map(|m| m["id"].as_str().map(String::from)).collect())
        .unwrap_or_default())
}

/// One chat completion; returns the assistant's text.
#[tauri::command]
pub async fn llm_chat(
    url: String,
    model: String,
    messages: Vec<ChatMessage>,
    temperature: Option<f32>,
) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(300))
        .build()
        .map_err(|e| e.to_string())?;
    let body = serde_json::json!({
        "model": model,
        "messages": messages.iter().map(|m| serde_json::json!({"role": m.role, "content": m.content})).collect::<Vec<_>>(),
        "temperature": temperature.unwrap_or(0.7),
        "stream": false,
    });
    let res = client
        .post(format!("{}/v1/chat/completions", base(&url)))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Server nicht erreichbar: {e}"))?;
    let status = res.status();
    let v: serde_json::Value = res.json().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("Server antwortet {status}: {}", v["error"]));
    }
    v["choices"][0]["message"]["content"]
        .as_str()
        .map(String::from)
        .ok_or_else(|| format!("unerwartete Antwort: {v}"))
}
