//! Live lyrics (spike): transcribes what is playing with a local Whisper
//! server, a couple of seconds behind the music.
//!
//! The analyzer hands its mono signal to [`TAP`] while the feature is on. A
//! worker drains it every `stepMs`, resamples to 16 kHz and sends the current
//! window (at most `maxWindow` seconds, see [`Tuning`]) to the server. Whisper is not a
//! streaming model, so the same audio gets transcribed several times while
//! the window grows. A segment counts as heard once two runs in a row agree
//! on it ("local agreement"); then it is committed and its audio leaves the
//! window. Everything not yet agreed on is the tentative tail.
//!
//! Whisper invents text over instrumentals, and whisper.cpp's
//! `no_speech_prob` stays at ~0 on music, so the filters are our own
//! (`docs/learnings.md`): known inventions ([Music], "Thank you." as the only
//! answer, "Музыка"), phrases looping more than four times, and a full
//! window drops its first segment unless the run before heard it as well.
//!
//! Server: whisper.cpp's `whisper-server` (`POST /inference`) or anything
//! OpenAI-compatible (`POST /v1/audio/transcriptions`, e.g. speaches) — a URL
//! ending in `/v1` takes the OpenAI route. Requests run here, not in the
//! webview (local servers send no CORS headers). Config lives in
//! `<app_data>/lyrics.json`.
//!
//! Output: the `lyrics` event for the frontend, and every committed line in
//! the dev bridge's `GET /log`, with how far behind the music it appeared.

use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager};

use crate::lyrics_take::{SongInfo, Take};

const FILE: &str = "lyrics.json";
/// what Whisper wants
const RATE: usize = 16000;
/// The tap never holds more than this (worker stalled ⇒ oldest audio goes).
const TAP_MAX_SECS: usize = 30;
/// history sent to the frontend; it decides how many to show
const LINES_KEPT: usize = 12;
/// lines of one song remembered for chorus detection
const HISTORY_MAX: usize = 400;
/// how alike two lines must be to count as the same line of a chorus —
/// looser than run-to-run agreement: Whisper hears a repeat a bit differently
const REPEAT_SIMILARITY: f32 = 0.7;

/// The song had this line before. Short lines ("oh", "yeah") repeat
/// everywhere and say nothing about a chorus, so they never count.
fn is_repeat(history: &[String], text: &str) -> bool {
    words(text).len() >= 3 && history.iter().any(|h| similar(h, text, REPEAT_SIMILARITY))
}
/// Segments Whisper itself doubts (whisper.cpp reports ~0 on music, so this
/// only ever fires on the OpenAI route).
const MAX_NO_SPEECH: f64 = 0.6;

/// The engine's knobs — in `lyrics.json` next to the server settings and
/// editable live from the settings drawer. Defaults are what measured best
/// (`docs/learnings.md`); [`Tuning::sane`] keeps hand-edited values in range.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Tuning {
    /// how often the window goes to Whisper
    step_ms: u32,
    /// no request before this much audio
    min_window: f32,
    /// longest window; reached without agreement, the first segment leaves
    max_window: f32,
    /// a segment ending this close to the window's end may still be cut off
    /// mid-word, so it is never committed
    edge: f32,
    /// share of common words for two runs to "agree" (word LCS)
    similarity: f32,
    /// the newest `silence_secs` this quiet (RMS) ⇒ pause: flush and start over
    silence_db: f32,
    silence_secs: f32,
    /// segments below this average log probability are dropped
    min_avg_logprob: f64,
    /// a phrase of 1–4 words repeated more often than this is cut there
    max_reps: usize,
    /// drop known inventions ([Music], "Thank you.", "Музыка", …)
    filter_inventions: bool,
    /// full window without agreement: drop the first segment unless the run
    /// before heard it too (off: commit it anyway)
    drop_unconfirmed: bool,
    /// initial prompt for Whisper, e.g. the song title or a few lyrics
    prompt: String,
}

impl Default for Tuning {
    fn default() -> Self {
        Self {
            step_ms: 500,
            min_window: 1.5,
            max_window: 12.0,
            edge: 0.7,
            similarity: 0.8,
            silence_db: -48.0,
            silence_secs: 1.5,
            min_avg_logprob: -1.2,
            max_reps: 4,
            filter_inventions: true,
            drop_unconfirmed: true,
            prompt: String::new(),
        }
    }
}

impl Tuning {
    fn sane(mut self) -> Self {
        self.step_ms = self.step_ms.clamp(100, 5000);
        self.max_window = self.max_window.clamp(3.0, 30.0);
        self.min_window = self.min_window.clamp(0.5, self.max_window - 1.0);
        self.edge = self.edge.clamp(0.0, 3.0);
        self.similarity = self.similarity.clamp(0.3, 1.0);
        self.silence_db = self.silence_db.clamp(-90.0, -10.0);
        self.silence_secs = self.silence_secs.clamp(0.3, 10.0);
        self.min_avg_logprob = self.min_avg_logprob.clamp(-5.0, 0.0);
        self.max_reps = self.max_reps.clamp(1, 20);
        self
    }

    fn step(&self) -> Duration {
        Duration::from_millis(self.step_ms as u64)
    }
}

// ---------------------------------------------------------------- the tap

/// Hand-over from the capture thread to the worker. The capture side only
/// ever `try_lock`s, so it never waits on the worker.
pub struct Tap {
    enabled: AtomicBool,
    buf: Mutex<TapBuf>,
}

struct TapBuf {
    rate: usize,
    samples: VecDeque<f32>,
}

pub static TAP: Tap = Tap {
    enabled: AtomicBool::new(false),
    buf: Mutex::new(TapBuf { rate: 0, samples: VecDeque::new() }),
};

impl Tap {
    pub fn enabled(&self) -> bool {
        self.enabled.load(Ordering::Relaxed)
    }

    /// Moves `block` into the tap. If the worker holds the lock right now the
    /// block stays where it is and goes with the next call (dropped after a
    /// second, which only happens if something is badly stuck).
    pub fn feed(&self, block: &mut Vec<f32>, rate: usize) {
        match self.buf.try_lock() {
            Ok(mut b) => {
                if b.rate != rate {
                    b.samples.clear();
                    b.rate = rate;
                }
                b.samples.extend(block.drain(..));
                let max = rate * TAP_MAX_SECS;
                if b.samples.len() > max {
                    let n = b.samples.len() - max;
                    b.samples.drain(..n);
                }
            }
            Err(_) if block.len() > rate => block.clear(),
            Err(_) => {}
        }
    }

    /// Everything collected so far; returns the sample rate (0 = nothing yet).
    fn take(&self, out: &mut Vec<f32>) -> usize {
        let mut b = self.buf.lock().unwrap();
        out.extend(b.samples.drain(..));
        b.rate
    }

    fn set(&self, on: bool) {
        self.enabled.store(on, Ordering::Relaxed);
        if !on {
            self.buf.lock().unwrap().samples.clear();
        }
    }
}

