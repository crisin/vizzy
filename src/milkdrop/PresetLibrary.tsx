import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useDialogFocus } from "../useDialogFocus";
import type { CatalogEntry } from "./catalog";
import { MilkdropEngine } from "./engine";
import { liveTimeByte } from "./live";
import {
  CLIP_FRAMES,
  FRAME_LABELS,
  PreviewGenerator,
  VARIANT_FRAMES,
  cacheKey,
  loadAllPreviews,
  suggestEnergy,
  type GeneratorStatus,
  type PreviewRecord,
} from "./previews";
import { ENERGY_TAGS, tagStore, useTags } from "./tags";
import { TagChips } from "./TagChips";
import "./library.css";
import { presetStore, useUserPresets } from "./presetStore";

type SourceFilter = "all" | "fav" | "curated" | "user" | "untagged" | "quarantine";
type SortBy = "name" | "author" | "energy";
type View = "still" | "clip";

type Preview = {
  rec: PreviewRecord;
  stillUrl: string;
  sheetUrl: string;
};

const SOURCE_LABELS: [SourceFilter, string][] = [
  ["all", "Alle"],
  ["fav", "★ Favoriten"],
  ["curated", "✦ Kuratiert"],
  ["user", "Eigene"],
  ["untagged", "Ohne Energie-Tag"],
  ["quarantine", "⛔ Quarantäne"],
];

const PREFS_KEY = "vizzy.mdlibrary.v1";
type Prefs = { view: View; sort: SortBy; size: number };
function loadPrefs(): Prefs {
  try {
    return { view: "clip", sort: "name", size: 220, ...JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}") };
  } catch {
    return { view: "clip", sort: "name", size: 220 };
  }
}

const isEnergy = (t: string) => (ENERGY_TAGS as readonly string[]).includes(t);

