import { useEffect, useState } from "react";
import { fsList, fsRead, fsWrite, fsRawUrl, getHosts, type FsEntry, type FsListing, type FsFile, type FedHost } from "../lib/api";

type Props = { onToast?: (text: string, live: boolean) => void };

const human = (n: number) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);
const when = (ms: number) => (ms ? new Date(ms).toLocaleString("es-PR", { dateStyle: "short", timeStyle: "short" }) : "nuevo");
const base = (p: string) => p.split("/").pop() || p;
const kindOf = (mime: string) =>
  mime.startsWith("image/") ? "image" : mime.startsWith("audio/") ? "audio" : mime.startsWith("video/") ? "video" : mime.startsWith("application/pdf") ? "pdf" : "other";
const icon = (e: FsEntry) => (e.dir ? "📁" : /\.(png|jpe?g|gif|webp)$/i.test(e.name) ? "🖼️" : /\.pdf$/i.test(e.name) ? "📕" : /\.(mp3|m4a|wav|ogg|flac|aac)$/i.test(e.name) ? "🎵" : /\.(mp4|webm|mov)$/i.test(e.name) ? "🎬" : "📄");

// File browser + viewer/editor. Every call rides ?host= so picking a federated host walks
// THAT machine's disk (the proxy forwards bytes untouched). Text edits save atomically with an
// optimistic lock — if an agent rewrote the file meanwhile, you're asked before clobbering it.
export default function Files({ onToast }: Props) {
  const [hosts, setHosts] = useState<FedHost[]>([]);
  const [host, setHost] = useState(""); // "" = this machine
  const [listing, setListing] = useState<FsListing | null>(null);
  const [listErr, setListErr] = useState("");
  const [pathInput, setPathInput] = useState("");
  const [showHidden, setShowHidden] = useState(false);
  const [file, setFile] = useState<FsFile | null>(null); // what the server handed us
  const [draft, setDraft] = useState(""); // editor buffer
  const [saving, setSaving] = useState(false);
  const [opening, setOpening] = useState("");
  const dirty = !!file && file.kind === "text" && draft !== (file.content ?? "");
  const hq = host || undefined;
  const memKey = `mt3k.files.${host || "local"}`;

  useEffect(() => { getHosts().then((r) => setHosts((r?.hosts ?? []).filter((h) => h.reachable))); }, []);

  const load = async (p: string) => {
    const r = await fsList(p, hq);
    if (r?.ok) {
      setListing(r); setPathInput(r.path); setListErr("");
      try { localStorage.setItem(memKey, r.path); } catch { /* private mode */ }
    } else {
      setListErr(r?.err ?? "no se pudo listar esa carpeta");
    }
  };

  // switching host: forget the open file, resume where you left off on that host
  useEffect(() => {
    let start = "~";
    try { start = localStorage.getItem(memKey) || "~"; } catch { /* defaults */ }
    setFile(null); setDraft("");
    load(start);
  }, [host]); // eslint-disable-line react-hooks/exhaustive-deps

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
      if (listing) load(listing.path); // sizes/mtimes in the list
    } else if (r?.conflict) {
      if (window.confirm(`${r.err}.\n¿Sobrescribir con tu versión?`)) write(undefined);
    } else {
      onToast?.(r?.err ? `error: ${r.err}` : "no se pudo guardar", false);
    }
  };
  const save = () => { if (file && !saving && (dirty || !file.mtime)) write(file.mtime || undefined); };

  const newFile = () => {
    if (!listing || !confirmDiscard()) return;
    const name = window.prompt("Nombre del archivo nuevo:");
    if (!name?.trim() || name.includes("/")) return;
    setFile({ ok: true, path: `${listing.path.replace(/\/$/, "")}/${name.trim()}`, kind: "text", mime: "text/plain", content: "", size: 0, mtime: 0 });
    setDraft("");
  };

  const closeFile = () => { if (confirmDiscard()) { setFile(null); setDraft(""); } };
  const copyPath = () => { if (file) navigator.clipboard.writeText(file.path).then(() => onToast?.("ruta copiada", true), () => onToast?.("no se pudo copiar", false)); };

  const entries = (listing?.entries ?? [])
    .filter((e) => showHidden || !e.name.startsWith("."))
    .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name, undefined, { numeric: true }));
  const crumbs = listing ? listing.path.split("/").filter(Boolean) : [];
  const raw = file ? fsRawUrl(file.path, hq) : "";
  const kind = file ? kindOf(file.mime) : "other";

  return (
    <div className="flex min-h-0 flex-1 flex-col p-4 sm:p-6">
      <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Files</h1>
          <p className="font-mono text-xs text-white/45">explora, mira y edita archivos del host{hosts.length ? " — local o federado" : ""}</p>
        </div>
        <div className="flex items-center gap-2">
          {hosts.length > 0 && (
            <select value={host} onChange={(e) => { if (confirmDiscard()) setHost(e.target.value); }}
              className="rounded-lg border border-ink-line bg-ink-850/60 px-2.5 py-1.5 font-mono text-xs text-white focus:border-accent/50 focus:outline-none">
              <option value="">local · esta máquina</option>
              {hosts.map((h) => <option key={h.id} value={h.id}>{h.name}</option>)}
            </select>
          )}
          <label className="flex cursor-pointer items-center gap-1.5 font-mono text-[11px] text-white/55">
            <input type="checkbox" checked={showHidden} onChange={(e) => setShowHidden(e.target.checked)} className="accent-[oklch(62%_0.23_25)]" /> ocultos
          </label>
        </div>
      </div>

      {/* path bar: breadcrumbs to tap + free-form input for typing a path on desktop */}
      <form onSubmit={(e) => { e.preventDefault(); load(pathInput.trim() || "~"); }} className="mb-2 flex gap-2">
        <input value={pathInput} onChange={(e) => setPathInput(e.target.value)} spellCheck={false} autoCapitalize="off" placeholder="~"
          className="min-w-0 flex-1 rounded-lg border border-ink-line bg-ink-850/60 px-3 py-1.5 font-mono text-sm text-white placeholder:text-white/30 focus:border-accent/50 focus:outline-none" />
        <button type="submit" className="rounded-lg border border-ink-line px-3 py-1.5 font-mono text-xs text-white/70 transition hover:border-accent/50 hover:text-accent">ir</button>
      </form>
      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        <button onClick={() => load("/")} className="rounded-full border border-ink-line bg-ink-850/50 px-2 py-0.5 font-mono text-[10px] text-white/50 transition hover:text-white">/</button>
        {crumbs.map((c, i) => (
          <button key={i} onClick={() => load("/" + crumbs.slice(0, i + 1).join("/"))}
            className={`rounded-full border px-2 py-0.5 font-mono text-[10px] transition ${i === crumbs.length - 1 ? "border-accent/60 bg-accent/15 text-accent" : "border-ink-line bg-ink-850/50 text-white/50 hover:text-white"}`}>
            {c}
          </button>
        ))}
        <span className="mx-1 text-white/20">·</span>
        {listing?.quick.map((q) => (
          <button key={q.path} onClick={() => load(q.path)} title={q.path}
            className="rounded-full border border-dashed border-ink-line px-2 py-0.5 font-mono text-[10px] text-white/45 transition hover:border-accent/50 hover:text-accent">
            {q.name}
          </button>
        ))}
      </div>

      <div className="grid min-h-0 flex-1 gap-3 md:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        {/* listing — on the phone it yields the screen to the viewer while a file is open */}
        <div className={`surface min-h-0 overflow-y-auto ${file ? "hidden md:block" : ""}`}>
          {listErr ? (
            <div className="p-6 text-center font-mono text-xs text-amber-300/80">{listErr}</div>
          ) : (
            <ul className="divide-y divide-ink-line/60">
              {listing && listing.path !== "/" && (
                <li><button onClick={() => load(listing.parent)} className="flex w-full items-center gap-2 px-3 py-2 text-left font-mono text-xs text-white/50 transition hover:bg-white/5 hover:text-white">⬆ ..</button></li>
              )}
              {entries.map((e) => {
                const full = `${listing!.path.replace(/\/$/, "")}/${e.name}`;
                const active = file?.path === full;
                return (
                  <li key={e.name}>
                    <button onClick={() => (e.dir ? load(full) : open(full))} disabled={opening === full}
                      className={`flex w-full items-center gap-2 px-3 py-2 text-left transition hover:bg-white/5 ${active ? "bg-accent/10" : ""}`}>
                      <span className="w-5 shrink-0 text-center text-sm">{icon(e)}</span>
                      <span className={`min-w-0 flex-1 truncate font-mono text-xs ${e.dir ? "text-white" : "text-white/80"}`}>{e.name}{e.dir ? "/" : ""}</span>
                      <span className="shrink-0 font-mono text-[10px] text-white/35">{e.dir ? "" : human(e.size)}</span>
                    </button>
                  </li>
                );
              })}
              {listing && entries.length === 0 && <li className="p-6 text-center font-mono text-xs text-white/35">carpeta vacía</li>}
            </ul>
          )}
          {listing && (
            <div className="sticky bottom-0 border-t border-ink-line bg-ink-900/95 p-2 backdrop-blur">
              <button onClick={newFile} className="w-full rounded-lg border border-dashed border-ink-line px-3 py-1.5 font-mono text-[11px] text-white/50 transition hover:border-accent/50 hover:text-accent">＋ archivo nuevo aquí</button>
            </div>
          )}
        </div>

        {/* viewer / editor */}
        <div className={`surface flex min-h-0 flex-col ${file ? "" : "hidden md:flex"}`}>
          {!file ? (
            <div className="flex flex-1 items-center justify-center p-8 text-center">
              <div><div className="mb-2 text-4xl opacity-30">📄</div><div className="font-mono text-xs text-white/40">elige un archivo para verlo o editarlo</div></div>
            </div>
          ) : (
            <>
              <header className="flex items-center justify-between gap-2 border-b border-ink-line px-3 py-2">
                <div className="min-w-0">
                  <div className="truncate font-mono text-xs font-semibold text-white">{base(file.path)}{dirty && <span className="ml-1 text-amber-300">●</span>}</div>
                  <div className="truncate font-mono text-[10px] text-white/40">{human(file.size)} · {when(file.mtime)} · {file.mime.split(";")[0]}</div>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <button onClick={copyPath} title="copiar ruta" className="rounded-lg border border-ink-line px-2 py-1 font-mono text-[10px] text-white/55 transition hover:border-accent/50 hover:text-accent">⧉ ruta</button>
                  {file.kind === "text" && (
                    <button onClick={save} disabled={saving || (!dirty && !!file.mtime)}
                      className="rounded-lg bg-accent/20 px-3 py-1 font-mono text-[11px] font-medium text-accent transition hover:bg-accent/30 disabled:opacity-40">
                      {saving ? "guardando…" : "guardar"}
                    </button>
                  )}
                  <button onClick={closeFile} className="rounded-lg border border-ink-line px-2 py-1 font-mono text-[10px] text-white/55 transition hover:text-white">✕</button>
                </div>
              </header>
              <div className="min-h-0 flex-1 overflow-auto">
                {file.kind === "text" ? (
                  <textarea value={draft} onChange={(e) => setDraft(e.target.value)} spellCheck={false} autoCapitalize="off" autoCorrect="off"
                    onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === "s") { e.preventDefault(); save(); } }}
                    className="h-full min-h-[50vh] w-full resize-none bg-transparent p-3 font-mono text-xs leading-relaxed text-white/90 outline-none" />
                ) : kind === "image" ? (
                  <img src={raw} alt={base(file.path)} className="mx-auto max-h-full max-w-full object-contain p-2" />
                ) : kind === "pdf" ? (
                  <iframe src={raw} title={base(file.path)} className="h-full min-h-[70vh] w-full" />
                ) : kind === "audio" ? (
                  <div className="p-6"><audio controls src={raw} className="w-full" /></div>
                ) : kind === "video" ? (
                  <video controls src={raw} className="max-h-full w-full" />
                ) : (
                  <div className="p-8 text-center font-mono text-xs text-white/50">
                    {file.tooBig ? "demasiado grande para editar aquí (máx 2MB)" : "archivo binario — sin vista previa"}
                    <div className="mt-3"><a href={raw} download={base(file.path)} className="rounded-lg border border-ink-line px-3 py-1.5 text-white/70 transition hover:border-accent/50 hover:text-accent">⬇ descargar</a></div>
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