// ---------------------------------------------------------------- resampling

/// Low-pass (windowed sinc, cut at 7 kHz) plus linear interpolation down to
/// 16 kHz. From 48 kHz that is plain decimation by three; other device rates
/// (44.1 kHz inputs on macOS) work too.
struct Resampler {
    rate: usize,
    taps: Vec<f32>,
    hist: VecDeque<f32>,
    filtered: Vec<f32>,
    pos: f64,
}

impl Resampler {
    fn new(rate: usize) -> Self {
        const N: usize = 63;
        let fc = (7000.0 / rate as f64).min(0.5);
        let m = (N - 1) as f64 / 2.0;
        let mut taps: Vec<f32> = (0..N)
            .map(|i| {
                let x = i as f64 - m;
                let sinc = if x == 0.0 {
                    2.0 * fc
                } else {
                    (std::f64::consts::TAU * fc * x).sin() / (std::f64::consts::PI * x)
                };
                let hann = 0.5 - 0.5 * (std::f64::consts::TAU * i as f64 / (N - 1) as f64).cos();
                (sinc * hann) as f32
            })
            .collect();
        let sum: f32 = taps.iter().sum();
        taps.iter_mut().for_each(|t| *t /= sum);
        Self { rate, taps, hist: VecDeque::with_capacity(N), filtered: Vec::new(), pos: 0.0 }
    }

    fn process(&mut self, input: &[f32], out: &mut Vec<f32>) {
        for &x in input {
            if self.hist.len() == self.taps.len() {
                self.hist.pop_front();
            }
            self.hist.push_back(x);
            if self.hist.len() == self.taps.len() {
                let y: f32 = self.hist.iter().zip(&self.taps).map(|(a, b)| a * b).sum();
                self.filtered.push(y);
            }
        }
        let step = self.rate as f64 / RATE as f64;
        while self.pos + 1.0 < self.filtered.len() as f64 {
            let i = self.pos.floor() as usize;
            let f = (self.pos - i as f64) as f32;
            out.push(self.filtered[i] * (1.0 - f) + self.filtered[i + 1] * f);
            self.pos += step;
        }
        let used = (self.pos.floor() as usize).min(self.filtered.len());
        self.filtered.drain(..used);
        self.pos -= used as f64;
    }
}

fn rms_db(x: &[f32]) -> f32 {
    if x.is_empty() {
        return -120.0;
    }
    let ms = x.iter().map(|s| s * s).sum::<f32>() / x.len() as f32;
    10.0 * ms.max(1e-12).log10()
}

/// 16-bit mono PCM WAV at [`RATE`].
fn wav16(pcm: &[f32]) -> Vec<u8> {
    let data_len = (pcm.len() * 2) as u32;
    let mut w = Vec::with_capacity(44 + pcm.len() * 2);
    w.extend_from_slice(b"RIFF");
    w.extend_from_slice(&(36 + data_len).to_le_bytes());
    w.extend_from_slice(b"WAVEfmt ");
    w.extend_from_slice(&16u32.to_le_bytes());
    w.extend_from_slice(&1u16.to_le_bytes()); // PCM
    w.extend_from_slice(&1u16.to_le_bytes()); // mono
    w.extend_from_slice(&(RATE as u32).to_le_bytes());
    w.extend_from_slice(&(RATE as u32 * 2).to_le_bytes());
    w.extend_from_slice(&2u16.to_le_bytes());
    w.extend_from_slice(&16u16.to_le_bytes());
    w.extend_from_slice(b"data");
    w.extend_from_slice(&data_len.to_le_bytes());
    for s in pcm {
        w.extend_from_slice(&((s.clamp(-1.0, 1.0) * 32767.0) as i16).to_le_bytes());
    }
    w
}

// ---------------------------------------------------------------- text

#[derive(Clone, Debug, PartialEq, Serialize)]
struct Seg {
    /// seconds from the window start
    start: f32,
    end: f32,
    text: String,
}

fn words(s: &str) -> Vec<String> {
    s.to_lowercase()
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '\'' { c } else { ' ' })
        .collect::<String>()
        .split_whitespace()
        .map(String::from)
        .collect()
}

/// Two transcriptions of the same stretch, allowing a word to flip.
fn similar(a: &str, b: &str, min: f32) -> bool {
    let (a, b) = (words(a), words(b));
    if a.is_empty() || b.is_empty() {
        return a.is_empty() && b.is_empty();
    }
    // longest common subsequence of words
    let mut dp = vec![vec![0usize; b.len() + 1]; a.len() + 1];
    for i in 0..a.len() {
        for j in 0..b.len() {
            dp[i + 1][j + 1] = if a[i] == b[j] { dp[i][j] + 1 } else { dp[i][j + 1].max(dp[i + 1][j]) };
        }
    }
    2.0 * dp[a.len()][b.len()] as f32 / (a.len() + b.len()) as f32 >= min
}

/// What Whisper likes to "hear" in music that nobody sings.
fn hallucination(text: &str) -> bool {
    let t = text.trim();
    if words(t).is_empty() {
        return true; // only ♪, punctuation, …
    }
    let bracketed = (t.starts_with('[') && t.ends_with(']'))
        || (t.starts_with('(') && t.ends_with(')'))
        || (t.len() > 1 && t.starts_with('*') && t.ends_with('*'));
    if bracketed {
        return true; // [Music], (Applaus), *outro music*
    }
    // An instrumental part labelled in some language ("Музыка", "Sonido").
    const LABELS: &[&str] = &[
        "music", "musik", "musique", "música", "musica", "музыка", "muziek", "muzyka", "sonido", "sound", "instrumental",
    ];
    if let [w] = words(t).as_slice() {
        if LABELS.contains(&w.as_str()) {
            return true;
        }
    }
    let low = t.to_lowercase();
    const BLOCK: &[&str] = &[
        "thanks for watching",
        "thank you for watching",
        "subscribe",
        "subtitles by",
        "untertitel",
        "amara.org",
        "fürs zuschauen",
        "copyright",
        "www.",
    ];
    BLOCK.iter().any(|b| low.contains(b))
}

/// Drops ♪ and cuts a phrase of up to four words repeated over and over
/// (Whisper looping on "oh, oh, oh, …" or "I'm in, I'm in, …") down to
/// four repetitions.
fn clean(text: &str, max_reps: usize) -> String {
    let toks: Vec<&str> = text.split_whitespace().filter(|w| *w != "♪").collect();
    let key: Vec<Vec<String>> = toks.iter().map(|w| words(w)).collect();
    let mut out: Vec<&str> = Vec::new();
    let mut i = 0;
    while i < toks.len() {
        let mut skipped = false;
        for n in 1..=4 {
            if i + n > toks.len() {
                break;
            }
            // how often the phrase starting at i repeats back to back
            let mut reps = 1;
            while i + (reps + 1) * n <= toks.len()
                && (0..n).all(|k| key[i + k] == key[i + reps * n + k])
            {
                reps += 1;
            }
            if reps > max_reps {
                out.extend_from_slice(&toks[i..i + max_reps * n]);
                i += reps * n;
                skipped = true;
                break;
            }
        }
        if !skipped {
            out.push(toks[i]);
            i += 1;
        }
    }
    out.join(" ")
}

