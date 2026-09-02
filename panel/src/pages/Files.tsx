import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from "react";
import { fsList, fsRead, fsWrite, fsUpload, fsRawUrl, getHosts, getAgents, sendToPane, type FsEntry, type FsListing, type FsFile, type FedHost, type PaneRef } from "../lib/api";
import { childPath, destinationDir, directorySelection } from "../lib/file-manager";

// CodeMirror (VS Code look: One Dark + line numbers + syntax) is heavy → its own chunk,
// downloaded only when a text file is opened
const CodeEditor = lazy(() => import("../components/CodeEditor"));

type Props = { onToast?: (text: string, live: boolean) => void; focusPath?: string };

const human = (n: number) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);
const when = (ms: number) => (ms ? new Date(ms).toLocaleString("es-PR", { dateStyle: "short", timeStyle: "short" }) : "nuevo");
const base = (p: string) => p.split("/").pop() || p;
const kindOf = (mime: string) =>
  mime.startsWith("image/") ? "image" : mime.startsWith("audio/") ? "audio" : mime.startsWith("video/") ? "video" : mime.startsWith("application/pdf") ? "pdf" : "other";

// frosted-glass building blocks (iOS-style): translucent gradient + blur + hairline highlight.
// The ambient glows behind the page are what make the blur readable — glass over flat black is invisible.
const glass = "rounded-2xl border border-white/[0.08] bg-gradient-to-b from-white/[0.09] to-white/[0.035] backdrop-blur-2xl shadow-[inset_0_1px_0_rgba(255,255,255,0.08),0_18px_44px_-22px_rgba(0,0,0,0.85)]";
const glassPill = "rounded-full border border-white/10 bg-white/[0.07] backdrop-blur-xl transition hover:bg-white/[0.13] active:scale-95";
const glassField = "rounded-xl border border-white/10 bg-white/[0.06] backdrop-blur-xl placeholder:text-white/30 focus:border-accent/60 focus:bg-white/[0.09] focus:outline-none";