export function PresetLibrary({
  entries,
  currentKey,
  favorites,
  quarantine,
  runtimeReady,
  resolvePreset,
  onApply,
  onApplyLayerB,
  onOpenStudio,
  target = "a",
  onToggleFavorite,
  onClose,
}: {
  entries: CatalogEntry[];
  currentKey: string;
  favorites: string[];
  quarantine: string[];
  runtimeReady: boolean;
  resolvePreset: (key: string) => unknown | null;
  onApply: (key: string, overrides?: Record<string, number>) => void;
  /** puts the preset on layer B (shown when given) */
  onApplyLayerB?: (key: string) => void;
  /** opens the preset studio on this preset */
  onOpenStudio?: (key: string) => void;
  /** "b": the library was opened to choose layer B — Anwenden targets B */
  target?: "a" | "b";
  onToggleFavorite: (key: string) => void;
  onClose: () => void;
}) {
  const dialogRef = useDialogFocus<HTMLDivElement>();
  useTags();
  const [prefs, setPrefs] = useState<Prefs>(loadPrefs);
  useEffect(() => {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    } catch {
      // ignore
    }
  }, [prefs]);

  const [query, setQuery] = useState("");
  const [source, setSource] = useState<SourceFilter>("all");
  const [tagFilter, setTagFilter] = useState<string[]>([]);
  const [tagMode, setTagMode] = useState<"any" | "all">("any");
  const [selected, setSelected] = useState(currentKey);
  const [multi, setMulti] = useState<string[]>([]);
  const [hoverKey, setHoverKey] = useState<string | null>(null);

  /* --------------------------------------------------------- previews */
  const [previews, setPreviews] = useState<Map<string, Preview>>(new Map());
  const [genStatus, setGenStatus] = useState<GeneratorStatus>({ done: 0, total: 0, current: "" });
  const genRef = useRef<PreviewGenerator | null>(null);
  const urlsRef = useRef<string[]>([]);

  const addRecord = useCallback((rec: PreviewRecord) => {
    const stillUrl = URL.createObjectURL(rec.still);
    const sheetUrl = URL.createObjectURL(rec.sheet);
    urlsRef.current.push(stillUrl, sheetUrl);
    setPreviews((prev) => {
      const next = new Map(prev);
      next.set(rec.presetKey, { rec, stillUrl, sheetUrl });
      return next;
    });
  }, []);

  useEffect(() => {
    return () => {
      genRef.current?.stop();
      for (const u of urlsRef.current) URL.revokeObjectURL(u);
    };
  }, []);

  // Load what is cached, then queue everything whose content changed or was
  // never rendered. Needs the preset pack, so waits for the runtime.
  useEffect(() => {
    if (!runtimeReady) return;
    let cancelled = false;
    void loadAllPreviews()
      .catch(() => [] as PreviewRecord[])
      .then((recs) => {
        if (cancelled) return;
        const byKey = new Map(recs.map((r) => [r.key, r]));
        const jobs = [];
        // grid order (by title), so the visible cards fill in top to bottom
        const ordered = [...entries].sort((a, b) => a.title.localeCompare(b.title));
        for (const e of ordered) {
          const preset = resolvePreset(e.key);
          if (!preset) continue;
          const key = cacheKey(e.key, preset);
          const hit = byKey.get(key);
          if (hit) addRecord(hit);
          else jobs.push({ presetKey: e.key, preset, key });
        }
        if (jobs.length) {
          genRef.current ??= new PreviewGenerator(addRecord, setGenStatus);
          // the one on screen first, then in list order
          jobs.sort((a, b) => (a.presetKey === currentKey ? -1 : b.presetKey === currentKey ? 1 : 0));
          genRef.current.enqueue(jobs);
        }
      });
    return () => {
      cancelled = true;
    };
    // entries change only when user presets change — fine to re-scan then
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runtimeReady, entries]);

  const suggestions = useMemo(
    () => suggestEnergy([...previews.values()].map((p) => p.rec)),
    [previews],
  );

  /* ---------------------------------------------------------- filtering */
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = entries.filter((e) => {
      if (q && !e.search.includes(q) && !tagStore.get(e.key).some((t) => t.includes(q))) return false;
      switch (source) {
        case "fav":
          if (!favorites.includes(e.key)) return false;
          break;
        case "curated":
        case "user":
          if (e.source !== source) return false;
          break;
        case "untagged":
          if (tagStore.get(e.key).some(isEnergy)) return false;
          break;
        case "quarantine":
          if (!quarantine.includes(e.key)) return false;
          break;
      }
      return tagStore.matches(e.key, tagFilter, tagMode, favorites);
    });
    const energyOf = (k: string) => {
      const t = tagStore.get(k).find(isEnergy) ?? suggestions.get(k);
      return t ? ENERGY_TAGS.indexOf(t as (typeof ENERGY_TAGS)[number]) : 3;
    };
    const by = prefs.sort;
    list.sort((a, b) => {
      if (by === "author") {
        const c = (a.authors[0] ?? "~").localeCompare(b.authors[0] ?? "~");
        if (c) return c;
      } else if (by === "energy") {
        const c = energyOf(a.key) - energyOf(b.key);
        if (c) return c;
      }
      return a.title.localeCompare(b.title);
    });
    return list;
    // tag version is read through useTags() re-rendering us
  }, [entries, query, source, tagFilter, tagMode, favorites, quarantine, prefs.sort, suggestions, tagStore.getVersion()]);

  /* ---------------------------------------------------------- live tile */
  const tileRef = useRef<HTMLCanvasElement | null>(null);
  const engineRef = useRef<MilkdropEngine | null>(null);
  const [tileError, setTileError] = useState("");
  const shownKey = hoverKey ?? selected;
  const [debouncedKey, setDebouncedKey] = useState(shownKey);
  useEffect(() => {
    const id = window.setTimeout(() => setDebouncedKey(shownKey), hoverKey ? 300 : 0);
    return () => window.clearTimeout(id);
  }, [shownKey, hoverKey]);
  const tileOverrides = useRef<Record<string, number> | null>(null);
  const [tileVariant, setTileVariant] = useState<number | null>(null);

  useEffect(() => {
    const canvas = tileRef.current;
    if (!canvas) return;
    const eng = new MilkdropEngine(canvas);
    engineRef.current = eng;
    let raf = 0;
    let last = performance.now();
    const loop = (now: number) => {
      const w = Math.round(canvas.clientWidth * Math.min(devicePixelRatio, 1.5));
      const h = Math.round(canvas.clientHeight * Math.min(devicePixelRatio, 1.5));
      if (w > 0 && h > 0) eng.setSize(w, h);
      eng.render(liveTimeByte, (now - last) / 1000);
      last = now;
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      eng.destroy();
      engineRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!runtimeReady) return;
    const eng = engineRef.current;
    const base = resolvePreset(debouncedKey) as { baseVals?: Record<string, unknown> } | null;
    if (!eng || !base) return;
    const ov = tileOverrides.current;
    const preset = ov ? { ...base, baseVals: { ...(base.baseVals ?? {}), ...ov } } : base;
    genRef.current?.prioritize(debouncedKey);
    void eng.load(debouncedKey, preset, 0.6).then(() => setTileError(eng.error));
  }, [debouncedKey, runtimeReady, resolvePreset, tileVariant]);

  useEffect(() => {
    tileOverrides.current = null;
    setTileVariant(null);
  }, [selected]);

  /* ---------------------------------------------------------- keyboard */
  const gridRef = useRef<HTMLDivElement | null>(null);
  const columns = () => {
    const g = gridRef.current;
    if (!g || g.children.length < 2) return 1;
    const top = (g.children[0] as HTMLElement).offsetTop;
    let n = 0;
    for (const c of g.children) {
      if ((c as HTMLElement).offsetTop !== top) break;
      n++;
    }
    return Math.max(1, n);
  };
  const move = (delta: number) => {
    const i = visible.findIndex((e) => e.key === selected);
    const next = visible[Math.max(0, Math.min(visible.length - 1, (i < 0 ? 0 : i) + delta))];
    if (next) {
      setSelected(next.key);
      setMulti([]);
      gridRef.current
        ?.querySelector(`[data-key="${CSS.escape(next.key)}"]`)
        ?.scrollIntoView({ block: "nearest" });
    }
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    const t = e.target as HTMLElement;
    if (t.tagName === "INPUT") return;
    if (e.key === "ArrowRight") move(1);
    else if (e.key === "ArrowLeft") move(-1);
    else if (e.key === "ArrowDown") move(columns());
    else if (e.key === "ArrowUp") move(-columns());
    else if (e.key === "Enter") apply(selected);
    else if (e.key.toLowerCase() === "s") onToggleFavorite(selected);
    else return;
    e.preventDefault();
  };

  const apply = (key: string, overrides?: Record<string, number>) => {
    onApply(key, overrides);
  };

  const onCardClick = (e: React.MouseEvent, key: string) => {
    if (e.ctrlKey || e.metaKey) {
      const base = multi.length ? multi : [selected];
      setMulti(base.includes(key) ? base.filter((k) => k !== key) : [...base, key]);
      return;
    }
    if (e.shiftKey) {
      const a = visible.findIndex((v) => v.key === selected);
      const b = visible.findIndex((v) => v.key === key);
      if (a >= 0 && b >= 0) {
        const [lo, hi] = a < b ? [a, b] : [b, a];
        setMulti(visible.slice(lo, hi + 1).map((v) => v.key));
        return;
      }
    }
    setMulti([]);
    setSelected(key);
  };

  const entryOf = (key: string) => entries.find((e) => e.key === key);
  // family tree of own presets: where it came from, what came from it
  const own = useUserPresets();
  const lineageOf = (key: string) => {
    const self = key.startsWith("user:") ? presetStore.byName(key.slice(5)) : undefined;
    const parents = self?.lineage?.parents ?? [];
    const kids = own.filter((p) => p.lineage?.parents.includes(key)).map((p) => `user:${p.name}`);
    return { op: self?.lineage?.op, parents, kids };
  };
  const sel = entryOf(selected);
  const selPreview = previews.get(selected);
  const untaggedSuggestions = visible.filter(
    (e) => suggestions.has(e.key) && !tagStore.get(e.key).some(isEnergy),
  );

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        ref={dialogRef}
        className="modal mdlib"
        role="dialog"
        aria-modal="true"
        aria-labelledby="mdlib-title"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
        style={{ ["--card-w" as string]: `${prefs.size}px` }}
      >
        <div className="modal-head mdlib-head">
          <h2 id="mdlib-title">{target === "b" ? "Preset für Layer B" : "Preset-Library"}</h2>
          <input
            className="mdlib-search"
            type="search"
            placeholder="Suchen: Name, Autor, Tag…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Presets durchsuchen"
          />
          <div className="mdlib-tools">
            <div className="seg" role="group" aria-label="Ansicht">
              <button className={`mode-btn ${prefs.view === "still" ? "active" : ""}`} onClick={() => setPrefs({ ...prefs, view: "still" })} title="Standbilder, Clip beim Überfahren">Bild</button>
              <button className={`mode-btn ${prefs.view === "clip" ? "active" : ""}`} onClick={() => setPrefs({ ...prefs, view: "clip" })} title="Alle Clips laufen">Clip</button>
            </div>
            <select className="src-select" value={prefs.sort} onChange={(e) => setPrefs({ ...prefs, sort: e.target.value as SortBy })} aria-label="Sortierung">
              <option value="name">Name</option>
              <option value="author">Autor</option>
              <option value="energy">Energie</option>
            </select>
            <input type="range" min={150} max={360} step={10} value={prefs.size} onChange={(e) => setPrefs({ ...prefs, size: Number(e.target.value) })} aria-label="Kachelgröße" title="Kachelgröße" />
            <button type="button" className="mode-btn" onClick={onClose} aria-label="Library schließen">Schließen</button>
          </div>
        </div>

        <div className="mdlib-filters">
          {SOURCE_LABELS.map(([id, label]) => (
            <button key={id} className={`chip ${source === id ? "on" : ""}`} onClick={() => setSource(id)}>
              {label}
              {id === "quarantine" && quarantine.length ? ` (${quarantine.length})` : ""}
            </button>
          ))}
          <span className="mdlib-sep" />
          <TagChips
            selected={tagFilter}
            onToggle={(t) => setTagFilter((f) => (f.includes(t) ? f.filter((x) => x !== t) : [...f, t]))}
            compact
          />
          {tagFilter.length > 1 && (
            <button className="chip" onClick={() => setTagMode(tagMode === "any" ? "all" : "any")} title="Verknüpfung der Tag-Filter">
              {tagMode === "any" ? "ODER" : "UND"}
            </button>
          )}
          {tagFilter.length > 0 && (
            <button className="chip" onClick={() => setTagFilter([])}>× Filter</button>
          )}
        </div>

        <div className="mdlib-body">
          <div className="mdlib-grid" ref={gridRef} tabIndex={0} aria-label="Presets">
            {visible.map((e) => {
              const p = previews.get(e.key);
              const tags = tagStore.get(e.key);
              const sug = !tags.some(isEnergy) ? suggestions.get(e.key) : undefined;
              const isSel = e.key === selected;
              const inMulti = multi.includes(e.key);
              return (
                <button
                  type="button"
                  key={e.key}
                  data-key={e.key}
                  className={`mdcard ${isSel ? "sel" : ""} ${inMulti ? "multi" : ""} ${e.key === currentKey ? "playing" : ""}`}
                  onClick={(ev) => onCardClick(ev, e.key)}
                  onDoubleClick={() => apply(e.key)}
                  onMouseEnter={() => setHoverKey(e.key)}
                  onMouseLeave={() => setHoverKey((h) => (h === e.key ? null : h))}
                  title={`${e.key}\nDoppelklick: anwenden · Strg/Shift: mehrere wählen`}
                >
                  <div
                    className={`mdthumb ${p ? "" : "pending"} ${prefs.view === "clip" ? "anim" : ""}`}
                    style={p ? { backgroundImage: `url(${prefs.view === "clip" || hoverKey === e.key ? p.sheetUrl : p.stillUrl})`, backgroundSize: prefs.view === "clip" || hoverKey === e.key ? `${CLIP_FRAMES * 100}% 100%` : "cover" } : undefined}
                    data-hover={hoverKey === e.key ? "1" : undefined}
                  >
                    {!p && <span>{genStatus.current === e.key ? "rendert…" : "Vorschau folgt"}</span>}
                    {favorites.includes(e.key) && <span className="mdcard-star">★</span>}
                    {quarantine.includes(e.key) && <span className="mdcard-q">⛔</span>}
                    {e.key === currentKey && <span className="mdcard-now">läuft</span>}
                  </div>
                  <div className="mdcard-title">{e.title}</div>
                  <div className="mdcard-meta">
                    {e.authors.slice(0, 2).join(" + ") || "—"}
                    {e.source !== "butterchurn" && <span className="mdcard-src">{e.source === "curated" ? "✦" : "eigen"}</span>}
                  </div>
                  <div className="mdcard-tags">
                    {tags.map((t) => (
                      <span key={t} className="tag-dot" style={{ ["--c" as string]: tagStore.color(t) }}>{t}</span>
                    ))}
                    {sug && <span className="tag-dot suggest" style={{ ["--c" as string]: tagStore.color(sug) }} title="Vorschlag aus der Vorschau-Messung">≈{sug}</span>}
                  </div>
                </button>
              );
            })}
            {visible.length === 0 && <div className="mdlib-empty">Nichts gefunden.</div>}
          </div>

          <aside className="mdlib-side">
            <canvas ref={tileRef} className="mdlib-tile" />
            {tileError && <div className="mdlib-err">{tileError}</div>}
            {multi.length > 1 ? (
              <div className="mdlib-panel">
                <h3>{multi.length} ausgewählt</h3>
                <p className="mdlib-hint">Tag anklicken: auf alle setzen. Haben ihn schon alle, wird er entfernt.</p>
                <TagChips
                  selected={tagStore.allTags().map((t) => t.name).filter((t) => multi.every((k) => tagStore.has(k, t)))}
                  partial={tagStore.allTags().map((t) => t.name).filter((t) => multi.some((k) => tagStore.has(k, t)))}
                  onToggle={(t) => tagStore.toggleMany(multi, t)}
                  allowCreate
                />
                <div className="mdlib-actions">
                  <button className="mode-btn" onClick={() => setMulti([])}>Auswahl aufheben</button>
                </div>
              </div>
            ) : sel ? (
              <div className="mdlib-panel">
                <h3 title={sel.key}>{sel.title}</h3>
                <div className="mdlib-hint">{sel.authors.join(" + ") || "unbekannt"}</div>
                <div className="mdlib-actions">
                  <button className="mode-btn active" onClick={() => apply(sel.key, tileOverrides.current ?? undefined)}>
                    {target === "b" ? "Als Layer B" : tileVariant !== null ? "Variante anwenden" : "Anwenden"}
                  </button>
                  {target === "a" && onOpenStudio && (
                    <button className="mode-btn" onClick={() => onOpenStudio(sel.key)} title="Bausteine mischen, Code bearbeiten, Remix">
                      Studio
                    </button>
                  )}
                  {target === "a" && onApplyLayerB && (
                    <button className="mode-btn" onClick={() => onApplyLayerB(sel.key)} title="Über das laufende Preset legen">
                      + als Layer B
                    </button>
                  )}
                  <button className={`mode-btn ${favorites.includes(sel.key) ? "active" : ""}`} onClick={() => onToggleFavorite(sel.key)} title="Favorit (S)">
                    {favorites.includes(sel.key) ? "★" : "☆"}
                  </button>
                  {quarantine.includes(sel.key) && <span className="mdlib-hint">⛔ trappte wiederholt — Anwenden gibt es frei</span>}
                </div>
                <TagChips
                  selected={tagStore.get(sel.key)}
                  suggested={suggestions.get(sel.key)}
                  onToggle={(t) => tagStore.toggle(sel.key, t)}
                  allowCreate
                />
                {tagStore.isSeeded(sel.key) && <div className="mdlib-hint">Tags aus dem Code — deine Änderungen haben Vorrang.</div>}
                {(() => {
                  const l = lineageOf(sel.key);
                  if (!l.parents.length && !l.kids.length) return null;
                  const chip = (k: string) => (
                    <button key={k} type="button" className="chip" onClick={() => setSelected(k)} title={k}>
                      {entryOf(k)?.title ?? k}
                    </button>
                  );
                  return (
                    <>
                      <h4>Stammbaum</h4>
                      {l.parents.length > 0 && (
                        <div className="mdlib-family">
                          <span className="mdlib-hint">{l.op ?? "aus"} von</span>
                          {l.parents.map(chip)}
                        </div>
                      )}
                      {l.kids.length > 0 && (
                        <div className="mdlib-family">
                          <span className="mdlib-hint">Kinder</span>
                          {l.kids.map(chip)}
                        </div>
                      )}
                    </>
                  );
                })()}
                {selPreview && (
                  <>
                    <h4>Clip</h4>
                    <div className="mdlib-strip">
                      {Array.from({ length: CLIP_FRAMES }, (_, i) => {
                        const v = VARIANT_FRAMES.indexOf(i);
                        return (
                          <button
                            key={i}
                            type="button"
                            className={`strip-frame ${v >= 0 ? "variant" : ""} ${v >= 0 && tileVariant === v ? "on" : ""}`}
                            style={{ backgroundImage: `url(${selPreview.sheetUrl})`, backgroundSize: `${CLIP_FRAMES * 100}% 100%`, backgroundPosition: `${(i / (CLIP_FRAMES - 1)) * 100}% 0` }}
                            title={v >= 0 ? `${FRAME_LABELS[i]}: ${Object.entries(selPreview.rec.variants[v]).map(([k, x]) => `${k} ${x.toFixed(3)}`).join(", ")} — klicken zum Ausprobieren` : FRAME_LABELS[i]}
                            onClick={() => {
                              if (v < 0) return;
                              const on = tileVariant === v;
                              tileOverrides.current = on ? null : selPreview.rec.variants[v];
                              setTileVariant(on ? null : v);
                              setHoverKey(null);
                            }}
                          >
                            <span>{FRAME_LABELS[i]}</span>
                          </button>
                        );
                      })}
                    </div>
                  </>
                )}
              </div>
            ) : null}

            <div className="mdlib-foot">
              {genStatus.total > 0 && genStatus.done < genStatus.total ? (
                <span>Vorschauen: {genStatus.done}/{genStatus.total}</span>
              ) : (
                <span>{previews.size} Vorschauen</span>
              )}
              {untaggedSuggestions.length > 0 && (
                <button
                  className="mode-btn"
                  onClick={() => {
                    for (const e of untaggedSuggestions) tagStore.toggle(e.key, suggestions.get(e.key)!);
                  }}
                  title="Gemessene Energie als Tag übernehmen — nur für sichtbare Presets ohne Energie-Tag"
                >
                  Energie-Vorschläge übernehmen ({untaggedSuggestions.length})
                </button>
              )}
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}
