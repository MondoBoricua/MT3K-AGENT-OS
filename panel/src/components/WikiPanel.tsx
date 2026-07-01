import { useMemo, useState } from "react";
import { marked } from "marked";
import type { ProjectData, WikiArticle } from "../types";

// Real wiki browser: index + one article per community (graphify export wiki),
// with [[wikilinks]] that jump between articles. Falls back to GRAPH_REPORT.md.
export default function WikiPanel({ data }: { data: ProjectData }) {
  const wiki = data.wiki;
  const articles: WikiArticle[] = wiki?.articles ?? [];
  const hasWiki = !!(wiki && (wiki.index || articles.length));
  const [active, setActive] = useState<string>("__index__");

  const current =
    active === "__index__" ? (wiki?.index ?? data.report ?? "") : (articles.find((a) => a.title === active)?.body ?? "");

  const html = useMemo(() => {
    if (!current) return "";
    const pre = current.replace(/\[\[([^\]]+)\]\]/g, (_, n) => `<a class="wikilink" data-wiki="${n.trim()}">${n.trim()}</a>`);
    return marked.parse(pre, { async: false }) as string;
  }, [current]);

  const onClick = (e: React.MouseEvent) => {
    const w = (e.target as HTMLElement).getAttribute?.("data-wiki");
    if (w && articles.some((a) => a.title === w)) { e.preventDefault(); setActive(w); }
  };

  if (!hasWiki && !data.report) {
    return (
      <div className="flex h-full flex-col items-center justify-center rounded-2xl border border-ink-line bg-ink-900/60 p-8 text-center">
        <div className="mb-2 text-4xl opacity-40">❏</div>
        <p className="text-white/60">Este proyecto aún no tiene wiki.</p>
        <p className="mt-2 font-mono text-xs text-white/40">Corre <span className="text-accent">graphify export wiki</span> y re-ingesta.</p>
      </div>
    );
  }

  const Item = ({ id, label }: { id: string; label: string }) => (
    <button onClick={() => setActive(id)}
      className={`shrink-0 whitespace-nowrap rounded-lg px-3 py-1.5 text-left text-xs transition sm:w-full sm:whitespace-normal ${
        active === id ? "bg-accent/15 text-accent" : "text-white/55 hover:bg-white/5 hover:text-white"
      }`}>
      {label}
    </button>
  );

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-2xl border border-ink-line bg-ink-900/60 sm:flex-row">
      <div className="flex shrink-0 gap-1 overflow-x-auto border-b border-ink-line p-2 sm:w-56 sm:flex-col sm:overflow-y-auto sm:border-b-0 sm:border-r">
        <Item id="__index__" label="📖 Overview" />
        {articles.map((a) => <Item key={a.title} id={a.title} label={a.title} />)}
      </div>
      <div className="flex-1 overflow-y-auto p-6 sm:p-7" onClick={onClick}>
        <div className="prose-wiki max-w-3xl" dangerouslySetInnerHTML={{ __html: html }} />
      </div>
    </div>
  );
}
