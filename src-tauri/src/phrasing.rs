//! Beat grid, bar/phrase tracking and section detection.
//!
//! The onset detector in [`crate::audio`] answers "did something just hit?".
//! That is enough to make things flash, but not enough to act *musically* —
//! for that you need to know where you are in the bar and in the phrase, and
//! when the track moves on to a new part. This module turns the ragged stream
//! of onsets into a steady grid and counts along it.
//!
//! Three stages, each feeding the next:
//!
//! 1. **Grid (PLL).** Onsets nudge the phase and period of a free-running
//!    oscillator instead of being reported one by one. Between onsets the
//!    grid keeps ticking, so a missed kick or a busy fill does not lose the
//!    beat — and it yields a continuous phase, not just a trigger.
//! 2. **Downbeat.** Onset strength is accumulated per position in the bar;
//!    the position that collects the most low-end wins and becomes beat 1.
//! 3. **Sections.** A fast and a slow average of the spectrum are compared;
//!    when they diverge sharply the track has moved into a different part
//!    (drop, breakdown, new section) and the phrase counter re-anchors on the
//!    next downbeat.
//!
//! Everything is an estimate made from the music playing *right now* — no
//! lookahead, no prior knowledge of the track.

use std::collections::VecDeque;

pub const BEATS_PER_BAR: u64 = 4;
pub const BARS_PER_PHRASE: u64 = 8;
pub const BEATS_PER_PHRASE: u64 = BEATS_PER_BAR * BARS_PER_PHRASE; // 32

/// How hard a single onset pulls the grid's phase and period toward it.
/// Phase corrects quickly, period only creeps — tempo is the thing you least
/// want a stray snare to yank around.
const PHASE_GAIN: f32 = 0.18;
const PERIOD_GAIN: f32 = 0.012;

/// Tempo range the grid will hold, and the same bounds as seconds per beat —
/// which is the form the grid actually stores.
const MIN_BPM: f32 = 60.0;
const MAX_BPM: f32 = 200.0;
const MIN_PERIOD: f32 = 60.0 / MAX_BPM;
const MAX_PERIOD: f32 = 60.0 / MIN_BPM;

/// Confidence is measured as how tightly onset timings cluster on the
/// subdivision circle — map each onset's position within the beat onto a
/// circle that wraps once per eighth (and once per sixteenth), and average the
/// unit vectors. Hits that consistently land on a subdivision all point the
/// same way and the average is long; onsets scattered at random point
/// everywhere and cancel out to nearly nothing.
///
/// Several subdivisions are tracked and the best one wins: the eighth circle
/// tolerates loose timing, the sixteenth circle recognises a busy pattern that
/// the eighth circle would see as two opposing clusters, and the triplet
/// circle covers shuffle and swung grooves — which otherwise measured as
/// completely unlocked despite being perfectly in time.
const SYNC_SUBDIVS: [f32; 3] = [2.0, 3.0, 4.0];
const SYNC_RATE: f32 = 0.06;

/// Confidence starts fading after this long without an onset, but the grid
/// keeps counting: bars run on through a breakdown, and dropping the count
/// there would leave the phrase misaligned when the track comes back.
const SILENCE_TIMEOUT: f32 = 3.5;
/// Only after this long is the track considered stopped rather than quiet.
const RESET_TIMEOUT: f32 = 12.0;

/// Consecutive onsets the tempo estimator must disagree by an octave before
/// the grid throws away its lock. A single bad estimate resyncing the grid is
/// its own source of wobble.
const OCTAVE_STRIKES: u32 = 8;

/// Sections are never shorter than this — keeps one transition from firing
/// again a moment later as the new part settles.
const MIN_SECTION_S: f32 = 6.0;
const NOVELTY_HISTORY: usize = 560; // ~6 s of hops at 94 hops/s
const NOVELTY_SIGMA: f32 = 2.4;

