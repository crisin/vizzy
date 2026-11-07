import { useEffect, useState } from "react";
import { useNowPlaying } from "../regie/nowPlaying";
import { live } from "../milkdrop/live";

const SHOW_MS = 4000;

/**
 * Song, picture and tempo, large and bottom-left, for a few seconds after
 * `I`. Meant to be read from the couch, so it sizes with the UI tier.
 */
export function InfoOverlay({ nonce, picture }: { nonce: number; picture: string }) {
  const { track } = useNowPlaying();
  const [visible, setVisible] = useState(false);
  const [bpm, setBpm] = useState(0);

  useEffect(() => {
    if (nonce === 0) return;
    setBpm(live.bpm);
    setVisible(true);
    const id = window.setTimeout(() => setVisible(false), SHOW_MS);
    return () => window.clearTimeout(id);
  }, [nonce]);

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
