//! Transcript log for live lyrics: what was heard, when, during which song —
//! for later processing and for tuning the engine.
//!
//! `<app_data>/lyrics-log/`:
//! - `YYYY-MM-DD.jsonl` (UTC date), one JSON object per line, `kind`:
//!   `session` (log started, with the config), `song` (with `spotifyId` and
//!   `durationMs` when known), `line` (a committed line with its lag and its
//!   time in the song, `startMs`/`endMs`), `pause`, `config` (knobs changed), and at the debug
//!   level `run` (every Whisper request: raw segments, what the filters kept,
//!   what was committed, the tentative tail), `position` (the media position
//!   the worker was told: song changes, seeks, pauses) and what the frontend
//!   adds through `lyrics_note`: `helper` (the timed text from Lyrics
//!   Helper), `match` (a heard line located in it, or not, and the clock
//!   offset that follows), `show` (a synced line went on screen), `event`
//!   (refrain, voice on/off).
//! - optionally the 16 kHz audio Whisper heard, one 16-bit mono WAV per
//!   song (`YYYYMMDD_HHMMSS <song>.wav`) — the same samples Whisper got, so
//!   it plays in any player and replays through the offline test
//!   (`VIZZY_LYRICS_FILE`, see `lyrics.rs`) with other knobs.
//!
//! Writing never stops the worker: errors are reported once and the entry is
//! dropped.

use serde_json::{json, Value};
use std::fs::{File, OpenOptions};
use std::io::{Seek, SeekFrom, Write};
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

pub const DIR: &str = "lyrics-log";

/// 0 = off, 1 = lines (song, line, pause), 2 = debug (also every run)
pub type Level = u8;

pub struct Log {
    dir: Option<PathBuf>,
    song: Option<String>,
    /// the open WAV and how many bytes of samples it holds
    audio: Option<(File, u32)>,
    /// the audio file belongs to this song (None = before the first song)
    audio_song: Option<Option<String>>,
    last_error: Option<String>,
    started: bool,
}

impl Log {
    pub fn new(dir: Option<PathBuf>) -> Self {
        Self { dir, song: None, audio: None, audio_song: None, last_error: None, started: false }
    }

    /// A new song: noted in the log, and the audio goes to a new file.
    /// `meta` (Spotify id, duration) goes into the `song` entry; `again`
    /// notes the song even when it has the same name (played once more).
    pub fn set_song(&mut self, level: Level, song: Option<String>, meta: Value, again: bool) {
        if song == self.song && !again {
            return;
        }
        self.song = song;
        if level >= 1 {
            let mut entry = json!({ "kind": "song", "song": self.song.clone() });
            if let (Some(e), Some(m)) = (entry.as_object_mut(), meta.as_object()) {
                e.extend(m.clone());
            }
            self.write(level, 1, entry);
        }
    }

    /// One entry; written when the configured `level` is at least `min`.
    /// Returns an error message the first time writing fails.
    pub fn write(&mut self, level: Level, min: Level, mut entry: Value) -> Option<String> {
        if level < min || level == 0 {
            return None;
        }
        let Some(dir) = &self.dir else { return None };
        let now = now_ms();
        if let Some(o) = entry.as_object_mut() {
            // a note from the frontend carries the time it was made
            if !o.contains_key("t") {
                o.insert("t".into(), json!(iso(now)));
            }
            if !o.contains_key("song") {
                o.insert("song".into(), json!(self.song));
            }
        }
        let path = dir.join(format!("{}.jsonl", &iso(now)[..10]));
        let res = std::fs::create_dir_all(dir)
            .and_then(|_| OpenOptions::new().create(true).append(true).open(&path))
            .and_then(|mut f| writeln!(f, "{entry}"));
        self.report(res.err().map(|e| format!("Lyrics-Protokoll: {e}")))
    }

    /// The first entry after the log was switched on.
    pub fn start(&mut self, level: Level, cfg: Value) -> Option<String> {
        if level == 0 {
            self.started = false;
            return None;
        }
        if self.started {
            return None;
        }
        self.started = true;
        self.write(level, 1, json!({ "kind": "session", "config": cfg }))
    }

    /// Appends audio Whisper heard (16 kHz mono), one WAV per song. The
    /// header's sizes are rewritten on every call, so the file is valid
    /// whenever the app stops.
    pub fn audio(&mut self, on: bool, pcm: &[f32]) -> Option<String> {
        if !on {
            self.audio = None;
            self.audio_song = None;
            return None;
        }
        let Some(dir) = self.dir.clone() else { return None };
        if self.audio_song.as_ref() != Some(&self.song) {
            self.audio = None;
            let stamp = iso(now_ms()).replace(['-', ':'], "").replace('T', "_");
            let name = match &self.song {
                Some(s) => format!("{} {}.wav", &stamp[..15], file_safe(s)),
                None => format!("{}.wav", &stamp[..15]),
            };
            let opened = std::fs::create_dir_all(&dir)
                .and_then(|_| OpenOptions::new().create(true).write(true).truncate(true).open(dir.join(name)))
                .and_then(|mut f| f.write_all(&wav_header(0)).map(|_| f));
            match opened {
                Ok(f) => self.audio = Some((f, 0)),
                Err(e) => return self.report(Some(format!("Lyrics-Audio: {e}"))),
            }
            self.audio_song = Some(self.song.clone());
        }
        if pcm.is_empty() {
            return None;
        }
        let (f, len) = self.audio.as_mut()?;
        let bytes: Vec<u8> = pcm.iter().flat_map(|s| ((s.clamp(-1.0, 1.0) * 32767.0) as i16).to_le_bytes()).collect();
        *len = len.saturating_add(bytes.len() as u32);
        let header = wav_header(*len);
        let res = f
            .write_all(&bytes)
            .and_then(|_| f.seek(SeekFrom::Start(0)))
            .and_then(|_| f.write_all(&header))
            .and_then(|_| f.seek(SeekFrom::End(0)).map(|_| ()));
        self.report(res.err().map(|e| format!("Lyrics-Audio: {e}")))
    }