pub struct Phrasing {
    // --- grid (PLL) ---
    period: f32,    // seconds per beat
    next_beat: f32, // analysis time at which the next grid beat is due
    beat_phase: f32,
    beat_count: u64,
    grid_conf: f32,
    /// (cos, sin) accumulators per entry in [`SYNC_SUBDIVS`].
    sync: [(f32, f32); SYNC_SUBDIVS.len()],
    last_onset: f32,
    running: bool,
    octave_strikes: u32,

    // --- downbeat ---
    bar_scores: [f32; BEATS_PER_BAR as usize],
    downbeat_off: u64,

    // --- phrase ---
    phrase_anchor: u64,
    rearm_phrase: bool,

    // --- sections ---
    fast: Vec<f32>,
    slow: Vec<f32>,
    nov_hist: VecDeque<f32>,
    section_env: f32,
    last_section: f32,
}

impl Phrasing {
    pub fn new(num_bands: usize) -> Self {
        Self {
            period: 0.5,
            next_beat: 0.0,
            beat_phase: 0.0,
            beat_count: 0,
            grid_conf: 0.0,
            sync: [(0.0, 0.0); SYNC_SUBDIVS.len()],
            last_onset: -1000.0,
            running: false,
            octave_strikes: 0,
            bar_scores: [0.0; BEATS_PER_BAR as usize],
            downbeat_off: 0,
            phrase_anchor: 0,
            rearm_phrase: false,
            fast: vec![0.0; num_bands],
            slow: vec![0.0; num_bands],
            nov_hist: VecDeque::with_capacity(NOVELTY_HISTORY),
            section_env: 0.0,
            last_section: -1000.0,
        }
    }

    /// Feed a detected onset. `bpm` / `bpm_conf` are the independent tempo
    /// estimate (0 when it has none yet), `strength` the onset's bass-weighted
    /// flux.
    pub fn on_onset(&mut self, t: f32, bpm: f32, bpm_conf: f32, strength: f32) {
        self.last_onset = t;

        if bpm > 40.0 {
            let p = (60.0 / bpm).clamp(MIN_PERIOD, MAX_PERIOD);

            // Cold start: adopt the estimate and put a grid line on this onset.
            if !self.running {
                self.period = p;
                self.next_beat = t + p;
                self.beat_phase = 0.0;
                self.grid_conf = 0.0;
                self.sync = [(0.0, 0.0); SYNC_SUBDIVS.len()];
                self.octave_strikes = 0;
                self.running = true;
                return;
            }

            // The estimator says we are tracking the wrong octave (half or
            // double time). Throwing the lock away on one reading makes the
            // grid jump around, so it has to say so repeatedly and be sure of
            // itself before we act.
            if (self.period / p).log2().abs() > 0.35 {
                self.octave_strikes += 1;
                if self.octave_strikes >= OCTAVE_STRIKES && bpm_conf > 0.5 {
                    self.period = p;
                    self.next_beat = t + p;
                    // the clustering evidence describes the grid we just threw
                    // away, so it has to be earned again on the new one
                    self.grid_conf = 0.0;
                    self.sync = [(0.0, 0.0); SYNC_SUBDIVS.len()];
                    self.octave_strikes = 0;
                    return;
                }
            } else {
                self.octave_strikes = 0;
            }
        }
        if !self.running {
            return;
        }

        // Where did this onset land relative to the grid? `raw` counts beats
        // from the most recent grid line, so the distance to the nearest whole
        // number is how far it sits from a beat.
        let last_beat = self.next_beat - self.period;
        let raw = (t - last_beat) / self.period;
        let k = raw.round();
        let to_beat = (raw - k).abs(); // 0 = on the beat, 0.5 = exactly between

        // Confidence: how tightly onsets cluster on the subdivision circles.
        // Judging them by distance to the nearest *beat* is what pinned this
        // near zero on real music — half the hits in a groove sit between
        // beats and are perfectly in time.
        let frac = raw - raw.floor();
        for (acc, &sub) in self.sync.iter_mut().zip(SYNC_SUBDIVS.iter()) {
            let (s, c) = (std::f32::consts::TAU * (frac * sub).fract()).sin_cos();
            acc.0 += (c - acc.0) * SYNC_RATE;
            acc.1 += (s - acc.1) * SYNC_RATE;
        }
        self.grid_conf = self
            .sync
            .iter()
            .map(|(c, s)| (c * c + s * s).sqrt())
            .fold(0.0f32, f32::max);

        // Only onsets near an actual beat may move the grid. An off-beat hit
        // is half a beat from a grid line, and letting it correct the phase
        // drags the grid a little further off with every hit. The window is
        // wide while searching for a lock and tightens once we have one.
        let capture = if self.grid_conf > 0.5 { 0.18 } else { 0.3 };
        if to_beat < capture {
            let err = (raw - k) * self.period;
            self.next_beat += err * PHASE_GAIN;
            if to_beat < 0.12 {
                self.period = (self.period + err * PERIOD_GAIN).clamp(MIN_PERIOD, MAX_PERIOD);
            }

            // Downbeat evidence: credit this onset's weight to the bar
            // position it belongs to. Over a few bars the kick pattern makes
            // beat 1 stand out — imperfect on tracks with a four-on-the-floor
            // kick, which is why the phrase counter also re-anchors on
            // section changes.
            let idx = (self.beat_count as i64 + k as i64).rem_euclid(BEATS_PER_BAR as i64);
            self.bar_scores[idx as usize] += strength * (1.0 - to_beat);

            // A plain argmax flips the downbeat back and forth whenever two
            // positions score within a hair of each other — and every flip
            // jumps the bar and phrase position. The new leader has to be
            // clearly ahead before the "one" moves.
            let (best, score) = self
                .bar_scores
                .iter()
                .enumerate()
                .max_by(|a, b| a.1.partial_cmp(b.1).unwrap())
                .map(|(i, s)| (i as u64, *s))
                .unwrap_or((0, 0.0));
            if score > self.bar_scores[self.downbeat_off as usize] * 1.15 {
                self.downbeat_off = best;
            }
        }
    }