/// Segments of a verbose_json answer (whisper.cpp and OpenAI share the
/// shape), minus the ones Whisper doubts or invents. Without segments the
/// whole text becomes one segment over the window.
fn parse(v: &serde_json::Value, window: f32, t: &Tuning) -> Vec<Seg> {
    let invented = |text: &str| if t.filter_inventions { hallucination(text) } else { words(text).is_empty() };
    let Some(arr) = v["segments"].as_array() else {
        let text = clean(v["text"].as_str().unwrap_or(""), t.max_reps);
        return if invented(&text) {
            Vec::new()
        } else {
            vec![Seg { start: 0.0, end: window, text }]
        };
    };
    let segs: Vec<Seg> = arr
        .iter()
        .filter(|s| s["no_speech_prob"].as_f64().unwrap_or(0.0) <= MAX_NO_SPEECH)
        .filter(|s| s["avg_logprob"].as_f64().unwrap_or(0.0) >= t.min_avg_logprob)
        .filter_map(|s| {
            let text = clean(s["text"].as_str()?, t.max_reps);
            if invented(&text) {
                return None;
            }
            let start = s["start"].as_f64().unwrap_or(0.0) as f32;
            let end = s["end"].as_f64().unwrap_or(window as f64) as f32;
            Some(Seg { start, end: end.max(start), text })
        })
        .collect();
    if t.filter_inventions && only_filler(&segs) {
        return Vec::new();
    }
    segs
}

/// Seconds of music and all Whisper has to say is "Thank you." or "Bye." —
/// its favourite inventions over an instrumental. (whisper.cpp reports a
/// no_speech_prob of ~0 there, so that filter never fires.) As the whole
/// answer for a window this practically never is a sung line.
fn only_filler(segs: &[Seg]) -> bool {
    const FILLER: &[&str] = &[
        "thank you", "thank you very much", "thanks", "thanks for listening", "bye", "bye bye", "you", "so",
        "okay", "oh", "hmm", "uh", "danke", "vielen dank", "tschüss",
    ];
    let all = segs.iter().map(|s| s.text.as_str()).collect::<Vec<_>>().join(" ");
    let w = words(&all).join(" ");
    !segs.is_empty() && FILLER.contains(&w.as_str())
}

#[derive(Default)]
struct Agreement {
    /// the previous run's segments not committed yet
    prev: Vec<Seg>,
    /// recently committed lines, newest last
    lines: VecDeque<String>,
    /// per entry of `lines`: the song had this line before (a chorus)
    repeats: VecDeque<bool>,
    /// every line of the current song, for `repeats`
    history: Vec<String>,
    /// lines committed since start — tells the frontend which ones are new
    committed: u64,
    t: Tuning,
}

#[derive(Debug, Default)]
struct Step {
    commit: Vec<Seg>,
    /// seconds to drop from the start of the window
    cut: f32,
    tentative: String,
}

impl Agreement {
    fn step(&mut self, hyp: Vec<Seg>, window: f32) -> Step {
        let mut n = 0;
        while n < hyp.len()
            && n < self.prev.len()
            && hyp[n].end <= window - self.t.edge
            && similar(&hyp[n].text, &self.prev[n].text, self.t.similarity)
        {
            n += 1;
        }
        let mut cut = if n > 0 { hyp[n - 1].end } else { 0.0 };
        let mut skip = 0;
        if n == 0 && window >= self.t.max_window {
            // No agreement within the longest window we allow. The first
            // segment leaves the window either way: committed if the last run
            // heard it too (a held note kept it at the edge), dropped if not
            // — that is nearly always text invented over an instrumental.
            match hyp.first() {
                Some(first) => {
                    cut = first.end.clamp(1.0, (window - self.t.edge).max(1.0));
                    let heard = self.prev.first().is_some_and(|p| similar(&p.text, &first.text, self.t.similarity));
                    if heard || !self.t.drop_unconfirmed {
                        n = 1;
                    } else {
                        skip = 1;
                    }
                }
                None => cut = window - self.t.max_window / 2.0,
            }
        }
        let commit: Vec<Seg> = hyp[..n].iter().filter(|s| self.accept(&s.text)).cloned().collect();
        self.prev = hyp[n + skip..]
            .iter()
            .map(|s| Seg { start: (s.start - cut).max(0.0), end: (s.end - cut).max(0.0), text: s.text.clone() })
            .collect();
        let tentative = self.prev.iter().map(|s| s.text.as_str()).collect::<Vec<_>>().join(" ");
        Step { commit, cut, tentative }
    }

    /// Commits whatever is left (the music paused, the song ended).
    fn flush(&mut self) -> Vec<Seg> {
        let rest = std::mem::take(&mut self.prev);
        rest.into_iter().filter(|s| self.accept(&s.text)).collect()
    }

    /// A line sung twice in a row is a chorus; three times is Whisper
    /// looping.
    fn accept(&mut self, text: &str) -> bool {
        let n = self.lines.len();
        let sim = self.t.similarity;
        if n >= 2 && similar(&self.lines[n - 1], text, sim) && similar(&self.lines[n - 2], text, sim) {
            return false;
        }
        let repeat = is_repeat(&self.history, text);
        if self.history.len() < HISTORY_MAX {
            self.history.push(text.to_string());
        }
        self.lines.push_back(text.to_string());
        self.repeats.push_back(repeat);
        self.committed += 1;
        while self.lines.len() > LINES_KEPT {
            self.lines.pop_front();
            self.repeats.pop_front();
        }
        true
    }

    /// A new song: what came before is no chorus of this one.
    fn new_song(&mut self) {
        self.history.clear();
    }
}

// ---------------------------------------------------------------- config + worker

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct Config {
    enabled: bool,
    /// `http://127.0.0.1:8178` (whisper.cpp) or `http://…/v1` (OpenAI-compatible)
    url: String,
    /// `auto` or an ISO code (`de`, `en`)
    language: String,
    /// only for the OpenAI route
    model: String,
    /// transcript log (`lyrics_log.rs`): 0 off, 1 lines, 2 debug (every run)
    log: u8,
    /// also keep the 16 kHz audio Whisper heard, one file per song
    log_audio: bool,
    /// keep what was heard per song, with song times (`lyrics_take.rs`)
    takes: bool,
    /// send finished takes to Lyrics Helper: 0 never, 1 when it has no
    /// synced lyrics for the song, 2 always (the frontend acts on it)
    takes_upload: u8,
    #[serde(flatten)]
    tuning: Tuning,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            enabled: false,
            // tools/whisper-server/compose.yaml
            url: "http://127.0.0.1:8178".into(),
            language: "auto".into(),
            model: String::new(),
            log: 0,
            log_audio: false,
            takes: true,
            takes_upload: 0,
            tuning: Tuning::default(),
        }
    }
}