    fn report(&mut self, err: Option<String>) -> Option<String> {
        match err {
            None => {
                self.last_error = None;
                None
            }
            Some(e) if self.last_error.as_deref() == Some(e.as_str()) => None,
            Some(e) => {
                self.last_error = Some(e.clone());
                Some(e)
            }
        }
    }
}

/// What the log's audio is: 16 kHz, mono, 16 bit.
pub(crate) const WAV_RATE: u32 = 16000;
pub(crate) const WAV_HEADER: usize = 44;

fn wav_header(data_len: u32) -> [u8; WAV_HEADER] {
    let mut h = [0u8; WAV_HEADER];
    h[0..4].copy_from_slice(b"RIFF");
    h[4..8].copy_from_slice(&(36 + data_len).to_le_bytes());
    h[8..16].copy_from_slice(b"WAVEfmt ");
    h[16..20].copy_from_slice(&16u32.to_le_bytes());
    h[20..22].copy_from_slice(&1u16.to_le_bytes()); // PCM
    h[22..24].copy_from_slice(&1u16.to_le_bytes()); // mono
    h[24..28].copy_from_slice(&WAV_RATE.to_le_bytes());
    h[28..32].copy_from_slice(&(WAV_RATE * 2).to_le_bytes());
    h[32..34].copy_from_slice(&2u16.to_le_bytes());
    h[34..36].copy_from_slice(&16u16.to_le_bytes());
    h[36..40].copy_from_slice(b"data");
    h[40..44].copy_from_slice(&data_len.to_le_bytes());
    h
}

pub(crate) fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// `2026-11-14T20:03:12.345Z` — UTC, so files and entries sort the same.
pub(crate) fn iso(ms: u64) -> String {
    let secs = ms / 1000;
    let (y, m, d) = civil_from_days((secs / 86_400) as i64);
    let s = secs % 86_400;
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{:03}Z", s / 3600, s / 60 % 60, s % 60, ms % 1000)
}

/// Days since 1970-01-01 → (year, month, day), proleptic Gregorian
/// (Howard Hinnant's algorithm).
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (yoe + era * 400 + if m <= 2 { 1 } else { 0 }, m, d)
}

pub(crate) fn file_safe(s: &str) -> String {
    let t: String = s
        .chars()
        .map(|c| if c.is_alphanumeric() || " -_.,()&'".contains(c) { c } else { '_' })
        .collect();
    t.trim().chars().take(80).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dates_and_names() {
        assert_eq!(iso(0), "1970-01-01T00:00:00.000Z");
        // 2026-11-14 20:03:12.345 UTC
        assert_eq!(iso(1_794_686_592_345), "2026-11-14T20:03:12.345Z");
        assert_eq!(iso(951_782_400_000), "2000-02-29T00:00:00.000Z");
        assert_eq!(file_safe("AC/DC – Thunder: Struck?"), "AC_DC _ Thunder_ Struck_");
    }

    #[test]
    fn writes_jsonl_and_audio_per_song() {
        let dir = std::env::temp_dir().join(format!("vizzy-lyrics-log-{}", now_ms()));
        let mut log = Log::new(Some(dir.clone()));
        log.start(2, json!({ "stepMs": 500 }));
        log.set_song(2, Some("Artist – Song".into()), json!({ "spotifyId": "abc" }), false);
        log.write(2, 1, json!({ "kind": "line", "text": "hello" }));
        log.write(1, 2, json!({ "kind": "run" })); // below the level: skipped
        log.audio(true, &[0.5, -0.5]);
        log.set_song(2, Some("Other – Song".into()), Value::Null, false);
        log.audio(true, &[0.25]);

        let mut files: Vec<_> = std::fs::read_dir(&dir).unwrap().map(|e| e.unwrap().file_name().into_string().unwrap()).collect();
        files.sort();
        let jsonl = files.iter().find(|f| f.ends_with(".jsonl")).unwrap();
        let text = std::fs::read_to_string(dir.join(jsonl)).unwrap();
        let kinds: Vec<String> = text.lines().map(|l| serde_json::from_str::<Value>(l).unwrap()["kind"].as_str().unwrap().to_string()).collect();
        assert_eq!(kinds, ["session", "song", "line", "song"]);
        assert!(text.contains(r#""song":"Artist – Song""#));
        assert!(text.contains(r#""spotifyId":"abc""#));
        let audio: Vec<_> = files.iter().filter(|f| f.ends_with(".wav")).collect();
        assert_eq!(audio.len(), 2);
        drop(log);
        let wav = std::fs::read(dir.join(audio[0])).unwrap();
        assert_eq!(wav.len(), 44 + 4);
        assert_eq!(u32::from_le_bytes(wav[40..44].try_into().unwrap()), 4);
        assert_eq!(i16::from_le_bytes(wav[44..46].try_into().unwrap()), 16383);
        std::fs::remove_dir_all(dir).ok();
    }
}
