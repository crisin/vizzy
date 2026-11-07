// Artist strings from the media session / Spotify: "Dr. Dre, Snoop Dogg",
// "A feat. B", "A & B" — split into names for matching rules and ratings.

export const normName = (s: string) => s.toLowerCase().normalize("NFKD").replace(/\p{M}/gu, "").trim();

/** Artist names as written: "Dr. Dre, Snoop Dogg" → ["Dr. Dre", "Snoop Dogg"] */
export function splitArtists(artist: string): string[] {
  return artist
    .split(/\s*(?:,|;|&|\bfeat\.?|\bft\.?|\bx\b)\s*/i)
    .map((a) => a.trim())
    .filter(Boolean);
}

/** All artist names in a media-session / Spotify artist string, normalised. */
export function artistsOf(artist: string): string[] {
  return splitArtists(artist).map(normName);
}

