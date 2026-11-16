//! A take: the lines heard during one song, with their time in the song —
//! one small JSON file per song in `<app_data>/lyrics-takes/`
//! (PLAN-aufnahme.md). Rough lyrics to refine later in Lyrics Helper.
//!
//! The transcript log (`lyrics_log.rs`) is for debugging and mixes
//! everything by day; a take is the clean product of one listen. It is
//! rewritten after every new line once it is worth keeping, so nothing is
//! lost when the app quits mid-song.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::PathBuf;

pub const DIR: &str = "lyrics-takes";
/// fewer lines than this is no take (zapped in, an instrumental)
const MIN_LINES: usize = 5;
/// …and so is less than this share of the song heard
const MIN_SHARE: f64 = 0.4;
/// without a known duration: at least this much audio heard
const MIN_HEARD_MS: u64 = 60_000;
/// a line this far before the previous one means the listener went back
const BACK_MS: f64 = 3_000.0;

/// What the frontend's now playing knows about the song.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct SongInfo {
    pub artist: String,
    pub title: String,
    pub spotify_id: Option<String>,
    pub duration_ms: Option<u64>,
}

impl SongInfo {
    /// "Artist – Title", as the log and the file names show the song
    pub fn label(&self) -> String {
        if self.artist.trim().is_empty() {
            self.title.clone()
        } else {
            format!("{} – {}", self.artist, self.title)
        }
    }
}

struct Line {
    text: String,
    start_ms: u64,
    end_ms: u64,
    repeat: bool,
    /// which pass over the song heard it (a seek back starts a new one)
    pass: u32,
}

pub struct Take {
    dir: PathBuf,
    /// set by the first save
    file: Option<PathBuf>,
    pub song: SongInfo,
    recorded_at: u64,
    /// every line was timed by the media position ("media"), or at least
    /// one only by the time since the song changed ("songchange")
    media_clock: bool,
    lines: Vec<Line>,
    pass: u32,
    last_start: Option<f64>,
    /// audio heard while this take ran, pauses left out
    heard_ms: u64,
    engine: Value,
    dirty: bool,
}

impl Take {
    pub fn new(dir: PathBuf, song: SongInfo, engine: Value, now_ms: u64) -> Self {
        Self {
            dir,
            file: None,
            song,
            recorded_at: now_ms,
            media_clock: true,
            lines: Vec::new(),
            pass: 0,
            last_start: None,
            heard_ms: 0,
            engine,
            dirty: false,
        }
    }

    /// A committed line, with its time in the song. Going back in the song
    /// replaces what an earlier pass heard there.
    pub fn add(&mut self, text: &str, start_ms: f64, end_ms: f64, repeat: bool, media_clock: bool) {
        let start_ms = start_ms.max(0.0);
        let end_ms = end_ms.max(start_ms);
        if self.last_start.is_some_and(|l| start_ms < l - BACK_MS) {
            self.pass += 1;
        }
        self.last_start = Some(start_ms);
        let (s, e, pass) = (start_ms as u64, end_ms as u64, self.pass);
        self.lines.retain(|l| l.pass == pass || l.end_ms <= s || l.start_ms >= e);
        let at = self.lines.partition_point(|l| l.start_ms <= s);
        self.lines.insert(at, Line { text: text.to_string(), start_ms: s, end_ms: e, repeat, pass });
        self.media_clock &= media_clock;
        self.dirty = true;
    }

    pub fn heard(&mut self, ms: u64) {
        self.heard_ms += ms;
    }

    /// The song got a Spotify id or a duration after it started.
    pub fn update_song(&mut self, song: SongInfo) {
        if self.song != song {
            self.song = song;
            self.dirty = true;
        }
    }

    fn worth_keeping(&self) -> bool {
        self.lines.len() >= MIN_LINES
            && match self.song.duration_ms {
                Some(d) if d > 0 => self.heard_ms as f64 >= d as f64 * MIN_SHARE,
                _ => self.heard_ms >= MIN_HEARD_MS,
            }
    }

    pub fn to_json(&self) -> Value {
        let from = self.lines.iter().map(|l| l.start_ms).min().unwrap_or(0);
        let to = self.lines.iter().map(|l| l.end_ms).max().unwrap_or(0);
        json!({
            "v": 1,
            "spotifyId": self.song.spotify_id,
            "artist": self.song.artist,
            "title": self.song.title,
            "durationMs": self.song.duration_ms,
            "recordedAt": crate::lyrics_log::iso(self.recorded_at),
            "clock": if self.media_clock { "media" } else { "songchange" },
            "coverage": { "fromMs": from, "toMs": to },
            "heardMs": self.heard_ms,
            "engine": self.engine,
            "lines": self.lines.iter().map(|l| json!({
                "text": l.text, "startMs": l.start_ms, "endMs": l.end_ms, "repeat": l.repeat,
            })).collect::<Vec<_>>(),
        })
    }

