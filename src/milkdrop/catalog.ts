// One flat list of every preset the picker knows about — Butterchurn's pack,
// the curated ones and the user's own — with the bits the library needs to
// search, filter and sort: a readable title and the author(s) parsed out of
// Milkdrop's "Author + Author - Title" naming convention.

export type PresetSource = "butterchurn" | "curated" | "user";

export type CatalogEntry = {
  key: string;
  title: string;
  authors: string[];
  source: PresetSource;
  /** lower-cased haystack for the search box */
  search: string;
};

function cap(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

/** "Eo.S. + Zylot - skylight (…)" → authors [Eo.S., Zylot], title "skylight (…)" */
export function parseName(name: string): { title: string; authors: string[] } {
  const cleaned = name.replace(/^[_$\s]+/, "");
  const dash = cleaned.indexOf(" - ");
  if (dash > 0) {
    const head = cleaned.slice(0, dash);
    const title = cleaned.slice(dash + 3).trim();
    const authors = head
      .split(/\s*(?:\+|&|,|\bn\b|\band\b)\s*/i)
      .map((a) => cap(a.trim()))
      .filter((a) => a.length > 1 && a.length < 24);
    if (authors.length) return { title, authors };
  }
  // "_Mig_049", "Geiss_untitled"
  const m = cleaned.match(/^([A-Za-z.]+)[_ ](.+)$/);
  if (m) return { title: m[2].replace(/_/g, " "), authors: [cap(m[1])] };
  return { title: cleaned, authors: [] };
}

export function buildCatalog(
  butterchurnKeys: string[],
  curated: { name: string; base: string }[],
  curatedPrefix: string,
  userPresets: { name: string; base: string }[],
): CatalogEntry[] {
  const out: CatalogEntry[] = [];
  for (const p of curated) {
    const base = parseName(p.base);
    out.push({
      key: `${curatedPrefix}${p.name}`,
      title: p.name,
      authors: ["Vizzy", ...base.authors],
      source: "curated",
      search: `${p.name} ${p.base} vizzy`.toLowerCase(),
    });
  }
  for (const p of userPresets) {
    const base = parseName(p.base);
    out.push({
      key: `user:${p.name}`,
      title: p.name,
      authors: ["Du", ...base.authors],
      source: "user",
      search: `${p.name} ${p.base}`.toLowerCase(),
    });
  }
  for (const k of butterchurnKeys) {
    const { title, authors } = parseName(k);
    out.push({ key: k, title, authors, source: "butterchurn", search: k.toLowerCase() });
  }
  return out;
}

/** Stable short hash for cache keys (FNV-1a). */
export function hashString(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}
