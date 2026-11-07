import { useEffect, useRef, useState } from "react";
import { useNowPlaying } from "../regie/nowPlaying";
import { live } from "../milkdrop/live";

const SHOW_MS = 4000;

/**
 * Song, picture and tempo, large and bottom-left, for a few seconds after
 * `I`. Meant to be read from the couch, so it sizes with the UI tier.
 */
export function InfoOverlay({
  nonce,
  picture,
  onSongChange,
}: {
  nonce: number;
  picture: string;
  /** also show it by itself whenever a new song starts */
  onSongChange: boolean;
}) {
  const { track } = useNowPlaying();
  const [visible, setVisible] = useState(false);
  const [bpm, setBpm] = useState(0);
  const [songNonce, setSongNonce] = useState(0);

  // a new song (not the first one seen) shows the overlay, if asked to
  const songKey = track && track.status !== "other" ? track.key : null;
  const lastSong = useRef<string | null>(null);
  useEffect(() => {
    const prev = lastSong.current;
    lastSong.current = songKey;
    if (onSongChange && songKey && prev && songKey !== prev) setSongNonce((n) => n + 1);
  }, [songKey, onSongChange]);

  useEffect(() => {
    if (nonce === 0 && songNonce === 0) return;
    // the tempo needs a moment after a song change
    const delay = songNonce > 0 && nonce === 0 ? 1500 : 0;
    let hide = 0;
    const show = window.setTimeout(() => {
      setBpm(live.bpm);
      setVisible(true);
      hide = window.setTimeout(() => setVisible(false), SHOW_MS);
    }, delay);
    return () => {
      window.clearTimeout(show);
      window.clearTimeout(hide);
    };
  }, [nonce, songNonce]);

  if (!visible) return null;
  const song = track && track.status !== "other" ? track : null;
  return (
    <div className="info-overlay" role="status">
      {song ? (
        <div className="info-song">
          {song.title}
          {song.artist && <span className="info-artist"> · {song.artist}</span>}
        </div>
      ) : (
        <div className="info-song info-muted">Kein Song erkannt</div>
      )}
      <div className="info-line">
        <span>{picture}</span>
        {bpm > 40 && <span className="info-bpm">{Math.round(bpm)} BPM</span>}
      </div>
    </div>
  );
}
