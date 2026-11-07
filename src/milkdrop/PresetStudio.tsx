import { useEffect, useMemo, useRef, useState } from "react";
import { useDialogFocus } from "../useDialogFocus";
import { findCurated } from "../curated";
import { MilkdropEngine } from "./engine";
import { liveTimeByte } from "./live";
import { presetStore } from "./presetStore";
import { cross, mutate, probe } from "./remix";
import { tagStore } from "./tags";
import { TagChips } from "./TagChips";
import {
  CODE_PARTS,
  PART_LABELS,
  codeOf,
  compose,
  isRef,
  makePreset,
  newId,
  type CodePart,
  type Part,
  type VizzyPreset,
} from "./vpreset";
import { EEL_REFERENCE } from "./reference";
import { askAgent, listModels, loadLlmConfig, saveLlmConfig, type LlmConfig } from "./agent";
import { MdTweakPanel } from "../MdTweakPanel";
import "./studio.css";

type Bc = Record<string, unknown> & { baseVals?: Record<string, unknown>; waves?: { baseVals?: Record<string, unknown> }[]; shapes?: { baseVals?: Record<string, unknown> }[] };
export type StudioTab = "tweak" | "parts" | "code" | "remix" | "ai";
type Tab = StudioTab;
type Child = { preset: VizzyPreset; ok: boolean; reason: string; thumb: string };

const SLOT_PARTS = ["baseVals", ...CODE_PARTS] as const;
type SlotPart = (typeof SLOT_PARTS)[number];

function draftFrom(key: string, existing: VizzyPreset | undefined): VizzyPreset {
  if (existing) return JSON.parse(JSON.stringify(existing));
  const curated = findCurated(key);
  const base = curated ? curated.base : key;
  const name = (curated?.name ?? key.split(" - ").slice(-1)[0] ?? "Preset").slice(0, 40);
  return makePreset(`${name} (Studio)`, base, {
    overrides: { ...(curated?.overrides ?? {}) },
    lineage: { parents: [key], op: "tweak", at: Date.now() },
  });
}

function lineageOp(vp: VizzyPreset): NonNullable<VizzyPreset["lineage"]>["op"] {
  const parts: (Part<unknown> | null | undefined)[] = [
    vp.parts.baseVals,
    ...CODE_PARTS.map((k) => vp.parts[k]),
    ...(vp.parts.waves ?? []),
    ...(vp.parts.shapes ?? []),
  ];
  if (parts.some((p) => p && !isRef(p))) return "edit";
  if (parts.some((p) => isRef(p))) return "mashup";
  return "tweak";
}