    /// Advance one analysis hop. `t` is analysis time in seconds, `dt` the hop
    /// duration, `bands` the current spectrum.
    pub fn advance(&mut self, t: f32, dt: f32, bands: &[f32]) {
        self.advance_grid(t);
        self.advance_sections(t, dt, bands);
        self.section_env *= (-dt / 0.4).exp();
    }

    fn advance_grid(&mut self, t: f32) {
        if !self.running {
            self.beat_phase = 0.0;
            return;
        }

        let quiet_for = t - self.last_onset;
        if quiet_for > RESET_TIMEOUT {
            // Long enough that the track is stopped, not just quiet.
            self.running = false;
            self.grid_conf = 0.0;
            return;
        }
        if quiet_for > SILENCE_TIMEOUT {
            // A breakdown with nothing to lock onto. Keep counting — the bars
            // carry on underneath and the phrase must still line up when the
            // beat returns — but say out loud that we are flying blind.
            self.grid_conf *= 0.995;
        }

        // A long stall (device switch, buffer gap) would otherwise be walked
        // off one period at a time.
        if t - self.next_beat > self.period * 8.0 {
            self.next_beat = t + self.period;
            self.grid_conf *= 0.5;
        }

        while t >= self.next_beat {
            self.next_beat += self.period;
            self.beat_count += 1;
            self.on_grid_beat();
        }

        let since = t - (self.next_beat - self.period);
        self.beat_phase = (since / self.period).clamp(0.0, 1.0);
    }

    fn on_grid_beat(&mut self) {
        // Let old evidence fade so a changed groove can win the downbeat back.
        for s in self.bar_scores.iter_mut() {
            *s *= 0.992;
        }
        // A section change re-anchors the phrase, but only once the next
        // downbeat comes around — phrases start on beat 1, not mid-bar.
        if self.rearm_phrase && self.beat_in_bar() == 0 {
            self.phrase_anchor = self.beat_count;
            self.rearm_phrase = false;
        }
    }

