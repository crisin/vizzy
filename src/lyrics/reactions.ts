// Reactions to the singing (PLAN-stimme.md, S2): chorus comes back, singing
// starts after an instrumental, an instrumental starts. What happens is set
// in Settings → Automatik ("react" parameters); App supplies the actions.
// Picture changes go through the auto-switch, so the Regie (queue, choreo,
// rules) keeps the last word.

import { live } from "../milkdrop/live";
import { params } from "../params";
import { lyricEvents } from "./events";

export type ReactionHost = {
  /** a picture change as the auto-switch would make it (Regie first) */
  autoPick: () => void;
  randomPreset: () => void;
  /** switch layer B; false when there is none to switch */
  layerB: (on: boolean) => boolean;
  isLayerBOn: () => boolean;
  osd: (msg: string) => void;
};

const KICK = 1.5;

export function attachReactions(host: ReactionHost): () => void {
  let lastChange = -1e9;
  /** layer B was switched on for the refrain, by us */
  let bForRefrain = false;

  const r = (key: string) => params.get("react", key) | 0;
  const osd = (msg: string) => {
    if (params.get("react", "osd") >= 0.5) host.osd(msg);
  };
  /** picture changes respect the cooldown, other actions do not */
  const change = (fn: () => void, why: string) => {
    const now = performance.now();
    if (now - lastChange < params.get("react", "cooldown") * 1000) return;
    lastChange = now;
    fn();
    osd(why);
  };

  const offs = [
    lyricEvents.on("refrain", (text) => {
      switch (r("refrain")) {
        case 1:
          change(host.autoPick, `Refrain: ${text}`);
          break;
        case 2:
          change(host.randomPreset, `Refrain: ${text}`);
          break;
        case 3:
          if (!host.isLayerBOn() && host.layerB(true)) {
            bForRefrain = true;
            osd("Refrain: Layer B dazu");
          }
          break;
        case 4:
          live.kick = Math.max(live.kick, KICK);
          osd("Refrain");
          break;
      }
    }),
    lyricEvents.on("refrainEnd", () => {
      if (bForRefrain) {
        bForRefrain = false;
        host.layerB(false);
        osd("Refrain vorbei: Layer B weg");
      }
    }),
    lyricEvents.on("voiceOn", () => {
      switch (r("voiceOn")) {
        case 1:
          change(host.autoPick, "Gesang setzt ein");
          break;
        case 2:
          if (host.isLayerBOn()) host.layerB(false);
          osd("Gesang setzt ein: Layer B aus");
          break;
        case 3:
          live.kick = Math.max(live.kick, KICK);
          osd("Gesang setzt ein");
          break;
      }
    }),
    lyricEvents.on("voiceOff", () => {
      switch (r("voiceOff")) {
        case 1:
          change(host.autoPick, "Instrumental");
          break;
        case 2:
          if (!host.isLayerBOn() && host.layerB(true)) osd("Instrumental: Layer B an");
          break;
      }
    }),
  ];
  return () => offs.forEach((off) => off());
}