export function PresetStudio({
  initialKey,
  allKeys,
  favorites,
  label,
  resolvePreset,
  onApply,
  onClose,
  initialTab = "tweak",
  initialOverrides,
}: {
  initialKey: string;
  allKeys: string[];
  favorites: string[];
  label: (key: string) => string;
  resolvePreset: (key: string) => unknown | null;
  /** a saved preset should play in the main picture */
  onApply: (key: string) => void;
  onClose: () => void;
  /** "tweak" (Anpassen) for quick changes, "parts" for building */
  initialTab?: Tab;
  /** live tweaks the main picture already carries — the draft starts there */
  initialOverrides?: Record<string, number>;
}) {
  const dialogRef = useDialogFocus<HTMLDivElement>();
  const existing = initialKey.startsWith("user:") ? presetStore.byName(initialKey.slice(5)) : undefined;
  const [draft, setDraft] = useState<VizzyPreset>(() => {
    const d = draftFrom(initialKey, existing);
    if (initialOverrides && Object.keys(initialOverrides).length) {
      d.overrides = { ...d.overrides, ...initialOverrides };
    }
    return d;
  });
  const [savedAs, setSavedAs] = useState<string | null>(existing ? existing.name : null);
  // live tweaks carried over count as unsaved work
  const [dirty, setDirty] = useState(() => !!initialOverrides && Object.keys(initialOverrides).length > 0);
  const [tab, setTab] = useState<Tab>(initialTab);
  const [codePart, setCodePart] = useState<CodePart>("frame");
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [draftTags, setDraftTags] = useState<string[]>(() => tagStore.get(initialKey));

  const edit = (fn: (d: VizzyPreset) => VizzyPreset) => {
    setDraft((d) => fn(JSON.parse(JSON.stringify(d))));
    setDirty(true);
  };

  // Resolving through the app keeps references to own presets working;
  // a reference to the preset being edited would be its *saved* version.
  const resolveAt = (k: string) => resolvePreset(k);
  const composed = useMemo(() => compose(draft, resolveAt) as Bc | null, [draft, resolvePreset]);
  // what the sliders in "Anpassen" sit on: everything but the overrides
  const plainBaseVals = useMemo(
    () => ((compose({ ...draft, overrides: {} }, resolveAt) as Bc | null)?.baseVals ?? {}) as Record<string, unknown>,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [draft.base, draft.parts, resolvePreset],
  );
  const pool = favorites.length >= 4 ? favorites : allKeys;
  const randomKey = () => pool[Math.floor(Math.random() * pool.length)];

  /* --------------------------------------------------------- live tile */
  const tileRef = useRef<HTMLCanvasElement | null>(null);
  const engineRef = useRef<MilkdropEngine | null>(null);
  const [previewOverride, setPreviewOverride] = useState<unknown | null>(null);
  useEffect(() => {
    const canvas = tileRef.current!;
    const eng = new MilkdropEngine(canvas);
    engineRef.current = eng;
    let raf = 0;
    let last = performance.now();
    const loop = (now: number) => {
      const s = Math.min(devicePixelRatio, 1.5);
      if (canvas.clientWidth > 0) eng.setSize(Math.round(canvas.clientWidth * s), Math.round(canvas.clientHeight * s));
      eng.render(liveTimeByte, (now - last) / 1000);
      last = now;
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      eng.destroy();
    };
  }, []);

  const shown = previewOverride ?? composed;
  const shownJson = useMemo(() => JSON.stringify(shown), [shown]);
  useEffect(() => {
    if (!shown) {
      setError("Basis-Preset nicht gefunden (Preset-Paket noch nicht geladen?)");
      return;
    }
    const id = window.setTimeout(() => {
      const eng = engineRef.current;
      if (!eng) return;
      void eng.load("studio", shown, 0.4).then(() => setError(eng.error));
    }, 400);
    return () => window.clearTimeout(id);
    // reload only when the content really changed
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shownJson]);

  /* ------------------------------------------------------------- parts */
  const setPart = (part: SlotPart, value: string) =>
    edit((d) => {
      if (value === "") delete d.parts[part];
      else if (value === "__inline") return d;
      else (d.parts as Record<string, unknown>)[part] = { from: value };
      return d;
    });
  const setSlot = (list: "waves" | "shapes", i: number, value: string) =>
    edit((d) => {
      const arr = [...(d.parts[list] ?? [null, null, null, null])];
      arr[i] = value === "" ? null : value === "__inline" ? arr[i] : { from: value };
      d.parts[list] = arr;
      return d;
    });
  const partValue = (p: Part<unknown> | null | undefined) => (!p ? "" : isRef(p) ? p.from : "__inline");

  const shuffleAll = () =>
    edit((d) => {
      d.parts.warp = { from: randomKey() };
      d.parts.comp = { from: randomKey() };
      if (Math.random() < 0.5) d.parts.frame = { from: randomKey() };
      d.parts.waves = [0, 1, 2, 3].map(() => (Math.random() < 0.3 ? { from: randomKey() } : null));
      d.parts.shapes = [0, 1, 2, 3].map(() => (Math.random() < 0.3 ? { from: randomKey() } : null));
      return d;
    });

  const keyOptions = (
    <>
      {allKeys.map((k) => (
        <option key={k} value={k}>
          {label(k)}
        </option>
      ))}
    </>
  );

  const slotOn = (list: "waves" | "shapes", i: number) => {
    const v = composed?.[list]?.[i]?.baseVals?.enabled;
    return typeof v === "number" ? v >= 0.5 : false;
  };

  /* -------------------------------------------------------------- code */
  const code = codeOf(composed, codePart);
  const onCode = (text: string) =>
    edit((d) => {
      d.parts[codePart] = { inline: text };
      return d;
    });
  const codeIsInline = !!draft.parts[codePart] && !isRef(draft.parts[codePart]);

  /* ------------------------------------------------------------- remix */
  const [strength, setStrength] = useState(0.5);
  const [mutCode, setMutCode] = useState(false);
  const [partner, setPartner] = useState("");
  const [children, setChildren] = useState<Child[]>([]);
  const [busy, setBusy] = useState(false);
  const [picked, setPicked] = useState<number | null>(null);
  const breed = async (kind: "mutate" | "cross") => {
    if (!composed) return;
    setBusy(true);
    setChildren([]);
    setPicked(null);
    const parentKey = savedAs ? `user:${savedAs}` : initialKey;
    const out: Child[] = [];
    for (let i = 0; i < 6 && out.filter((c) => c.ok).length < 4; i++) {
      const seed = (Date.now() + i * 7919) | 0;
      const child =
        kind === "mutate"
          ? mutate(draft, composed, { strength, code: mutCode, seed, parentKey })
          : cross(draft, parentKey, partner || randomKey(), seed);
      const resolved = compose(child, resolveAt);
      const res = resolved ? await probe(resolved) : { ok: false, reason: "löst nicht auf", thumb: "" };
      out.push({ preset: child, ...res });
      setChildren([...out]);
    }
    setBusy(false);
  };

  /* ---------------------------------------------------------------- ai */
  const [llm, setLlm] = useState<LlmConfig>(loadLlmConfig);
  const [models, setModels] = useState<string[]>([]);
  const [instruction, setInstruction] = useState("");
  const [aiBusy, setAiBusy] = useState(false);
  const [aiMsg, setAiMsg] = useState("");
  const [aiResult, setAiResult] = useState<{ preset: VizzyPreset; note: string; ok: boolean; reason: string; raw: string } | null>(null);
  const updateLlm = (c: LlmConfig) => {
    setLlm(c);
    saveLlmConfig(c);
  };
  const fetchModels = async () => {
    try {
      const m = await listModels(llm.url);
      setModels(m);
      if (!llm.model && m[0]) updateLlm({ ...llm, model: m[0] });
      setAiMsg(m.length ? `${m.length} Modelle gefunden` : "Server erreichbar, aber keine Modelle");
    } catch (e) {
      setAiMsg(String(e));
    }
  };
  const runAgent = async () => {
    if (!composed || !instruction.trim()) return;
    setAiBusy(true);
    setAiMsg("Modell denkt…");
    setAiResult(null);
    try {
      const parentKey = savedAs ? `user:${savedAs}` : initialKey;
      const r = await askAgent(llm, draft, composed, instruction.trim(), parentKey);
      const resolved = compose(r.preset, resolveAt);
      const p = resolved ? await probe(resolved) : { ok: false, reason: "löst nicht auf", thumb: "", errors: "" };
      setAiResult({ preset: r.preset, note: r.note, ok: p.ok, reason: p.errors || p.reason, raw: r.raw });
      if (resolved) setPreviewOverride(resolved);
      setAiMsg(p.ok ? "Vorschlag läuft in der Vorschau" : `Vorschlag verworfen: ${p.reason}`);
    } catch (e) {
      setAiMsg(String(e));
    }
    setAiBusy(false);
  };

  /* -------------------------------------------------------------- save */
  const save = async (asNew: boolean) => {
    let name = draft.name.trim() || "Preset";
    if (asNew || !savedAs) {
      for (let i = 2; presetStore.byName(name) && presetStore.byName(name)?.id !== draft.id; i++) {
        name = `${draft.name.trim()} (${i})`;
      }
    }
    const parents = draft.lineage?.parents ?? [initialKey];
    const vp: VizzyPreset = {
      ...draft,
      name,
      id: asNew ? newId(name) : draft.id,
      tags: draftTags,
      lineage: {
        parents: asNew && savedAs ? [`user:${savedAs}`] : parents,
        op: draft.lineage?.op === "mutate" || draft.lineage?.op === "cross" ? draft.lineage.op : lineageOp(draft),
        at: Date.now(),
      },
    };
    if (savedAs && savedAs !== name && !asNew) await presetStore.remove(savedAs);
    await presetStore.save(vp);
    const key = `user:${name}`;
    tagStore.set(key, draftTags);
    setDraft(vp);
    setSavedAs(name);
    setDirty(false);
    setStatus(`Gespeichert als „${name}“`);
    return key;
  };

  const exportJson = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(draft, null, 2));
      setStatus("Preset-JSON in der Zwischenablage");
    } catch (e) {
      setStatus(`Kopieren fehlgeschlagen: ${e}`);
    }
  };
  const exportButterchurn = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(composed, null, 2));
      setStatus("Aufgelöstes Butterchurn-JSON in der Zwischenablage");
    } catch (e) {
      setStatus(`Kopieren fehlgeschlagen: ${e}`);
    }
  };
  const fileRef = useRef<HTMLInputElement | null>(null);

  /* ------------------------------------------------------------- close */
  // Unsaved work never disappears silently: closing asks first. A click on
  // the backdrop does nothing at all — too easy to hit by accident.
  const [confirmClose, setConfirmClose] = useState(false);
  const requestClose = () => (dirty ? setConfirmClose(true) : onClose());
  const escRef = useRef(() => {});
  // Esc on the question = back to editing
  escRef.current = confirmClose ? () => setConfirmClose(false) : requestClose;
  useEffect(() => {
    // capture phase: runs before the app's global Esc handling
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopImmediatePropagation();
      e.preventDefault();
      escRef.current();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  return (
    <div className="modal-backdrop">
      <div
        ref={dialogRef}
        className="modal studio"
        role="dialog"
        aria-modal="true"
        aria-labelledby="studio-title"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "s" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            void save(false);
          }
        }}
      >
        <div className="modal-head studio-head">
          <h2 id="studio-title">Preset-Studio</h2>
          <input
            className="studio-name"
            value={draft.name}
            onChange={(e) => edit((d) => ({ ...d, name: e.target.value }))}
            aria-label="Name des Presets"
          />
          <div className="studio-tabs" role="tablist">
            {(
              [
                ["tweak", "Anpassen"],
                ["parts", "Bausteine"],
                ["code", "Code"],
                ["remix", "Remix"],
                ["ai", "KI"],
              ] as [Tab, string][]
            ).map(([id, l]) => (
              <button key={id} role="tab" aria-selected={tab === id} className={`mode-btn ${tab === id ? "active" : ""}`} onClick={() => setTab(id)}>
                {l}
              </button>
            ))}
          </div>
          <button type="button" className="mode-btn" onClick={requestClose}>
            Schließen
          </button>
        </div>
        {confirmClose && (
          <div className="studio-confirm" role="alertdialog" aria-label="Ungespeicherte Änderungen">
            <span>Ungespeicherte Änderungen an „{draft.name.trim() || "Preset"}“.</span>
            <button
              type="button"
              className="mode-btn active"
              autoFocus
              onClick={async () => {
                await save(false);
                onClose();
              }}
            >
              Speichern & schließen
            </button>
            <button type="button" className="mode-btn danger" onClick={onClose}>
              Verwerfen
            </button>
            <button type="button" className="mode-btn" onClick={() => setConfirmClose(false)}>
              Weiter bearbeiten
            </button>
          </div>
        )}

        <div className="studio-body">
          <div className="studio-main">
            {tab === "tweak" && (
              <div className="studio-tweak">
                <p className="set-note">
                  Die Grundwerte des Presets verbiegen — Bewegung, Nachleuchten, Welle,
                  Farbe. Rechts siehst du es live; gespeichert wird mit „Speichern“.
                </p>
                <MdTweakPanel
                  presetKey={initialKey}
                  baseVals={plainBaseVals}
                  overrides={draft.overrides}
                  onChange={(k, v) => edit((d) => ({ ...d, overrides: { ...d.overrides, [k]: v } }))}
                  onReset={() => edit((d) => ({ ...d, overrides: {} }))}
                  onResetKey={(k) =>
                    edit((d) => {
                      const o = { ...d.overrides };
                      delete o[k];
                      return { ...d, overrides: o };
                    })
                  }
                  onSave={() => {}}
                  onDeleteUser={() => {}}
                  footer={false}
                />
              </div>
            )}
            {tab === "parts" && (
              <div className="studio-parts">
                <p className="set-note">
                  Jeder Baustein kommt aus einem Preset deiner Wahl — oder aus
                  der Basis. So entstehen Mashups: Bewegung von hier, Shader von
                  dort.
                </p>
                <label className="studio-row">
                  <span>Basis</span>
                  <select className="src-select" value={draft.base} onChange={(e) => edit((d) => ({ ...d, base: e.target.value }))}>
                    {!draft.base && <option value="">— importiert, alles eigen —</option>}
                    {keyOptions}
                  </select>
                  <span />
                </label>
                {SLOT_PARTS.map((part) => (
                  <label key={part} className="studio-row">
                    <span>{PART_LABELS[part]}</span>
                    <select className="src-select" value={partValue(draft.parts[part])} onChange={(e) => setPart(part, e.target.value)}>
                      <option value="">— aus der Basis —</option>
                      {partValue(draft.parts[part]) === "__inline" && <option value="__inline">✎ eigener Code</option>}
                      {keyOptions}
                    </select>
                    <button type="button" className="mode-btn" title="Zufällig aus Favoriten (oder allen)" onClick={() => setPart(part, randomKey())}>
                      🎲
                    </button>
                  </label>
                ))}
                {(["waves", "shapes"] as const).map((list) => (
                  <div key={list} className="studio-slots">
                    <h4>{list === "waves" ? "Eigene Wellen" : "Formen"}</h4>
                    {[0, 1, 2, 3].map((i) => (
                      <label key={i} className="studio-row">
                        <span>
                          {list === "waves" ? "Welle" : "Form"} {i + 1}
                          <small className={slotOn(list, i) ? "on" : ""}>{slotOn(list, i) ? " · an" : " · aus"}</small>
                        </span>
                        <select className="src-select" value={partValue(draft.parts[list]?.[i])} onChange={(e) => setSlot(list, i, e.target.value)}>
                          <option value="">— aus der Basis —</option>
                          {draft.parts[list]?.[i] && !isRef(draft.parts[list]?.[i]) && <option value="__inline">✎ eigen</option>}
                          {keyOptions}
                        </select>
                        <button type="button" className="mode-btn" onClick={() => setSlot(list, i, randomKey())}>
                          🎲
                        </button>
                      </label>
                    ))}
                  </div>
                ))}
                <div className="studio-actions">
                  <button type="button" className="mode-btn" onClick={shuffleAll}>
                    🎲 Mashup würfeln
                  </button>
                  <button type="button" className="mode-btn" onClick={() => edit((d) => ({ ...d, parts: {} }))}>
                    Alle Bausteine zurück auf die Basis
                  </button>
                </div>
              </div>
            )}

            {tab === "code" && (
              <div className="studio-code">
                <div className="studio-codetabs">
                  {CODE_PARTS.map((p) => (
                    <button key={p} className={`chip ${codePart === p ? "on" : ""}`} onClick={() => setCodePart(p)}>
                      {PART_LABELS[p]}
                      {draft.parts[p] && !isRef(draft.parts[p]) ? " ✎" : ""}
                    </button>
                  ))}
                </div>
                <div className="studio-codehint">
                  {codeIsInline
                    ? "Eigener Code — Änderungen laufen nach einer kurzen Pause live in der Vorschau."
                    : `Kommt aus ${isRef(draft.parts[codePart]) ? label((draft.parts[codePart] as { from: string }).from) : "der Basis"}. Tippen macht eine eigene Kopie.`}
                  {codeIsInline && (
                    <button
                      type="button"
                      className="chip"
                      onClick={() =>
                        edit((d) => {
                          delete d.parts[codePart];
                          return d;
                        })
                      }
                    >
                      Zurück auf die Quelle
                    </button>
                  )}
                </div>
                <CodeArea value={code} onChange={onCode} />
                <details className="studio-ref">
                  <summary>Spickzettel: Milkdrop-Variablen</summary>
                  <dl>
                    {EEL_REFERENCE.map(([k, v]) => (
                      <div key={k}>
                        <dt>{k}</dt>
                        <dd>{v}</dd>
                      </div>
                    ))}
                  </dl>
                </details>
              </div>
            )}

            {tab === "remix" && (
              <div className="studio-remix">
                <p className="set-note">
                  Kinder des aktuellen Entwurfs. Jedes wird kurz probegerendert;
                  was trappt, schwarz oder flach bleibt, fliegt raus. Klick
                  zeigt ein Kind in der Vorschau, „Übernehmen“ macht es zum
                  Entwurf.
                </p>
                <div className="studio-row">
                  <span>Stärke</span>
                  <input type="range" min={0.1} max={1.5} step={0.05} value={strength} onChange={(e) => setStrength(Number(e.target.value))} />
                  <output>{strength.toFixed(2)}</output>
                </div>
                <label className="set-row set-row-toggle">
                  <input type="checkbox" checked={mutCode} onChange={(e) => setMutCode(e.target.checked)} />
                  <span className="set-label">
                    Auch Zahlen in den Gleichungen verändern
                    <small className="set-hint">Wilder, aber öfter kaputt — der Probelauf sortiert aus</small>
                  </span>
                </label>
                <div className="studio-actions">
                  <button type="button" className="mode-btn" disabled={busy} onClick={() => void breed("mutate")}>
                    Mutieren
                  </button>
                  <select className="src-select" value={partner} onChange={(e) => setPartner(e.target.value)} aria-label="Partner zum Kreuzen">
                    <option value="">Partner: zufällig</option>
                    {keyOptions}
                  </select>
                  <button type="button" className="mode-btn" disabled={busy} onClick={() => void breed("cross")}>
                    Kreuzen
                  </button>
                </div>
                <div className="studio-children">
                  {children.map((c, i) => (
                    <button
                      key={i}
                      type="button"
                      className={`studio-child ${c.ok ? "" : "bad"} ${picked === i ? "on" : ""}`}
                      disabled={!c.ok}
                      onClick={() => {
                        setPicked(i);
                        setPreviewOverride(compose(c.preset, resolveAt));
                      }}
                      title={c.ok ? "In der Vorschau zeigen" : c.reason}
                    >
                      {c.thumb ? <img src={c.thumb} alt="" /> : <div className="studio-child-ph" />}
                      <span>{c.ok ? `Kind ${i + 1}` : `✕ ${c.reason}`}</span>
                    </button>
                  ))}
                  {busy && <div className="studio-busy">probiert…</div>}
                </div>
                {picked !== null && children[picked] && (
                  <div className="studio-actions">
                    <button
                      type="button"
                      className="mode-btn active"
                      onClick={() => {
                        const child = children[picked].preset;
                        edit(() => ({ ...child, name: draft.name, id: draft.id }));
                        setPreviewOverride(null);
                        setPicked(null);
                        setStatus("Kind übernommen — speichern nicht vergessen");
                      }}
                    >
                      Übernehmen
                    </button>
                    <button
                      type="button"
                      className="mode-btn"
                      onClick={() => {
                        setPreviewOverride(null);
                        setPicked(null);
                      }}
                    >
                      Zurück zum Entwurf
                    </button>
                  </div>
                )}
              </div>
            )}

            {tab === "ai" && (
              <div className="studio-remix">
                <p className="set-note">
                  Ein lokales Sprachmodell ändert den Entwurf nach deiner
                  Anweisung — über jeden Server mit OpenAI-kompatibler
                  Schnittstelle (Ollama, LM Studio, llama.cpp). Kleine Modelle
                  drehen vor allem an Werten und Konstanten; für neue
                  Algorithmen ist ein großes Modell oder die Claude-Code-Brücke
                  (Einstellungen → System) die bessere Wahl.
                </p>
                <label className="studio-row">
                  <span>Server</span>
                  <input className="studio-name" value={llm.url} onChange={(e) => updateLlm({ ...llm, url: e.target.value })} />
                  <button type="button" className="mode-btn" onClick={() => void fetchModels()}>
                    Verbinden
                  </button>
                </label>
                <label className="studio-row">
                  <span>Modell</span>
                  {models.length ? (
                    <select className="src-select" value={llm.model} onChange={(e) => updateLlm({ ...llm, model: e.target.value })}>
                      {models.map((m) => (
                        <option key={m} value={m}>
                          {m}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input className="studio-name" value={llm.model} placeholder="z. B. qwen2.5-coder:14b" onChange={(e) => updateLlm({ ...llm, model: e.target.value })} />
                  )}
                  <span />
                </label>
                <textarea
                  className="studio-instruction"
                  value={instruction}
                  onChange={(e) => setInstruction(e.target.value)}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) void runAgent();
                  }}
                  placeholder="Was soll anders werden? z. B. „kälter und langsamer, die Spirale soll auf den Bass pumpen“"
                  rows={4}
                />
                <div className="studio-actions">
                  <button type="button" className="mode-btn active" disabled={aiBusy || !llm.model || !instruction.trim()} onClick={() => void runAgent()} title="Strg+Enter">
                    {aiBusy ? "denkt…" : "Vorschlagen"}
                  </button>
                  <span className="mdlib-hint">{aiMsg}</span>
                </div>
                {aiResult && (
                  <div className="studio-ai-result">
                    {aiResult.note && <p className="set-note">„{aiResult.note}“</p>}
                    {!aiResult.ok && <pre className="studio-err">{aiResult.reason}</pre>}
                    <div className="studio-actions">
                      <button
                        type="button"
                        className="mode-btn active"
                        disabled={!aiResult.ok}
                        onClick={() => {
                          edit(() => ({ ...aiResult.preset, name: draft.name }));
                          setPreviewOverride(null);
                          setAiResult(null);
                          setStatus("KI-Vorschlag übernommen — speichern nicht vergessen");
                        }}
                      >
                        Übernehmen
                      </button>
                      <button
                        type="button"
                        className="mode-btn"
                        onClick={() => {
                          setPreviewOverride(null);
                          setAiResult(null);
                        }}
                      >
                        Verwerfen
                      </button>
                    </div>
                    <details className="studio-ref">
                      <summary>Rohe Antwort des Modells</summary>
                      <pre className="studio-raw">{aiResult.raw}</pre>
                    </details>
                  </div>
                )}
              </div>
            )}
          </div>

          <aside className="studio-side">
            <canvas ref={tileRef} className="mdlib-tile" />
            {previewOverride !== null && <div className="mdlib-hint">Vorschau: Remix-Kind, nicht der Entwurf</div>}
            {error && <pre className="studio-err">{error}</pre>}
            <h4>Tags</h4>
            <TagChips
              selected={draftTags}
              onToggle={(t) => {
                const name = tagStore.ensureTag(t);
                setDraftTags((cur) => (cur.includes(name) ? cur.filter((x) => x !== name) : [...cur, name]));
                setDirty(true);
              }}
              allowCreate
            />
            {draft.lineage && (
              <div className="mdlib-hint">
                Herkunft: {draft.lineage.op} aus {draft.lineage.parents.map(label).join(" + ") || "—"}
              </div>
            )}
            <div className="studio-actions">
              <button type="button" className="mode-btn active" onClick={() => void save(false)} title="Strg+S">
                💾 {savedAs ? "Speichern" : "Als eigenes Preset speichern"}
              </button>
              {savedAs && (
                <button type="button" className="mode-btn" onClick={() => void save(true)}>
                  Als neues speichern
                </button>
              )}
              <button
                type="button"
                className="mode-btn"
                onClick={async () => {
                  const key = dirty || !savedAs ? await save(false) : `user:${savedAs}`;
                  onApply(key);
                }}
              >
                ▶ Im Hauptbild spielen
              </button>
            </div>
            <div className="studio-actions small">
              <button type="button" className="chip" onClick={() => void exportJson()}>
                Kopieren (Vizzy)
              </button>
              <button type="button" className="chip" onClick={() => void exportButterchurn()}>
                Kopieren (Butterchurn)
              </button>
              <button type="button" className="chip" onClick={() => fileRef.current?.click()}>
                Importieren…
              </button>
              <button type="button" className="chip" onClick={() => void presetStore.openFolder()}>
                Preset-Ordner
              </button>
              <input
                ref={fileRef}
                type="file"
                accept=".json,application/json"
                hidden
                onChange={async (e) => {
                  const f = e.target.files?.[0];
                  e.target.value = "";
                  if (!f) return;
                  try {
                    const p = await presetStore.importJson(await f.text(), f.name.replace(/\.json$/i, ""));
                    if (!p) setStatus("Keine Vizzy- oder Butterchurn-Preset-Datei");
                    else {
                      setDraft(JSON.parse(JSON.stringify(p)));
                      setSavedAs(p.name);
                      setDirty(false);
                      setStatus(`Importiert als „${p.name}“`);
                    }
                  } catch (err) {
                    setStatus(`Import fehlgeschlagen: ${err}`);
                  }
                }}
              />
            </div>
            <div className="mdlib-foot">
              <span>{dirty ? "● ungespeichert" : status || (savedAs ? `Datei: ${savedAs}` : "noch nicht gespeichert")}</span>
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}

/** A code field with line numbers and tab indentation; plain textarea
 *  underneath so nothing about typing or IME is reinvented. */
function CodeArea({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const lines = value.split("\n").length;
  const gutterRef = useRef<HTMLDivElement | null>(null);
  return (
    <div className="codearea">
      <div className="codearea-gutter" ref={gutterRef} aria-hidden="true">
        {Array.from({ length: lines }, (_, i) => (
          <div key={i}>{i + 1}</div>
        ))}
      </div>
      <textarea
        spellCheck={false}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onScroll={(e) => {
          if (gutterRef.current) gutterRef.current.scrollTop = e.currentTarget.scrollTop;
        }}
        onKeyDown={(e) => {
          if (e.key === "Tab") {
            e.preventDefault();
            const t = e.currentTarget;
            const { selectionStart: a, selectionEnd: b } = t;
            const next = value.slice(0, a) + "  " + value.slice(b);
            onChange(next);
            requestAnimationFrame(() => {
              t.selectionStart = t.selectionEnd = a + 2;
            });
          }
          e.stopPropagation();
        }}
      />
    </div>
  );
}