// file-type icon tiles (mini, tree-sized): white glyph on a colored gradient squircle
type Tile = { bg: string; glyph: ReactNode };
const G = ({ d, className = "h-3.5 w-3.5" }: { d: string; className?: string }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true"><path d={d} /></svg>
);
const TILES: Record<string, Tile> = {
  folder: { bg: "from-sky-400 to-blue-600", glyph: <G d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /> },
  image: { bg: "from-fuchsia-400 to-purple-600", glyph: <G d="M4 5h16v14H4zM4 15l4.5-4.5 3.5 3.5 3-3L20 16M9 9.5h.01" /> },
  pdf: { bg: "from-red-400 to-rose-600", glyph: <G d="M7 3h7l4 4v14H7zM14 3v4h4M10 12h4M10 16h4" /> },
  audio: { bg: "from-pink-400 to-rose-500", glyph: <G d="M9 18V6l10-2v12M9 18a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0zM19 16a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0z" /> },
  video: { bg: "from-amber-400 to-orange-600", glyph: <G d="M4 6h16v12H4zM4 9h16M8 6v12M16 6v12" /> },
  code: { bg: "from-emerald-400 to-teal-600", glyph: <G d="m9 8-4 4 4 4M15 8l4 4-4 4" /> },
  doc: { bg: "from-slate-400 to-slate-600", glyph: <G d="M7 3h7l4 4v14H7zM14 3v4h4M10 12h6M10 16h6" /> },
};
const tileFor = (e: FsEntry): Tile => {
  if (e.dir) return TILES.folder;
  if (/\.(png|jpe?g|gif|webp|svg|ico|heic)$/i.test(e.name)) return TILES.image;
  if (/\.pdf$/i.test(e.name)) return TILES.pdf;
  if (/\.(mp3|m4a|wav|ogg|flac|aac)$/i.test(e.name)) return TILES.audio;
  if (/\.(mp4|webm|mov|mkv)$/i.test(e.name)) return TILES.video;
  if (/\.(ts|tsx|js|jsx|mjs|py|go|rs|swift|sh|json|yml|yaml|toml|css|html)$/i.test(e.name)) return TILES.code;
  return TILES.doc;
};
const FileTile = ({ entry }: { entry: FsEntry }) => (
  <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-gradient-to-b ${tileFor(entry).bg} shadow-[inset_0_1px_0_rgba(255,255,255,0.35),0_2px_5px_-2px_rgba(0,0,0,0.6)]`}>
    {tileFor(entry).glyph}
  </span>
);

// VS Code-style file browser (collapsible tree, lazy-loaded per folder) + viewer/editor.
// Every call rides ?host= so picking a federated host walks THAT machine's disk. Text edits
// save atomically with an optimistic lock — a conflicting agent write asks before clobbering.
export default function Files({ onToast, focusPath }: Props) {
  const [hosts, setHosts] = useState<FedHost[]>([]);
  const [host, setHost] = useState(""); // "" = this machine
  const [listing, setListing] = useState<FsListing | null>(null); // tree ROOT
  const [kids, setKids] = useState<Record<string, FsEntry[]>>({}); // children per expanded dir
  const [expanded, setExpanded] = useState<string[]>([]);
  const [selectedDir, setSelectedDir] = useState("");
  const [loadingDir, setLoadingDir] = useState("");
  const [listErr, setListErr] = useState("");
  const [pathInput, setPathInput] = useState("");
  const [showHidden, setShowHidden] = useState(false);
  const [file, setFile] = useState<FsFile | null>(null); // what the server handed us
  const [draft, setDraft] = useState(""); // editor buffer
  const [saving, setSaving] = useState(false);
  const [opening, setOpening] = useState("");
  const [uploadBusy, setUploadBusy] = useState(false);
  const uploadRef = useRef<HTMLInputElement>(null);
  const dirty = !!file && file.kind === "text" && draft !== (file.content ?? "");
  const hq = host || undefined;
  const memKey = `mt3k.files.${host || "local"}`;
  const targetDir = listing ? destinationDir(listing.path, selectedDir) : "";

  useEffect(() => { getHosts().then((r) => setHosts((r?.hosts ?? []).filter((h) => h.reachable))); }, []);

  // navigate the tree ROOT (breadcrumbs / path input / quick picks) — resets the expansion state
  const load = async (p: string) => {
    const r = await fsList(p, hq);
    if (r?.ok) {
      setListing(r); setKids({ [r.path]: r.entries }); setExpanded([]); setSelectedDir(r.path); setPathInput(r.path); setListErr("");
      try { localStorage.setItem(memKey, r.path); } catch { /* private mode */ }
    } else {
      setListErr(r?.err ?? "no se pudo listar esa carpeta");
    }
  };

  // switching host: forget the open file, resume where you left off on that host
  useEffect(() => {
    let start = "~";
    try { start = localStorage.getItem(memKey) || "~"; } catch { /* defaults */ }
    if (!host && focusPath) start = focusPath; // Focus mode: land in the project (local host only)
    setFile(null); setDraft("");
    load(start);
  }, [host, focusPath]); // eslint-disable-line react-hooks/exhaustive-deps

  // expand/collapse a folder in place; children fetch once and cache for the session
  const toggleDir = async (p: string) => {
    const selection = directorySelection(listing?.path ?? "", p);
    setSelectedDir(selection.selectedDir);
    setPathInput(selection.pathInput);
    if (expanded.includes(p)) {
      setExpanded((x) => x.filter((e) => e !== p && !e.startsWith(p + "/"))); // collapse children too
      return;
    }
    if (!kids[p]) {
      setLoadingDir(p);
      const r = await fsList(p, hq);
      setLoadingDir("");
      if (!r?.ok) { onToast?.(r?.err ?? "no se pudo abrir la carpeta", false); return; }
      setKids((k) => ({ ...k, [p]: r.entries }));
    }
    setExpanded((x) => [...x, p]);
  };

  const confirmDiscard = () => !dirty || window.confirm("Tienes cambios sin guardar. ¿Descartarlos?");

  const open = async (p: string) => {
    if (!confirmDiscard()) return;
    setOpening(p);
    const r = await fsRead(p, hq);
    setOpening("");
    if (r?.ok) { setFile(r); setDraft(r.content ?? ""); }
    else onToast?.(r?.err ?? "no se pudo abrir", false);
  };

  const write = async (expectMtime?: number) => {
    if (!file) return;
    setSaving(true);
    const r = await fsWrite(file.path, draft, expectMtime, hq);
    setSaving(false);
    if (r?.ok) {
      setFile({ ...file, content: draft, mtime: r.mtime ?? Date.now(), size: new Blob([draft]).size });
      onToast?.(`guardado · ${base(file.path)}`, true);
      const dir = file.path.slice(0, file.path.lastIndexOf("/")) || "/";
      const rl = await fsList(dir, hq); // refresh sizes in that branch
      if (rl?.ok) setKids((k) => (k[dir] ? { ...k, [dir]: rl.entries } : k));
    } else if (r?.conflict) {
      if (window.confirm(`${r.err}.\n¿Sobrescribir con tu versión?`)) write(undefined);
    } else {
      onToast?.(r?.err ? `error: ${r.err}` : "no se pudo guardar", false);
    }
  };
  const save = () => { if (file && !saving && (dirty || !file.mtime)) write(file.mtime || undefined); };

  const newFile = () => {
    if (!targetDir || !confirmDiscard()) return;
    const name = window.prompt(`Nombre del archivo nuevo en ${targetDir}:`);
    if (!name?.trim() || name.includes("/")) return;
    setFile({ ok: true, path: childPath(targetDir, name.trim()), kind: "text", mime: "text/plain", content: "", size: 0, mtime: 0 });
    setDraft("");
  };

  const uploadHere = (picked: File) => {
    if (!targetDir || uploadBusy) return;
    if (picked.size > 25 * 1024 * 1024) { onToast?.("archivo demasiado grande (máx 25MB)", false); return; }
    setUploadBusy(true);
    const reader = new FileReader();
    reader.onerror = () => { setUploadBusy(false); onToast?.("no se pudo leer el archivo", false); };
    reader.onload = async () => {
      const send = (overwrite: boolean) => fsUpload(targetDir, picked.name, String(reader.result), overwrite, hq);
      let r = await send(false);
      if (r?.exists && window.confirm(`Ya existe «${picked.name}» en ${targetDir}. ¿Sobrescribirlo?`)) r = await send(true);
      setUploadBusy(false);
      if (r?.ok) {
        onToast?.(`subido · ${picked.name}`, true);
        const rl = await fsList(targetDir, hq);
        if (rl?.ok) setKids((k) => ({ ...k, [targetDir]: rl.entries }));
      } else if (!r?.exists) {
        onToast?.(r?.err ? `error: ${r.err}` : "no se pudo subir", false);
      }
    };
    reader.readAsDataURL(picked);
  };

  const closeFile = () => { if (confirmDiscard()) { setFile(null); setDraft(""); } };

  // "enviar al agente": paste this file's path into a live session ON THE SAME HOST
  const [sendOpen, setSendOpen] = useState(false);
  const [sendTargets, setSendTargets] = useState<{ agent: string; pane: PaneRef }[]>([]);
  const openSend = async () => {
    const r = await getAgents();
    const rows = (r?.agents ?? []).filter((a) => (a.host ?? "") === host);
    const t = rows.flatMap((a) => (a.panes ?? []).map((pn) => ({ agent: a.name, pane: pn })));
    setSendTargets(t); setSendOpen(true);
    if (t.length === 0) onToast?.("no hay sesiones vivas en este host", false);
  };
  const sendPathTo = async (paneId: string) => {
    if (!file) return;
    const r = await sendToPane(paneId, `Mira este archivo: ${file.path}`, true, hq);
    setSendOpen(false);
    onToast?.(r?.ok ? "ruta enviada a la sesión" : (r?.err ?? "no se pudo enviar"), !!r?.ok);
  };
  const copyPath = () => { if (file) navigator.clipboard.writeText(file.path).then(() => onToast?.("ruta copiada", true), () => onToast?.("no se pudo copiar", false)); };

  const prep = (list: FsEntry[]) => list
    .filter((e) => showHidden || !e.name.startsWith("."))
    .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name, undefined, { numeric: true }));

  // recursive tree rows, VS Code-style: chevron + indent, folders expand in place
  const renderDir = (dirPath: string, depth: number): ReactNode =>
    prep(kids[dirPath] ?? []).map((e) => {
      const full = `${dirPath.replace(/\/$/, "")}/${e.name}`;
      const isOpen = expanded.includes(full);
      const active = e.dir ? selectedDir === full : file?.path === full;
      return (
        <div key={full}>
          <button onClick={() => (e.dir ? toggleDir(full) : open(full))} disabled={opening === full}
            aria-pressed={e.dir ? selectedDir === full : undefined}
            style={{ paddingLeft: `${10 + depth * 16}px` }}
            className={`flex w-full items-center gap-2 rounded-lg py-[5px] pr-2 text-left transition hover:bg-white/[0.07] active:scale-[0.995] ${active ? "bg-accent/15" : ""}`}>
            <span className={`w-3 shrink-0 text-center text-[10px] text-white/35 transition-transform ${e.dir ? (isOpen ? "rotate-90" : "") : "opacity-0"}`}>▶</span>
            <FileTile entry={e} />
            <span className={`min-w-0 flex-1 truncate text-[12.5px] ${e.dir ? "font-medium text-white/95" : "text-white/80"}`}>{e.name}</span>
            {!e.dir && <span className="shrink-0 font-mono text-[9.5px] text-white/30">{human(e.size)}</span>}
            {loadingDir === full && <span className="shrink-0 font-mono text-[9px] text-white/40">…</span>}
          </button>
          {e.dir && isOpen && (
            (kids[full]?.length ?? 1) === 0 || prep(kids[full] ?? []).length === 0
              ? <div style={{ paddingLeft: `${10 + (depth + 1) * 16 + 20}px` }} className="py-1 font-mono text-[10px] text-white/25">vacía</div>
              : renderDir(full, depth + 1)
          )}
        </div>
      );
    });

  const locationPath = selectedDir || listing?.path || "";
  const crumbs = locationPath.split("/").filter(Boolean);
  const raw = file ? fsRawUrl(file.path, hq) : "";
  const kind = file ? kindOf(file.mime) : "other";

  return (
    <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden p-4 sm:p-6">
      {/* ambient glows the frosted panels blur — this is what sells the glass */}
      <div aria-hidden className="pointer-events-none absolute -top-32 right-[-8%] h-96 w-96 rounded-full bg-accent/25 blur-[120px]" />
      <div aria-hidden className="pointer-events-none absolute bottom-[-25%] left-[-8%] h-[30rem] w-[30rem] rounded-full bg-sky-500/20 blur-[140px]" />
      <div aria-hidden className="pointer-events-none absolute left-1/3 top-1/4 h-72 w-72 rounded-full bg-fuchsia-500/10 blur-[110px]" />

      <div className="relative mb-3 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Files</h1>
          <p className="font-mono text-xs text-white/45">explora, mira y edita archivos del host{hosts.length ? " — local o federado" : ""}</p>
        </div>
        <div className="flex items-center gap-2">
          {hosts.length > 0 && (
            <select value={host} onChange={(e) => { if (confirmDiscard()) setHost(e.target.value); }}
              className={`${glassField} appearance-none px-3 py-1.5 font-mono text-xs text-white`}>
              <option value="">local · esta máquina</option>
              {hosts.map((h) => <option key={h.id} value={h.id}>{h.name}</option>)}
            </select>
          )}
          <label className={`${glassPill} flex cursor-pointer items-center gap-1.5 px-3 py-1.5 font-mono text-[11px] text-white/60`}>
            <input type="checkbox" checked={showHidden} onChange={(e) => setShowHidden(e.target.checked)} className="accent-[oklch(62%_0.23_25)]" /> ocultos
          </label>
        </div>
      </div>

      {/* path bar: breadcrumb pills to tap + free-form input for typing a path on desktop */}
      <form onSubmit={(e) => { e.preventDefault(); load(pathInput.trim() || "~"); }} className="relative mb-2 flex gap-2">
        <input value={pathInput} onChange={(e) => setPathInput(e.target.value)} spellCheck={false} autoCapitalize="off" placeholder="~"
          className={`${glassField} min-w-0 flex-1 px-3.5 py-2 font-mono text-sm text-white`} />
        <button type="submit" className={`${glassPill} px-4 py-2 font-mono text-xs text-white/70 hover:text-accent`}>ir</button>
      </form>
      <div className="relative mb-3 flex items-center gap-1.5 overflow-x-auto pb-1 md:flex-wrap md:overflow-visible md:pb-0 [&>button]:shrink-0">
        <button onClick={() => load("/")} className={`${glassPill} px-2.5 py-1 font-mono text-[10px] text-white/55`}>/</button>
        {crumbs.map((c, i) => (
          <button key={i} onClick={() => load("/" + crumbs.slice(0, i + 1).join("/"))}
            className={`rounded-full px-2.5 py-1 font-mono text-[10px] transition active:scale-95 ${i === crumbs.length - 1 ? "border border-accent/50 bg-accent/25 text-white shadow-[0_0_18px_-6px] shadow-accent backdrop-blur-xl" : `${glassPill} text-white/55`}`}>
            {c}
          </button>
        ))}
        <span className="mx-1 text-white/15">·</span>
        {listing?.quick.map((q) => (
          <button key={q.path} onClick={() => load(q.path)} title={q.path}
            className={`${glassPill} border-dashed px-2.5 py-1 font-mono text-[10px] text-white/45 hover:text-accent`}>
            {q.name}
          </button>
        ))}
      </div>

      <div className="relative grid min-h-0 flex-1 gap-4 md:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        {/* tree — on the phone it yields the screen to the viewer while a file is open */}
        <div className={`${glass} flex min-h-0 flex-col overflow-hidden ${file ? "hidden md:flex" : ""}`}>
          {listErr ? (
            <div className="p-6 text-center font-mono text-xs text-amber-300/80">{listErr}</div>
          ) : (
            <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
              {listing && listing.path !== "/" && (
                <button onClick={() => load(listing.parent)}
                  className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left font-mono text-[11px] text-white/45 transition hover:bg-white/[0.07]">
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg border border-white/10 bg-white/[0.06]"><G d="m12 19-7-7 7-7M5 12h14" className="h-3 w-3" /></span>
                  ..
                </button>
              )}
              {listing && renderDir(listing.path, 0)}
              {listing && prep(kids[listing.path] ?? []).length === 0 && <div className="p-8 text-center font-mono text-xs text-white/35">carpeta vacía</div>}
            </div>
          )}
          {listing && (
            <div className="border-t border-white/[0.07] p-2">
              <div className="mb-2 truncate px-1 font-mono text-[9px] text-white/35" title={targetDir}>destino · {targetDir}</div>
              <div className="flex gap-2">
                <input ref={uploadRef} type="file" className="hidden" aria-label="seleccionar archivo para subir"
                  onChange={(e) => { const picked = e.target.files?.[0]; if (picked) uploadHere(picked); e.target.value = ""; }} />
                <button onClick={newFile} className={`${glassPill} flex-1 border-dashed px-3 py-2 font-mono text-[11px] text-white/50 hover:text-accent`}>＋ archivo</button>
                <button onClick={() => uploadRef.current?.click()} disabled={uploadBusy}
                  className={`${glassPill} flex-1 border-dashed px-3 py-2 font-mono text-[11px] text-white/50 hover:text-accent disabled:opacity-40`}>
                  {uploadBusy ? "subiendo…" : "⬆ subir"}
                </button>
              </div>
            </div>
          )}
        </div>

        {/* viewer / editor */}
        <div className={`${glass} flex min-h-0 flex-col overflow-hidden ${file ? "" : "hidden md:flex"}`}>
          {!file ? (
            <div className="flex flex-1 items-center justify-center p-8 text-center">
              <div>
                <div className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-2xl border border-white/10 bg-white/[0.05] shadow-[inset_0_1px_0_rgba(255,255,255,0.1)]"><G d="M7 3h7l4 4v14H7zM14 3v4h4" className="h-5 w-5" /></div>
                <div className="font-mono text-xs text-white/40">elige un archivo para verlo o editarlo</div>
              </div>
            </div>
          ) : (
            <>
              <header className="flex items-center justify-between gap-2 border-b border-white/[0.07] bg-white/[0.03] px-3.5 py-2.5 backdrop-blur-xl">
                <div className="min-w-0">
                  <div className="truncate text-[13px] font-semibold text-white">{base(file.path)}{dirty && <span className="ml-1.5 text-amber-300">●</span>}</div>
                  <div className="truncate font-mono text-[10px] text-white/40">{human(file.size)} · {when(file.mtime)} · {file.mime.split(";")[0]}</div>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <button onClick={copyPath} title="copiar ruta" className={`${glassPill} px-2.5 py-1.5 font-mono text-[10px] text-white/60`}>⧉ ruta</button>
                  <div className="relative">
                    <button onClick={openSend} title="pegar la ruta en una sesión viva de este host" className={`${glassPill} px-2.5 py-1.5 font-mono text-[10px] text-white/60`}>➤ agente</button>
                    {sendOpen && sendTargets.length > 0 && (
                      <>
                        <div className="fixed inset-0 z-40" onClick={() => setSendOpen(false)} />
                        <div className="absolute right-0 top-9 z-50 w-64 rounded-xl border border-white/10 bg-ink-900/95 p-1.5 shadow-2xl backdrop-blur-xl">
                          {sendTargets.map((t) => (
                            <button key={t.pane.paneId} onClick={() => sendPathTo(t.pane.paneId)}
                              className="flex w-full flex-col rounded-lg px-2.5 py-1.5 text-left transition hover:bg-white/[0.08]">
                              <span className="font-mono text-[11px] text-white">{t.agent}</span>
                              <span className="truncate font-mono text-[9px] text-white/40">{t.pane.cwd}</span>
                            </button>
                          ))}
                        </div>
                      </>
                    )}
                  </div>
                  {file.kind === "text" && (
                    <button onClick={save} disabled={saving || (!dirty && !!file.mtime)}
                      className="rounded-full border border-accent/40 bg-gradient-to-b from-accent/40 to-accent/20 px-3.5 py-1.5 font-mono text-[11px] font-medium text-white shadow-[0_0_20px_-8px] shadow-accent backdrop-blur-xl transition hover:from-accent/50 active:scale-95 disabled:opacity-35 disabled:shadow-none">
                      {saving ? "guardando…" : "guardar"}
                    </button>
                  )}
                  <button onClick={closeFile} className={`${glassPill} px-2.5 py-1.5 font-mono text-[10px] text-white/60`}>✕</button>
                </div>
              </header>
              <div className="min-h-0 flex-1 overflow-auto">
                {file.kind === "text" ? (
                  <Suspense fallback={<div className="p-6 text-center font-mono text-xs text-white/40">cargando editor…</div>}>
                    <CodeEditor key={`${host}:${file.path}`} value={file.content ?? ""} filename={base(file.path)} onChange={setDraft} onSave={save} />
                  </Suspense>
                ) : kind === "image" ? (
                  <img src={raw} alt={base(file.path)} className="mx-auto max-h-full max-w-full rounded-xl object-contain p-3" />
                ) : kind === "pdf" ? (
                  <iframe src={raw} title={base(file.path)} className="h-full min-h-[70vh] w-full" />
                ) : kind === "audio" ? (
                  <div className="p-6"><audio controls src={raw} className="w-full" /></div>
                ) : kind === "video" ? (
                  <video controls src={raw} className="max-h-full w-full rounded-xl p-2" />
                ) : (
                  <div className="p-8 text-center font-mono text-xs text-white/50">
                    {file.tooBig ? "demasiado grande para editar aquí (máx 2MB)" : "archivo binario — sin vista previa"}
                    <div className="mt-3"><a href={raw} download={base(file.path)} className={`${glassPill} inline-block px-4 py-2 text-white/70 hover:text-accent`}>⬇ descargar</a></div>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
