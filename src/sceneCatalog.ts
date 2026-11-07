export type SceneName =
  | "orb"
  | "terrain"
  | "tunnel"
  | "bars3d"
  | "gyro"
  | "blob"
  | "cubes"
  | "critters"
  | "surf"
  | "flora"
  | "parallax"
  | "morph"
  | "model";

export const SCENE_NAMES: SceneName[] = [
  "orb",
  "terrain",
  "tunnel",
  "bars3d",
  "gyro",
  "blob",
  "cubes",
  "critters",
  "surf",
  "flora",
  "parallax",
  "morph",
  "model",
];

/** What people read — the ids above stay as storage keys. */
export const SCENE_LABELS: Record<SceneName, string> = {
  orb: "Kugel",
  terrain: "Gebirge",
  tunnel: "Tunnel",
  bars3d: "Säulen",
  gyro: "Kreisel",
  blob: "Blob",
  cubes: "Würfel",
  critters: "Wesen",
  surf: "Brandung",
  flora: "Flora",
  parallax: "Parallax",
  morph: "Morph-Grid",
  model: "Eigenes Modell",
};

/** One line each, for the scene picker. */
export const SCENE_DESCS: Record<SceneName, string> = {
  orb: "Punktwolke, die mit dem Bass atmet",
  terrain: "Fluss über ein Spektrum-Gebirge",
  tunnel: "Flug durch einen pulsierenden Tunnel",
  bars3d: "Spektrum als Säulen im Raum",
  gyro: "Ringe, die sich im Takt verdrehen",
  blob: "Weiche Masse, vom Klang verformt",
  cubes: "Verschachtelte Würfel mit Beat-Kick",
  critters: "Kleine Wesen, die tanzen",
  surf: "Wellenlandschaft mit Sprüngen",
  flora: "Pflanzen wachsen mit der Musik",
  parallax: "Ein Bild in 2.5D, von der Musik bewegt",
  morph: "Bild-Varianten, zwischen denen der Klang wandert",
  model: "Eigenes glTF/GLB-Modell mit Explode-Effekt",
};