pub struct Lyrics {
    cfg: Mutex<Config>,
    path: Mutex<Option<PathBuf>>,
    /// set by `lyrics_reset`: the worker drops window and lines
    reset: AtomicBool,
    /// the song and its position, from the frontend's now playing
    song: Mutex<Playing>,
}

/// Where the media session is in the song, and when that was true.
#[derive(Clone, Copy)]
struct Pos {
    ms: f64,
    at: Instant,
    playing: bool,
}

#[derive(Clone)]
struct Playing {
    info: Option<SongInfo>,
    /// counts song changes — the same song played again is a change too
    gen: u64,
    /// when `gen` changed
    since: Instant,
    pos: Option<Pos>,
}

impl Playing {
    /// The song time at the moment `t` (usually a little in the past: when
    /// a line was sung), and whether the media position says so (`true`) or
    /// only the time since the song changed.
    fn song_ms_at(&self, t: Instant) -> (f64, bool) {
        let ms = |d: Duration| d.as_secs_f64() * 1000.0;
        match self.pos {
            Some(p) => {
                let d = if t >= p.at { ms(t - p.at) } else { -ms(p.at - t) };
                // paused: the position stands still from `at` on
                (p.ms + if p.playing { d } else { d.min(0.0) }, true)
            }
            None => (ms(t.saturating_duration_since(self.since)), false),
        }
    }
}

pub type Shared = Arc<Lyrics>;