    fn advance_sections(&mut self, t: f32, dt: f32, bands: &[f32]) {
        if self.fast.len() != bands.len() {
            self.fast = vec![0.0; bands.len()];
            self.slow = vec![0.0; bands.len()];
        }
        // Two running averages of the same spectrum at very different speeds:
        // "what is playing now" against "what this part of the track sounds
        // like". They only drift apart when the music actually changes.
        let fast_a = 1.0 - (-dt / 0.35).exp();
        let slow_a = 1.0 - (-dt / 4.0).exp();
        let mut dot = 0.0f32;
        let mut nf = 0.0f32;
        let mut ns = 0.0f32;
        for ((f, s), &b) in self
            .fast
            .iter_mut()
            .zip(self.slow.iter_mut())
            .zip(bands.iter())
        {
            *f += (b - *f) * fast_a;
            *s += (b - *s) * slow_a;
            dot += *f * *s;
            nf += *f * *f;
            ns += *s * *s;
        }

        // Shape change (cosine distance) plus overall level change, so both a
        // new timbre and a drop into near-silence register.
        let cos = dot / (nf.sqrt() * ns.sqrt() + 1e-6);
        let energy = ((nf.sqrt() + 1e-3) / (ns.sqrt() + 1e-3)).log2().abs();
        let novelty = (1.0 - cos).max(0.0) * 3.0 + energy * 0.6;

        if self.nov_hist.len() == NOVELTY_HISTORY {
            self.nov_hist.pop_front();
        }
        self.nov_hist.push_back(novelty);
        if self.nov_hist.len() < NOVELTY_HISTORY / 2 {
            return; // not enough history to judge what "unusual" means yet
        }

        let n = self.nov_hist.len() as f32;
        let mean = self.nov_hist.iter().sum::<f32>() / n;
        let var = self.nov_hist.iter().map(|v| (v - mean).powi(2)).sum::<f32>() / n;
        let std = var.sqrt();

        if novelty > mean + NOVELTY_SIGMA * std
            && novelty > 0.05
            && t - self.last_section > MIN_SECTION_S
        {
            self.section_env = 1.0;
            self.last_section = t;
            self.rearm_phrase = true;
            // Adopt the new material as the reference, or the same transition
            // keeps looking novel for the next few seconds.
            self.slow.copy_from_slice(&self.fast);
        }
    }

    fn beat_in_bar(&self) -> u64 {
        (self.beat_count % BEATS_PER_BAR + BEATS_PER_BAR - self.downbeat_off) % BEATS_PER_BAR
    }

    fn beat_in_phrase(&self) -> u64 {
        self.beat_count.saturating_sub(self.phrase_anchor) % BEATS_PER_PHRASE
    }

    /// Position between the last and the next grid beat, 0…1.
    pub fn beat_phase(&self) -> f32 {
        self.beat_phase
    }

    /// Grid beats counted since start — the integer part is a beat index, so
    /// the frontend can trigger on exact multiples ("every 16 beats").
    pub fn beat_count(&self) -> f32 {
        self.beat_count as f32
    }

    /// Position within the 4-beat bar, 0…1 (0 = downbeat).
    pub fn bar_phase(&self) -> f32 {
        (self.beat_in_bar() as f32 + self.beat_phase) / BEATS_PER_BAR as f32
    }

    /// Position within the 32-beat phrase, 0…1.
    pub fn phrase_phase(&self) -> f32 {
        (self.beat_in_phrase() as f32 + self.beat_phase) / BEATS_PER_PHRASE as f32
    }

    /// Decaying pulse, 1.0 at the moment a new section is detected.
    pub fn section(&self) -> f32 {
        self.section_env
    }