    /// Writes the file when the take is worth keeping and has changed.
    /// `Ok(true)` the first time the file appears.
    pub fn save(&mut self) -> Result<bool, String> {
        if !self.dirty || !self.worth_keeping() {
            return Ok(false);
        }
        let first = self.file.is_none();
        let path = match &self.file {
            Some(p) => p.clone(),
            None => {
                let stamp = crate::lyrics_log::iso(self.recorded_at).replace(['-', ':'], "").replace('T', "_");
                self.dir.join(format!("{} {}.json", &stamp[..15], crate::lyrics_log::file_safe(&self.song.label())))
            }
        };
        let err = |e: std::io::Error| format!("Lyrics-Aufnahme: {e}");
        std::fs::create_dir_all(&self.dir).map_err(err)?;
        let tmp = path.with_extension("tmp");
        std::fs::write(&tmp, serde_json::to_string_pretty(&self.to_json()).unwrap()).map_err(err)?;
        std::fs::rename(&tmp, &path).map_err(err)?;
        self.file = Some(path);
        self.dirty = false;
        Ok(first)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn song(duration_ms: Option<u64>) -> SongInfo {
        SongInfo { artist: "a-ha".into(), title: "Take On Me".into(), spotify_id: Some("2WfaOiMkCvy7F5fcp2zZ8L".into()), duration_ms }
    }

    fn take(name: &str, duration_ms: Option<u64>) -> (Take, PathBuf) {
        let dir = std::env::temp_dir().join(format!("vizzy-takes-{}-{name}", std::process::id()));
        std::fs::remove_dir_all(&dir).ok();
        (Take::new(dir.clone(), song(duration_ms), json!({ "language": "auto" }), 1_794_686_592_345), dir)
    }

    fn texts(t: &Take) -> Vec<String> {
        t.to_json()["lines"].as_array().unwrap().iter().map(|l| l["text"].as_str().unwrap().to_string()).collect()
    }

    #[test]
    fn nothing_is_written_for_a_song_barely_heard() {
        let (mut t, dir) = take("barely", Some(200_000));
        for i in 0..6 {
            t.add("line", i as f64 * 3000.0, i as f64 * 3000.0 + 2000.0, false, true);
        }
        t.heard(30_000); // 15 % of the song
        assert_eq!(t.save(), Ok(false));
        assert!(!dir.exists());
        t.heard(60_000); // 45 %
        assert_eq!(t.save(), Ok(true));
        // unchanged: no rewrite; a new line: rewritten, but not "first" again
        assert_eq!(t.save(), Ok(false));
        t.add("one more", 30_000.0, 32_000.0, true, true);
        assert_eq!(t.save(), Ok(false));
        let files: Vec<_> = std::fs::read_dir(&dir).unwrap().map(|e| e.unwrap().file_name().into_string().unwrap()).collect();
        assert_eq!(files, ["20261114_200312 a-ha _ Take On Me.json"]);
        let v: Value = serde_json::from_str(&std::fs::read_to_string(dir.join(&files[0])).unwrap()).unwrap();
        assert_eq!(v["spotifyId"], "2WfaOiMkCvy7F5fcp2zZ8L");
        assert_eq!(v["lines"].as_array().unwrap().len(), 7);
        assert_eq!(v["coverage"], json!({ "fromMs": 0, "toMs": 32_000 }));
        assert_eq!(v["clock"], "media");
        assert_eq!(v["lines"][6], json!({ "text": "one more", "startMs": 30_000, "endMs": 32_000, "repeat": true }));
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn without_a_duration_a_minute_of_audio_counts() {
        let (mut t, dir) = take("minute", None);
        for i in 0..5 {
            t.add("line", i as f64 * 3000.0, i as f64 * 3000.0 + 2000.0, false, false);
        }
        t.heard(59_000);
        assert_eq!(t.save(), Ok(false));
        t.heard(1_000);
        assert_eq!(t.save(), Ok(true));
        assert_eq!(t.to_json()["clock"], "songchange");
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn going_back_replaces_what_was_heard_there() {
        let (mut t, _) = take("back", None);
        t.add("one", 10_000.0, 12_000.0, false, true);
        t.add("two wrong", 13_000.0, 15_000.0, false, true);
        t.add("three", 16_000.0, 18_000.0, false, true);
        t.add("four", 19_000.0, 21_000.0, false, true);
        // back to 12.5 s: "two" and "three" are heard again
        t.add("two", 12_800.0, 15_200.0, false, true);
        assert_eq!(texts(&t), ["one", "two", "three", "four"]);
        t.add("three again", 16_100.0, 18_100.0, false, true);
        assert_eq!(texts(&t), ["one", "two", "three again", "four"]);
        // a line before the song starts (clock a bit off) is clamped
        t.add("early", -400.0, 900.0, false, true);
        assert_eq!(t.to_json()["lines"][0]["startMs"], 0);
    }
}