pub fn new() -> Shared {
    Arc::new(Lyrics { cfg: Mutex::new(Config::default()), path: Mutex::new(None), reset: AtomicBool::new(false),
        song: Mutex::new(Playing { info: None, gen: 0, since: Instant::now(), pos: None }),
    })
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Update {
    lines: Vec<String>,
    /// per line: the song had it before (a chorus line)
    repeats: Vec<bool>,
    /// lines committed since start; `lines` ends with number `committed`
    committed: u64,
    tentative: String,
    /// how long after it was sung the newest line appeared
    behind_s: Option<f32>,
    /// how long ago the newest line started — synced lyrics set their clock by it
    started_ago_s: Option<f32>,
    infer_ms: u32,
    window_s: f32,
    error: Option<String>,
}

/// Reads the config and starts the worker.
pub fn spawn(app: tauri::AppHandle, me: Shared) {
    if let Ok(dir) = app.path().app_data_dir() {
        let path = dir.join(FILE);
        if let Some(mut cfg) = std::fs::read_to_string(&path).ok().and_then(|s| serde_json::from_str::<Config>(&s).ok()) {
            cfg.tuning = cfg.tuning.sane();
            *me.cfg.lock().unwrap() = cfg;
        }
        *me.path.lock().unwrap() = Some(path);
    }
    let cfg = me.cfg.lock().unwrap().clone();
    TAP.set(cfg.enabled);
    if cfg.enabled {
        eprintln!("[vizzy-lyrics] on, server {}", cfg.url);
    }
    tauri::async_runtime::spawn(run(app, me));
}

fn log(app: &tauri::AppHandle, line: String) {
    eprintln!("[vizzy-lyrics] {line}");
    if let Some(b) = app.try_state::<crate::bridge::Bridge>() {
        crate::bridge::push_log(&b, format!("[lyrics] {line}"));
    }
}

async fn transcribe(http: &reqwest::Client, cfg: &Config, pcm: &[f32]) -> Result<serde_json::Value, String> {
    use reqwest::multipart::{Form, Part};
    let part = Part::bytes(wav16(pcm)).file_name("audio.wav").mime_str("audio/wav").map_err(|e| e.to_string())?;
    let mut form = Form::new()
        .part("file", part)
        .text("response_format", "verbose_json")
        .text("temperature", "0");
    let prompt = cfg.tuning.prompt.trim();
    if !prompt.is_empty() {
        form = form.text("prompt", prompt.to_string());
    }
    let base = cfg.url.trim().trim_end_matches('/');
    let lang = cfg.language.trim();
    let url = if base.ends_with("/v1") {
        let model = if cfg.model.is_empty() { "whisper-1" } else { cfg.model.as_str() };
        form = form.text("model", model.to_string());
        if !lang.is_empty() && lang != "auto" {
            form = form.text("language", lang.to_string());
        }
        format!("{base}/audio/transcriptions")
    } else {
        // no temperature fallback: slower, and it is where the inventions come from
        form = form
            .text("temperature_inc", "0")
            .text("language", if lang.is_empty() { "auto".to_string() } else { lang.to_string() });
        format!("{base}/inference")
    };
    let res = http
        .post(url)
        .multipart(form)
        .send()
        .await
        .map_err(|e| format!("Whisper-Server nicht erreichbar: {e}"))?;
    if !res.status().is_success() {
        let status = res.status();
        let body = res.text().await.unwrap_or_default();
        return Err(format!("Whisper-Server antwortet {status}: {}", body.chars().take(200).collect::<String>()));
    }
    res.json().await.map_err(|e| format!("Antwort des Whisper-Servers unlesbar: {e}"))
}

/// For the log, through text: f32 knobs stay `0.7` instead of `0.699999988`
/// (`serde_json::to_value` widens f32 to f64).
fn clean_json<T: Serialize>(v: &T) -> serde_json::Value {
    serde_json::to_string(v).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
}

/// For the log: one decimal, without f32 → f64 noise (2.0999999…).
fn round1(x: f32) -> f64 {
    (x as f64 * 10.0).round() / 10.0
}

/// One step of the worker.
enum Tick {
    /// not enough audio yet
    Wait,
    /// the music paused; what was still tentative is final now (with how
    /// long ago each line ended, in seconds)
    Pause(Vec<(Seg, f32)>),
    Heard {
        /// with how far behind the music each line appeared, in seconds
        commit: Vec<(Seg, f32)>,
        tentative: String,
        window: f32,
        infer: Duration,
    },
}

/// The 16 kHz window and the agreement between runs: everything between
/// the resampled audio and the committed lines. The worker feeds it from the
/// tap, the offline test from a file.
#[derive(Default)]
struct Engine {
    win: Vec<f32>,
    agr: Agreement,
    /// the last run in detail, when the log is at debug level
    trace: Option<serde_json::Value>,
}

impl Engine {
    async fn tick(&mut self, http: &reqwest::Client, cfg: &Config) -> Result<Tick, String> {
        let t = &cfg.tuning;
        if self.agr.t != *t {
            self.agr.t = t.clone();
        }
        let quiet_from = self.win.len().saturating_sub((t.silence_secs * RATE as f32) as usize);
        if rms_db(&self.win[quiet_from..]) < t.silence_db {
            let window = self.win.len() as f32 / RATE as f32;
            let rest: Vec<(Seg, f32)> = self.agr.flush().into_iter().map(|s| { let ago = (window - s.end).max(0.0); (s, ago) }).collect();
            let had_audio = !self.win.is_empty();
            self.win.clear();
            return Ok(if rest.is_empty() && !had_audio { Tick::Wait } else { Tick::Pause(rest) });
        }
        let window = self.win.len() as f32 / RATE as f32;
        if window < t.min_window {
            return Ok(Tick::Wait);
        }
        let t0 = Instant::now();
        let v = match transcribe(http, cfg, &self.win).await {
            Ok(v) => v,
            Err(e) => {
                // don't let the window grow without bound while the server is away
                let max = (t.max_window * RATE as f32) as usize;
                if self.win.len() > max {
                    self.win.drain(..self.win.len() - max);
                }
                return Err(e);
            }
        };
        let infer = t0.elapsed();
        let kept = parse(&v, window, t);
        let debug = cfg.log >= 2;
        let heard = if debug { kept.clone() } else { Vec::new() };
        let step = self.agr.step(kept, window);
        // a shrunken max window (changed live) applies right away
        let over = window - t.max_window;
        // sung (window - end) before the request went out, final now
        let commit = step
            .commit
            .into_iter()
            .map(|s| {
                let behind = (window - s.end) + t0.elapsed().as_secs_f32();
                (s, behind)
            })
            .collect();
        let cut = ((step.cut.max(over) * RATE as f32) as usize).min(self.win.len());
        self.win.drain(..cut);
        let commit: Vec<(Seg, f32)> = commit;
        self.trace = debug.then(|| {
            // what Whisper said, before our filters — to tune them
            let raw: Vec<serde_json::Value> = match v["segments"].as_array() {
                Some(a) => a
                    .iter()
                    .map(|s| {
                        serde_json::json!({
                            "start": s["start"], "end": s["end"], "text": s["text"],
                            "avgLogprob": s["avg_logprob"], "noSpeechProb": s["no_speech_prob"],
                        })
                    })
                    .collect(),
                None => vec![serde_json::json!({ "text": v["text"] })],
            };
            serde_json::json!({
                "kind": "run",
                "windowS": round1(window),
                "inferMs": infer.as_millis() as u64,
                "language": v.get("language").or_else(|| v.get("detected_language")),
                "raw": raw,
                "kept": heard,
                "commit": commit.iter().map(|(s, b)| serde_json::json!({ "text": s.text, "behindS": round1(*b) })).collect::<Vec<_>>(),
                "tentative": step.tentative,
                "cutS": round1(cut as f32 / RATE as f32),
            })
        });
        Ok(Tick::Heard { commit, tentative: step.tentative, window, infer })
    }
}

async fn run(app: tauri::AppHandle, me: Shared) {
    let http = reqwest::Client::builder().timeout(Duration::from_secs(15)).build().expect("http client");
    let mut raw: Vec<f32> = Vec::new();
    let mut rs: Option<Resampler> = None;
    let mut eng = Engine::default();
    let mut last_err: Option<String> = None;
    let mut next = Instant::now() + me.cfg.lock().unwrap().tuning.step();
    let mut tlog = crate::lyrics_log::Log::new(app.path().app_data_dir().ok().map(|d| d.join(crate::lyrics_log::DIR)));
    let mut logged_tuning: Option<Tuning> = None;
    let takes_dir = app.path().app_data_dir().ok().map(|d| d.join(crate::lyrics_take::DIR));
    let mut take: Option<Take> = None;
    let mut last_gen = 0u64;
    // a pause is logged once, not on every quiet step
    let mut paused = true;
    // running stats, logged every 30 runs
    let (mut runs, mut infer_sum, mut infer_max) = (0u32, 0u128, 0u128);

    // `behind`: (seconds since the newest line ended, since it started)
    let emit = |eng: &Engine, tentative: String, behind: Option<(f32, f32)>, infer_ms: u32, window_s: f32, error: Option<String>| {
        let lines = eng.agr.lines.iter().cloned().collect();
        let repeats = eng.agr.repeats.iter().copied().collect();
        let committed = eng.agr.committed;
        let _ = app.emit("lyrics", Update {
            lines,
            repeats,
            committed,
            tentative,
            behind_s: behind.map(|b| b.0),
            started_ago_s: behind.map(|b| b.1),
            infer_ms,
            window_s,
            error,
        });
    };

    loop {
        tokio::time::sleep(next.saturating_duration_since(Instant::now())).await;
        let cfg = me.cfg.lock().unwrap().clone();
        let step = cfg.tuning.step();
        next += step;
        if next < Instant::now() {
            next = Instant::now() + step; // inference took longer than a step
        }
        if me.reset.swap(false, Ordering::Relaxed) {
            eng = Engine::default();
            emit(&eng, String::new(), None, 0, 0.0, None);
        }

        if !cfg.enabled {
            eng = Engine::default();
            rs = None;
            tlog.start(0, serde_json::Value::Null);
            logged_tuning = None;
            finish(&app, &mut take);
            continue;
        }
        // the transcript log: session start, song changes, knob changes
        let lv = cfg.log;
        let mut log_err = tlog.start(lv, clean_json(&cfg));
        if lv == 0 {
            logged_tuning = None;
        } else if logged_tuning.as_ref() != Some(&cfg.tuning) {
            if logged_tuning.is_some() {
                log_err = log_err.or(tlog.write(lv, 1, serde_json::json!({ "kind": "config", "config": clean_json(&cfg.tuning) })));
            }
            logged_tuning = Some(cfg.tuning.clone());
        }
        let playing = me.song.lock().unwrap().clone();
        let changed = playing.gen != last_gen;
        if changed {
            last_gen = playing.gen;
            eng.agr.new_song();
            finish(&app, &mut take);
        }
        let meta = match &playing.info {
            Some(i) => serde_json::json!({ "spotifyId": i.spotify_id, "durationMs": i.duration_ms }),
            None => serde_json::Value::Null,
        };
        tlog.set_song(lv, playing.info.as_ref().map(SongInfo::label), meta, changed);
        // the take of this song: started here, or when the switch goes on
        if !cfg.takes {
            finish(&app, &mut take);
        } else if let Some(info) = &playing.info {
            if let Some(t) = &mut take {
                t.update_song(info.clone());
            } else if let Some(dir) = &takes_dir {
                let engine = serde_json::json!({ "language": cfg.language, "model": cfg.model, "stepMs": cfg.tuning.step_ms, "maxWindow": round1(cfg.tuning.max_window) });
                take = Some(Take::new(dir.clone(), info.clone(), engine, crate::lyrics_log::now_ms()));
            }
        }
        // a line sung `ago` seconds back: its place in the song, unless it
        // was sung before this song began
        let song_time = |ago_end: f32, len: f32| -> Option<(f64, f64, bool)> {
            playing.info.as_ref()?;
            let end = Instant::now().checked_sub(Duration::from_secs_f32(ago_end.max(0.0)))?;
            if end < playing.since {
                return None;
            }
            let (end_ms, media) = playing.song_ms_at(end);
            Some(((end_ms - len.max(0.0) as f64 * 1000.0).max(0.0), end_ms.max(0.0), media))
        };
        raw.clear();
        let rate = TAP.take(&mut raw);
        if rate == 0 {
            continue;
        }
        if rs.as_ref().map(|r| r.rate) != Some(rate) {
            rs = Some(Resampler::new(rate));
            eng.win.clear();
        }
        let before = eng.win.len();
        rs.as_mut().unwrap().process(&raw, &mut eng.win);
        log_err = log_err.or(tlog.audio(cfg.log_audio, &eng.win[before..]));
        let fed_ms = ((eng.win.len() - before) * 1000 / RATE) as u64;

        let tick = eng.tick(&http, &cfg).await;
        if let (Some(t), Ok(Tick::Wait | Tick::Heard { .. })) = (&mut take, &tick) {
            t.heard(fed_ms);
        }
        match tick {
            Ok(Tick::Wait) => {}
            Ok(Tick::Pause(rest)) => {
                for (s, ago) in &rest {
                    log(&app, format!("{}   (at pause)", s.text));
                    let mut entry = serde_json::json!({ "kind": "line", "text": s.text, "atPause": true });
                    let repeat = eng.agr.history.iter().filter(|h| similar(h, &s.text, REPEAT_SIMILARITY)).count() > 1;
                    if let Some((start, end, media)) = song_time(*ago, s.end - s.start) {
                        timed(&mut entry, start, end, media);
                        if let Some(t) = &mut take {
                            t.add(&s.text, start, end, repeat, media);
                        }
                    }
                    log_err = log_err.or(tlog.write(lv, 1, entry));
                }
                keep(&app, &mut take);
                if !paused {
                    log_err = log_err.or(tlog.write(lv, 1, serde_json::json!({ "kind": "pause" })));
                }
                paused = true;
                emit(&eng, String::new(), None, 0, 0.0, None);
            }
            Ok(Tick::Heard { commit, tentative, window, infer }) => {
                paused = false;
                if last_err.take().is_some() {
                    log(&app, "server reachable again".into());
                }
                if let Some(trace) = eng.trace.take() {
                    log_err = log_err.or(tlog.write(lv, 2, trace));
                }
                for (s, b) in &commit {
                    log(&app, format!("{}   ({b:.1} s behind, whisper {} ms, window {window:.1} s)", s.text, infer.as_millis()));
                    let repeat = eng.agr.history.iter().filter(|h| similar(h, &s.text, REPEAT_SIMILARITY)).count() > 1;
                    let mut entry = serde_json::json!({
                        "kind": "line", "text": s.text, "behindS": round1(*b), "repeat": repeat,
                        "inferMs": infer.as_millis() as u64, "windowS": round1(window),
                    });
                    if let Some((start, end, media)) = song_time(*b, s.end - s.start) {
                        timed(&mut entry, start, end, media);
                        if let Some(t) = &mut take {
                            t.add(&s.text, start, end, repeat, media);
                        }
                    }
                    log_err = log_err.or(tlog.write(lv, 1, entry));
                }
                keep(&app, &mut take);
                let behind = commit.last().map(|(s, b)| (*b, *b + (s.end - s.start)));
                emit(&eng, tentative, behind, infer.as_millis() as u32, window, None);
                runs += 1;
                infer_sum += infer.as_millis();
                infer_max = infer_max.max(infer.as_millis());
                if runs == 30 {
                    log(&app, format!("stats: whisper avg {} ms, max {infer_max} ms over 30 runs", infer_sum / 30));
                    (runs, infer_sum, infer_max) = (0, 0, 0);
                }
            }
            Err(e) => {
                if last_err.as_deref() != Some(e.as_str()) {
                    log(&app, e.clone());
                    log_err = log_err.or(tlog.write(lv, 1, serde_json::json!({ "kind": "error", "error": e })));
                    emit(&eng, String::new(), None, 0, 0.0, Some(e.clone()));
                    last_err = Some(e);
                }
            }
        }
        if let Some(e) = log_err {
            log(&app, e);
        }
    }
}

/// Adds a line's place in the song to its log entry.
fn timed(entry: &mut serde_json::Value, start_ms: f64, end_ms: f64, media: bool) {
    if let Some(o) = entry.as_object_mut() {
        o.insert("startMs".into(), (start_ms.round() as u64).into());
        o.insert("endMs".into(), (end_ms.round() as u64).into());
        o.insert("clock".into(), if media { "media" } else { "songchange" }.into());
    }
}

/// Writes the take when there is something new worth keeping, and tells the
/// frontend's list when a file appears.
fn keep(app: &tauri::AppHandle, take: &mut Option<Take>) {
    let Some(t) = take else { return };
    match t.save() {
        Ok(true) => {
            log(app, format!("take started: {}", t.song.label()));
            let _ = app.emit("lyrics-takes", ());
        }
        Ok(false) => {}
        Err(e) => log(app, e),
    }
}

/// The song is over (or the switch went off): a last save, and the
/// frontend hears that this take is complete — it may upload it.
fn finish(app: &tauri::AppHandle, take: &mut Option<Take>) {
    keep(app, take);
    if let Some(name) = take.take().and_then(|t| t.name()) {
        let _ = app.emit("lyrics-take-done", name);
    }
}

#[tauri::command]
pub fn lyrics_config(me: tauri::State<'_, Shared>) -> Config {
    me.cfg.lock().unwrap().clone()
}

#[tauri::command]
pub fn lyrics_configure(mut cfg: Config, me: tauri::State<'_, Shared>) -> Result<Config, String> {
    cfg.tuning = cfg.tuning.sane();
    TAP.set(cfg.enabled);
    if let Some(path) = me.path.lock().unwrap().as_ref() {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        std::fs::write(path, serde_json::to_string_pretty(&cfg).unwrap()).map_err(|e| e.to_string())?;
    }
    *me.cfg.lock().unwrap() = cfg.clone();
    Ok(cfg)
}

/// The song now playing and where it is, from the frontend, which merges
/// the media session and Spotify. Labels the log and times the lines of a
/// take. `restart`: a song change, even if it is the same song again; the
/// frontend also calls this when it learns more (a Spotify id) or the
/// position jumps (seek, pause).
#[tauri::command]
pub fn lyrics_song(song: Option<SongInfo>, restart: bool, position_ms: Option<f64>, playing: bool, me: tauri::State<'_, Shared>) {
    let info = song.filter(|s| !s.title.trim().is_empty());
    let now = Instant::now();
    let mut p = me.song.lock().unwrap();
    if restart || p.info.as_ref().map(SongInfo::label) != info.as_ref().map(SongInfo::label) {
        p.gen += 1;
        p.since = now;
    }
    p.info = info;
    p.pos = position_ms.filter(|m| m.is_finite()).map(|ms| Pos { ms, at: now, playing });
}

/// Forgets the window and the lines heard so far (new song, or after
/// changing knobs, to see their effect from a clean start).
#[tauri::command]
pub fn lyrics_reset(me: tauri::State<'_, Shared>) {
    me.reset.store(true, Ordering::Relaxed);
}

/// Sends one second of silence to the server at `url` and says how long the
/// answer took, in milliseconds — the settings' "Verbindung testen".
#[tauri::command]
pub async fn lyrics_test(url: String, me: tauri::State<'_, Shared>) -> Result<u32, String> {
    let mut cfg = me.cfg.lock().unwrap().clone();
    cfg.url = url;
    let http = reqwest::Client::builder().timeout(Duration::from_secs(30)).build().map_err(|e| e.to_string())?;
    let t0 = Instant::now();
    transcribe(&http, &cfg, &vec![0.0; RATE]).await?;
    Ok(t0.elapsed().as_millis() as u32)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seg(start: f32, end: f32, text: &str) -> Seg {
        Seg { start, end, text: text.into() }
    }

    #[test]
    fn resamples_48k_to_16k_and_keeps_a_voice_band_tone() {
        let mut rs = Resampler::new(48000);
        let input: Vec<f32> = (0..48000).map(|i| (std::f32::consts::TAU * 1000.0 * i as f32 / 48000.0).sin() * 0.5).collect();
        let mut out = Vec::new();
        for chunk in input.chunks(480) {
            rs.process(chunk, &mut out);
        }
        assert!((out.len() as i32 - 16000).abs() < 40, "got {} samples", out.len());
        let db = rms_db(&out[1000..]);
        assert!((db - rms_db(&input)).abs() < 0.5, "level changed: {db}");
    }

    #[test]
    fn filters_what_lies_above_the_new_nyquist() {
        let mut rs = Resampler::new(48000);
        let input: Vec<f32> = (0..48000).map(|i| (std::f32::consts::TAU * 12000.0 * i as f32 / 48000.0).sin() * 0.5).collect();
        let mut out = Vec::new();
        rs.process(&input, &mut out);
        assert!(rms_db(&out[1000..]) < -40.0);
    }

    #[test]
    fn commits_only_after_two_runs_agree() {
        let mut a = Agreement::default();
        let s = a.step(vec![seg(0.0, 2.0, "Hello darkness my old friend"), seg(2.0, 3.5, "I've come")], 4.0);
        assert!(s.commit.is_empty());
        let s = a.step(
            vec![seg(0.0, 2.1, "Hello darkness, my old friend"), seg(2.1, 4.0, "I've come to talk")],
            5.0,
        );
        assert_eq!(s.commit.len(), 1);
        assert!((s.cut - 2.1).abs() < 1e-6);
        assert_eq!(s.tentative, "I've come to talk");
        // the remainder is now relative to the cut window
        assert!((a.prev[0].start - 0.0).abs() < 1e-6);
    }

    #[test]
    fn never_commits_at_the_edge() {
        let mut a = Agreement::default();
        a.step(vec![seg(0.0, 3.6, "with you")], 4.0);
        let s = a.step(vec![seg(0.0, 3.6, "with you")], 4.0);
        assert!(s.commit.is_empty());
    }

    #[test]
    fn a_full_window_forces_progress() {
        let mut a = Agreement::default();
        // heard before, held at the edge: committed
        a.step(vec![seg(0.0, 11.5, "aaa bbb")], 11.8);
        let s = a.step(vec![seg(0.0, 6.0, "aaa bbb"), seg(6.0, 11.5, "ccc")], 12.0);
        assert_eq!(s.commit.len(), 1);
        assert!((s.cut - 6.0).abs() < 1e-6);
        // nothing heard: only the tail stays
        let s = a.step(vec![], 12.0);
        assert!(s.commit.is_empty());
        assert!(s.cut > 0.0);
    }

    #[test]
    fn a_full_window_drops_what_was_heard_only_once() {
        let mut a = Agreement::default();
        a.step(vec![], 11.5);
        let s = a.step(vec![seg(0.0, 9.0, "Thank you."), seg(9.0, 11.5, "real")], 12.0);
        assert!(s.commit.is_empty());
        assert!((s.cut - 9.0).abs() < 1e-6);
        assert_eq!(s.tentative, "real");
    }

    #[test]
    fn tuning_can_keep_the_unconfirmed_and_stays_in_range() {
        let mut a = Agreement { t: Tuning { drop_unconfirmed: false, ..Tuning::default() }, ..Default::default() };
        a.step(vec![], 11.5);
        let s = a.step(vec![seg(0.0, 9.0, "first try"), seg(9.0, 11.5, "real")], 12.0);
        assert_eq!(s.commit.len(), 1);
        assert_eq!(a.committed, 1);

        let t = Tuning { step_ms: 1, min_window: 50.0, max_window: 99.0, similarity: 0.0, ..Tuning::default() }.sane();
        assert_eq!((t.step_ms, t.max_window, t.min_window, t.similarity), (100, 30.0, 29.0, 0.3));
        // flat in lyrics.json, old files without the knobs still load
        let c: Config = serde_json::from_str(r#"{"enabled":true,"stepMs":250}"#).unwrap();
        assert!(c.enabled && c.tuning.step_ms == 250 && c.tuning.max_window == 12.0);
    }

    #[test]
    fn marks_chorus_lines_but_not_short_fillers() {
        let mut a = Agreement::default();
        for l in ["We will rock you now", "Buddy you're a boy", "oh yeah", "we will rock you, now!", "oh yeah"] {
            assert!(a.accept(l));
        }
        assert_eq!(a.repeats.iter().copied().collect::<Vec<_>>(), [false, false, false, true, false]);
        a.new_song();
        a.accept("Buddy you're a boy");
        assert_eq!(a.repeats.back(), Some(&false));
    }

    #[test]
    fn cuts_a_looping_word() {
        assert_eq!(clean("Oh, oh, oh, oh, oh, oh, oh, yeah ♪", 4), "Oh, oh, oh, oh, yeah");
        assert_eq!(clean("I'm in, I'm in, I'm in, I'm in, I'm in, I'm in, I'm", 4), "I'm in, I'm in, I'm in, I'm in, I'm");
        assert_eq!(clean("Take on me, take on me", 4), "Take on me, take on me");
        assert!(hallucination("*outro music*"));
        assert!(hallucination("Музыка"));
        assert!(!hallucination("Musik ist mein Leben"));
    }

    #[test]
    fn a_third_repeat_is_whisper_looping() {
        let mut a = Agreement::default();
        assert!(a.accept("na na na"));
        assert!(a.accept("na na na"));
        assert!(!a.accept("na na na"));
        assert!(a.accept("hey jude"));
    }

    #[test]
    fn drops_doubtful_and_invented_segments() {
        let v = serde_json::json!({
            "text": "…",
            "segments": [
                { "start": 0.0, "end": 1.0, "text": " ♪ ♪", "no_speech_prob": 0.1 },
                { "start": 1.0, "end": 2.0, "text": " Thanks for watching!", "no_speech_prob": 0.1 },
                { "start": 2.0, "end": 3.0, "text": " [Music]" },
                { "start": 3.0, "end": 4.0, "text": " real words", "no_speech_prob": 0.9 },
                { "start": 4.0, "end": 5.0, "text": " ♪ Ich bin ein Gast ♪", "no_speech_prob": 0.2, "avg_logprob": -0.4 }
            ]
        });
        let segs = parse(&v, 6.0, &Tuning::default());
        assert_eq!(segs, vec![seg(4.0, 5.0, "Ich bin ein Gast")]);
    }

    #[test]
    fn a_window_of_only_filler_is_dropped() {
        let one = |t: &str| serde_json::json!({ "segments": [{ "start": 0.0, "end": 3.0, "text": t }] });
        assert!(parse(&one(" Thank you."), 4.0, &Tuning::default()).is_empty());
        assert!(parse(&one(" Bye."), 4.0, &Tuning::default()).is_empty());
        assert_eq!(parse(&one(" Bye, bye, Miss American Pie"), 4.0, &Tuning::default()).len(), 1);
        let two = serde_json::json!({ "segments": [
            { "start": 0.0, "end": 2.0, "text": " Say goodbye" },
            { "start": 2.0, "end": 3.0, "text": " bye" }
        ]});
        assert_eq!(parse(&two, 4.0, &Tuning::default()).len(), 2);
    }

    #[test]
    fn plain_text_answers_become_one_segment() {
        let segs = parse(&serde_json::json!({ "text": " la la land " }), 5.0, &Tuning::default());
        assert_eq!(segs, vec![seg(0.0, 5.0, "la la land")]);
    }

    #[test]
    fn song_time_follows_the_media_position() {
        let t0 = Instant::now();
        let s = |x: f32| Duration::from_secs_f32(x);
        let mut p = Playing { info: None, gen: 1, since: t0, pos: None };
        // no position: the time since the song changed, flagged as rough
        assert_eq!(p.song_ms_at(t0 + s(12.0)), (12_000.0, false));
        // playing, 60 s into the song at t0 + 10 s
        p.pos = Some(Pos { ms: 60_000.0, at: t0 + s(10.0), playing: true });
        assert_eq!(p.song_ms_at(t0 + s(13.0)), (63_000.0, true));
        assert_eq!(p.song_ms_at(t0 + s(8.0)), (58_000.0, true));
        // paused there: a line sung before the pause keeps its place, the
        // position stands still afterwards
        p.pos = Some(Pos { ms: 60_000.0, at: t0 + s(10.0), playing: false });
        assert_eq!(p.song_ms_at(t0 + s(8.0)), (58_000.0, true));
        assert_eq!(p.song_ms_at(t0 + s(15.0)), (60_000.0, true));
    }

    #[test]
    fn wav_header_matches_the_data() {
        let w = wav16(&[0.0; 160]);
        assert_eq!(w.len(), 44 + 320);
        assert_eq!(&w[0..4], b"RIFF");
        assert_eq!(u32::from_le_bytes(w[40..44].try_into().unwrap()), 320);
    }

    /// Plays a file through the engine against a live server, one second of
    /// audio per step, as fast as the server answers. The file is raw 16 kHz
    /// mono f32le:
    ///   ffmpeg -i song.mp3 -ss 30 -t 60 -ac 1 -ar 16000 -f f32le song.f32
    ///   VIZZY_LYRICS_FILE=song.f32 cargo test --lib lyrics_offline -- --ignored --nocapture
    /// Optional: VIZZY_LYRICS_URL, VIZZY_LYRICS_LANG, VIZZY_LYRICS_TUNING (JSON knobs).
    #[test]
    #[ignore]
    fn lyrics_offline() {
        let path = std::env::var("VIZZY_LYRICS_FILE").expect("VIZZY_LYRICS_FILE");
        let bytes = std::fs::read(&path).unwrap();
        let pcm: Vec<f32> = bytes.chunks_exact(4).map(|b| f32::from_le_bytes(b.try_into().unwrap())).collect();
        let mut cfg = Config::default();
        if let Ok(u) = std::env::var("VIZZY_LYRICS_URL") {
            cfg.url = u;
        }
        if let Ok(l) = std::env::var("VIZZY_LYRICS_LANG") {
            cfg.language = l;
        }
        // knobs as in lyrics.json, e.g. {"stepMs":300,"maxWindow":8}
        if let Ok(j) = std::env::var("VIZZY_LYRICS_TUNING") {
            cfg.tuning = serde_json::from_str::<Tuning>(&j).expect("VIZZY_LYRICS_TUNING").sane();
        }
        let rt = tokio::runtime::Builder::new_multi_thread().enable_all().build().unwrap();
        rt.block_on(async {
            let http = reqwest::Client::new();
            let mut eng = Engine::default();
            let (mut behind, mut infer): (Vec<f32>, Vec<u128>) = (Vec::new(), Vec::new());
            for (i, chunk) in pcm.chunks(RATE * cfg.tuning.step_ms as usize / 1000).enumerate() {
                eng.win.extend_from_slice(chunk);
                match eng.tick(&http, &cfg).await.unwrap() {
                    Tick::Heard { commit, window, infer: d, .. } => {
                        infer.push(d.as_millis());
                        let n = eng.agr.repeats.len();
                        let fresh = commit.len().min(n);
                        for (k, (s, b)) in commit.into_iter().enumerate() {
                            let rep = if eng.agr.repeats[n - fresh + k.min(fresh - 1)] { "↻" } else { " " };
                            println!("{:>5.1}s {rep} {:<60}  +{b:.1}s  (window {window:.1}s, {} ms)", (i + 1) as f32 * cfg.tuning.step().as_secs_f32(), s.text, d.as_millis());
                            behind.push(b);
                        }
                    }
                    Tick::Pause(rest) => rest.iter().for_each(|(s, _)| println!("{:>5.1}s  {:<60}  (pause)", (i + 1) as f32 * cfg.tuning.step().as_secs_f32(), s.text)),
                    Tick::Wait => {}
                }
            }
            for s in eng.agr.flush() {
                println!("  end  {}", s.text);
            }
            let avg = |v: &[f32]| v.iter().sum::<f32>() / v.len().max(1) as f32;
            infer.sort();
            println!(
                "lines {}, behind avg {:.1}s max {:.1}s, whisper median {} ms max {} ms",
                behind.len(),
                avg(&behind),
                behind.iter().cloned().fold(0.0, f32::max),
                infer.get(infer.len() / 2).unwrap_or(&0),
                infer.last().unwrap_or(&0)
            );
        });
    }
}
