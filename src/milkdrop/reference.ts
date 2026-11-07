// Cheat sheet for the code editor: the Milkdrop variables people reach for
// most. Not complete — the full list is in the Milkdrop preset authoring
// guide — but enough to write and read frame/pixel equations.

export const EEL_REFERENCE: [string, string][] = [
  ["time", "Sekunden seit Start"],
  ["frame", "Frame-Zähler"],
  ["fps", "aktuelle Bildrate"],
  ["bass, mid, treb", "Pegel der drei Bänder, ~1 = Durchschnitt"],
  ["bass_att, mid_att, treb_att", "dieselben, geglättet"],
  ["zoom", "Zoom pro Frame (1 = keiner)"],
  ["rot", "Drehung pro Frame (Radiant)"],
  ["warp", "Stärke der Verwirbelung"],
  ["cx, cy", "Zentrum von Zoom/Drehung (0..1)"],
  ["dx, dy", "Verschiebung pro Frame"],
  ["sx, sy", "Streckung"],
  ["decay", "Nachleuchten (0.98 = langer Schweif)"],
  ["wave_r/g/b/a", "Farbe und Deckkraft der Wellenform"],
  ["wave_x, wave_y", "Position der Wellenform"],
  ["ob_size, ob_r/g/b/a", "äußerer Rahmen"],
  ["ib_size, ib_r/g/b/a", "innerer Rahmen"],
  ["echo_zoom, echo_alpha", "Echo-Bild"],
  ["q1 … q32", "eigene Variablen: Frame-Gleichungen setzen sie, Pixel-Gleichungen und Shader lesen sie"],
  ["x, y, rad, ang", "nur in Pixel-Gleichungen: Position des Gitterpunkts"],
  ["megabuf(i), gmegabuf(i)", "großer Speicher (pro Preset / global)"],
  ["loop(n, …)", "Schleife; n wird abgerundet"],
  ["if(c, a, b)", "Bedingung — EEL kennt kein if-Statement"],
  ["above(a,b), below(a,b), equal(a,b)", "Vergleiche, liefern 0 oder 1"],
  ["sin cos tan atan2 sqrt pow abs sign", "Mathe wie erwartet"],
  ["rand(n)", "Zufallszahl 0..n-1"],
  ["Shader: sampler_main, uv, ret", "Warp/Comp: Bild lesen, Koordinate, Ausgabefarbe"],
  ["Shader: q1 … q32, time, bass …", "dieselben Werte stehen im Shader bereit"],
];