    /// How well onsets agree with the grid, 0…1. Below ~0.3 the bar and
    /// phrase numbers are guesses and should not drive hard cuts.
    pub fn grid_conf(&self) -> f32 {
        if self.running {
            self.grid_conf
        } else {
            0.0
        }
    }

    /// Let the published values fall back toward rest during silence.
    pub fn decay(&mut self) {
        self.section_env *= 0.8;
        self.grid_conf *= 0.9;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const HOP_S: f32 = 512.0 / 48000.0;

    /// Run the tracker over `secs` of onsets placed on a grid of `per_beat`
    /// events per beat. `jitter` displaces each onset (seconds), `drop_every`
    /// silences every n-th one — both stand in for a real detector's mistakes.
    fn run_subdiv(
        bpm: f32,
        secs: f32,
        per_beat: u32,
        jitter: impl Fn(u32) -> f32,
        drop_every: u32,
    ) -> Phrasing {
        let mut p = Phrasing::new(8);
        let step = 60.0 / bpm / per_beat as f32;
        let bands = [0.4f32; 8];
        let mut t = 0.0f32;
        let mut onset = 0u32;
        while t < secs {
            let due = onset as f32 * step + jitter(onset);
            if t >= due {
                if drop_every == 0 || !onset.is_multiple_of(drop_every) {
                    // on-beat hits carry more weight, as a kick would
                    let strength = if onset.is_multiple_of(per_beat) { 1.0 } else { 0.4 };
                    p.on_onset(due, bpm, 0.8, strength);
                }
                onset += 1;
            }
            p.advance(t, HOP_S, &bands);
            t += HOP_S;
        }
        p
    }

    fn run(bpm: f32, secs: f32, jitter: impl Fn(u32) -> f32, drop_every: u32) -> Phrasing {
        run_subdiv(bpm, secs, 1, jitter, drop_every)
    }

    #[test]
    fn locks_onto_a_steady_pulse() {
        let p = run(128.0, 20.0, |_| 0.0, 0);
        assert!(p.grid_conf() > 0.8, "grid_conf was {}", p.grid_conf());
        // 20 s at 128 BPM is 42.7 beats; the grid must not have drifted a beat
        let expected = 20.0 / (60.0 / 128.0);
        assert!(
            (p.beat_count() - expected).abs() <= 1.0,
            "counted {} beats, expected ~{expected}",
            p.beat_count()
        );
    }

    #[test]
    fn rides_through_jitter_and_missing_onsets() {
        // ±12 ms of timing noise, and every 4th onset never detected
        let jitter = |i: u32| ((i as f32 * 12.9898).sin() * 0.012).clamp(-0.012, 0.012);
        let p = run(174.0, 20.0, jitter, 4);
        assert!(p.grid_conf() > 0.5, "grid_conf was {}", p.grid_conf());
        let expected = 20.0 / (60.0 / 174.0);
        assert!(
            (p.beat_count() - expected).abs() <= 2.0,
            "counted {} beats, expected ~{expected}",
            p.beat_count()
        );
    }

    #[test]
    fn phases_stay_in_range_and_advance_together() {
        let p = run(120.0, 12.0, |_| 0.0, 0);
        for v in [p.beat_phase(), p.bar_phase(), p.phrase_phase(), p.grid_conf()] {
            assert!((0.0..=1.0).contains(&v), "out of range: {v}");
        }
        // bar phase must be the beat phase folded into a 4-beat window
        let within_bar = (p.bar_phase() * 4.0).fract();
        assert!(
            (within_bar - p.beat_phase()).abs() < 0.02,
            "bar {} vs beat {}",
            p.bar_phase(),
            p.beat_phase()
        );
    }

    /// The regression test for the bug that showed up on a real DJ set: with
    /// hits on every eighth, half of them sit exactly between two beats. Those
    /// used to be scored as disagreement *and* allowed to correct the phase,
    /// so the grid was dragged around and the confidence sat near 0.06 while
    /// every synthetic on-the-beat test passed.
    #[test]
    fn locks_on_when_half_the_onsets_are_off_the_beat() {
        let p = run_subdiv(126.0, 25.0, 2, |_| 0.0, 0);
        assert!(p.grid_conf() > 0.6, "grid_conf was {}", p.grid_conf());
        let expected = 25.0 / (60.0 / 126.0);
        assert!(
            (p.beat_count() - expected).abs() <= 1.0,
            "counted {} beats, expected ~{expected} — the grid wandered",
            p.beat_count()
        );
    }

    /// Sixteenths on top of the beat: a busy drum pattern must not shake the
    /// grid loose either.
    #[test]
    fn survives_a_busy_sixteenth_pattern() {
        let jitter = |i: u32| ((i as f32 * 7.13).sin() * 0.008).clamp(-0.008, 0.008);
        let p = run_subdiv(140.0, 25.0, 4, jitter, 7);
        assert!(p.grid_conf() > 0.5, "grid_conf was {}", p.grid_conf());
        let expected = 25.0 / (60.0 / 140.0);
        assert!(
            (p.beat_count() - expected).abs() <= 2.0,
            "counted {} beats, expected ~{expected}",
            p.beat_count()
        );
    }

    /// The other half of the confidence contract: onsets with no metrical
    /// relationship to the grid must read as *not* locked. Without this a
    /// permissive measure would just report "locked" for everything.
    #[test]
    fn unmetrical_onsets_do_not_read_as_locked() {
        let mut p = Phrasing::new(8);
        let bands = [0.4f32; 8];
        let mut t = 0.0f32;
        let mut next = 0.0f32;
        let mut i = 0u32;
        while t < 30.0 {
            if t >= next {
                p.on_onset(next, 120.0, 0.8, 1.0);
                // irregular spacing, unrelated to any 120 BPM subdivision
                let r = ((i as f32 * 12.9898).sin() * 43758.547).fract().abs();
                next += 0.18 + r * 0.5;
                i += 1;
            }
            p.advance(t, HOP_S, &bands);
            t += HOP_S;
        }
        assert!(
            p.grid_conf() < 0.45,
            "random onsets reported as locked: {}",
            p.grid_conf()
        );
    }

    #[test]
    fn bars_keep_running_through_a_breakdown() {
        let mut p = run(128.0, 12.0, |_| 0.0, 0);
        let counted = p.beat_count();
        // 6 s with nothing to lock onto — the bars underneath carry on, so
        // the phrase still lines up when the beat comes back
        let bands = [0.4f32; 8];
        let mut t = 12.0f32;
        while t < 18.0 {
            p.advance(t, HOP_S, &bands);
            t += HOP_S;
        }
        let elapsed_beats = 6.0 / (60.0 / 128.0);
        assert!(
            (p.beat_count() - counted - elapsed_beats).abs() <= 1.0,
            "counted {} beats through the break, expected ~{elapsed_beats}",
            p.beat_count() - counted
        );
    }

    #[test]
    fn grid_parks_itself_when_the_music_stops() {
        let mut p = run(128.0, 10.0, |_| 0.0, 0);
        // far past RESET_TIMEOUT — this is a stopped track, not a breakdown
        let bands = [0.4f32; 8];
        let mut t = 10.0f32;
        while t < 30.0 {
            p.advance(t, HOP_S, &bands);
            t += HOP_S;
        }
        assert_eq!(p.grid_conf(), 0.0, "grid should have given up");
    }

    /// A single stray tempo reading must not throw the lock away.
    #[test]
    fn one_bad_tempo_estimate_does_not_resync_the_grid() {
        let mut p = Phrasing::new(8);
        let bpm = 128.0;
        let period = 60.0 / bpm;
        let bands = [0.4f32; 8];
        let mut t = 0.0f32;
        let mut onset = 0u32;
        while t < 20.0 {
            let due = onset as f32 * period;
            if t >= due {
                // every 10th onset reports half-time, as the estimator does
                // when it latches onto the snare for a moment
                let reported = if onset % 10 == 3 { bpm / 2.0 } else { bpm };
                p.on_onset(due, reported, 0.8, 1.0);
                onset += 1;
            }
            p.advance(t, HOP_S, &bands);
            t += HOP_S;
        }
        assert!(p.grid_conf() > 0.7, "grid_conf was {}", p.grid_conf());
        let expected = 20.0 / period;
        assert!(
            (p.beat_count() - expected).abs() <= 1.0,
            "counted {} beats, expected ~{expected}",
            p.beat_count()
        );
    }

    #[test]
    fn a_change_of_material_is_reported_as_a_section() {
        let mut p = Phrasing::new(8);
        let quiet = [0.05f32, 0.05, 0.05, 0.05, 0.4, 0.4, 0.4, 0.4]; // highs only
        let loud = [0.9f32, 0.9, 0.9, 0.8, 0.1, 0.1, 0.05, 0.05]; // bass drop
        let mut t = 0.0f32;
        while t < 12.0 {
            p.advance(t, HOP_S, &quiet);
            t += HOP_S;
        }
        assert_eq!(p.section(), 0.0, "fired without anything changing");

        // The pulse is short by design, so watch for its peak rather than
        // sampling once at the end and catching only the tail.
        let mut peak = 0.0f32;
        let mut fired_at = None;
        while t < 14.0 {
            p.advance(t, HOP_S, &loud);
            if p.section() > peak {
                peak = p.section();
                if p.section() > 0.9 && fired_at.is_none() {
                    fired_at = Some(t);
                }
            }
            t += HOP_S;
        }
        assert!(peak > 0.9, "missed the change, peak section={peak}");
        let delay = fired_at.expect("never reached full pulse") - 12.0;
        assert!(delay < 1.0, "reacted {delay:.2} s late");
    }

    /// Not an assertion — prints the confidence each scenario settles at, so
    /// the threshold the frontend uses can be chosen against real numbers
    /// instead of guessed. Run with `cargo test -- --nocapture measured`.
    #[test]
    fn measured_confidence_by_scenario() {
        let jit8 = |i: u32| ((i as f32 * 7.13).sin() * 0.008).clamp(-0.008, 0.008);
        let jit12 = |i: u32| ((i as f32 * 12.9898).sin() * 0.012).clamp(-0.012, 0.012);
        println!("clean beats      {:.3}", run(128.0, 25.0, |_| 0.0, 0).grid_conf());
        println!("jittered+gaps    {:.3}", run(174.0, 25.0, jit12, 4).grid_conf());
        println!("eighths          {:.3}", run_subdiv(126.0, 25.0, 2, |_| 0.0, 0).grid_conf());
        println!("eighths+jitter   {:.3}", run_subdiv(126.0, 25.0, 2, jit12, 5).grid_conf());
        println!("sixteenths       {:.3}", run_subdiv(140.0, 25.0, 4, jit8, 7).grid_conf());
        println!("triplets         {:.3}", run_subdiv(120.0, 25.0, 3, |_| 0.0, 0).grid_conf());

        // the noise floor: what unmetrical input reports, which is what the
        // frontend threshold has to sit above
        for seed in [12.9898f32, 3.7, 21.4, 55.1] {
            let mut p = Phrasing::new(8);
            let bands = [0.4f32; 8];
            let (mut t, mut next, mut i) = (0.0f32, 0.0f32, 0u32);
            while t < 30.0 {
                if t >= next {
                    p.on_onset(next, 120.0, 0.8, 1.0);
                    next += 0.18 + ((i as f32 * seed).sin() * 43758.547).fract().abs() * 0.5;
                    i += 1;
                }
                p.advance(t, HOP_S, &bands);
                t += HOP_S;
            }
            println!("random (s={seed})  {:.3}", p.grid_conf());
        }
    }
}
