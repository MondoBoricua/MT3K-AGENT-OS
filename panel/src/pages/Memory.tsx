import { useEffect, useState } from "react";
import { marked } from "marked";
import { getLogs, type LogEntry } from "../lib/api";

export default function Memory() {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => { getLogs().then((r) => { setLogs(r?.logs || []); setLoading(false); }); }, []);

  return (
    <div className="flex min-h-0 flex-1 flex-col p-6">
      <div className="mb-4">
        <h1 className="text-xl font-semibold">Memory</h1>
        <p className="font-mono text-xs text-white/45">{loading ? "cargando…" : `${logs.length} bitácoras · data/logs/ · file-based, sin DB`}</p>
      </div>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto pr-1">
        {logs.map((l) => (
          <div key={l.date} className="surface p-5">
            <div className="mb-2 font-mono text-xs uppercase tracking-wider text-accent">{l.date}</div>
            <div className="prose-wiki max-w-3xl" dangerouslySetInnerHTML={{ __html: marked.parse(l.content, { async: false }) as string }} />
          </div>
        ))}
        {!loading && logs.length === 0 && (
          <div className="py-16 text-center">
            <div className="mb-2 text-4xl opacity-40">❏</div>
            <div className="text-white/50">Sin bitácoras todavía.</div>
            <div className="mt-1 font-mono text-xs text-white/30">El OS las escribe en cada query/refresh.</div>
          </div>
        )}
      </div>
    </div>
  );
}
