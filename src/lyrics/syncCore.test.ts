// Checks for syncCore.ts — plain Node, no test framework (the repo has none):
//   node src/lyrics/syncCore.test.ts
import assert from "node:assert/strict";
import { SyncClock, lineAt, locate, similarity, type TimedLine } from "./syncCore.ts";

const song: TimedLine[] = [
  { text: "We're talking away", startMs: 30_000 },
  { text: "I don't know what I'm to say", startMs: 33_000 },
  { text: "I'll say it anyway", startMs: 36_000 },
  { text: "Take on me", startMs: 60_000 },
  { text: "Take me on", startMs: 63_000 },
  { text: "I'll be gone", startMs: 66_000 },
  { text: "Take on me", startMs: 180_000 },
  { text: "Take me on", startMs: 183_000 },
];

// similarity tolerates Whisper's spelling
assert.ok(similarity("I don't know what to say, I'll say it anyway", "I don't know what I'm to say") > 0.6);
assert.equal(similarity("Take on me", "take on me!"), 1);

// lineAt
assert.equal(lineAt(song, 10_000), -1);
assert.equal(lineAt(song, 33_000), 1);
assert.equal(lineAt(song, 61_000), 3);
assert.equal(lineAt(song, 999_999), 7);

// locate: the chorus near the expected time, not the first one
assert.equal(locate(song, "Take on me", 178_000, 20_000)?.index, 6);
assert.equal(locate(song, "Take on me", 58_000, 20_000)?.index, 3);
// a merged Whisper line still finds its first synced line
assert.equal(locate(song, "I don't know what I'm to say, I'll say it anyway", 34_000, 20_000)?.index, 1);
// one word says nothing
assert.equal(locate(song, "Oh", 60_000, 20_000), null);
// out of the window: nothing
assert.equal(locate(song, "Take on me", 120_000, 20_000), null);

// clock with a media position that runs 1.5 s early
const c = new SyncClock();
// "Take on me" (60 s) started 2 s ago; the media session says 60.5 s now
c.match(60_000, 2_000, 60_500, 0);
assert.equal(c.offsetMs, 1_500);
assert.equal(c.songMs(61_000, 0), 62_500);
// one outlier does not move it, a seek confirmed twice does
c.match(63_000, 1_000, 62_500, 0);
c.match(66_000, 1_000, 65_500, 0);
assert.equal(c.offsetMs, 1_500);
c.match(180_000, 1_000, 70_000, 0); // jump: 111 s
assert.equal(c.offsetMs, 1_500, "a single jump is held back");
c.match(183_000, 1_000, 73_100, 0); // agrees (≈ 110.9 s)
assert.ok(Math.abs(c.offsetMs - 110_900) < 200, `jumped to ${c.offsetMs}`);

// without a media position the match starts a running clock
const d = new SyncClock();
assert.equal(d.songMs(null, 0), null);
d.match(30_000, 2_000, null, 10_000);
assert.equal(d.songMs(null, 15_000), 37_000);

console.log("syncCore ok");
