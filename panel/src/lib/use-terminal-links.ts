import { useCallback, useEffect, useMemo, useState, type MouseEvent } from "react";
import { getGitRefs } from "./api";
import { branchTarget, branchTitles, type GitRefs } from "./terminal-links";

// Branch list per (host, cwd), cached in memory for 60 s. No polling: it is read when a pane is shown
// and again when the tab becomes visible, only if the cached copy is older than the TTL.
// A failure is cached too (as null) so a dead endpoint is not hammered; the viewer just has no branch links.
const REFS_TTL_MS = 60_000;
const cache = new Map<string, { at: number; refs: GitRefs | null }>();
const inflight = new Map<string, Promise<GitRefs | null>>();

function fetchRefs(key: string, cwd: string, host?: string): Promise<GitRefs | null> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < REFS_TTL_MS) return Promise.resolve(hit.refs);
  let p = inflight.get(key);
  if (!p) {
    p = getGitRefs(cwd, host)
      .then((r) => (r?.ok && r.root ? r : null))
      .catch(() => null)
      .then((refs) => { cache.set(key, { at: Date.now(), refs }); inflight.delete(key); return refs; });
    inflight.set(key, p);
  }
  return p;
}

type Opts = { cwd?: string; host?: string; onOpenPath?: (path: string, host?: string) => void };

// Branch tooltips for ansiToHtml + the ONE delegated click handler for the terminal container.
// It reads data-fs-path / data-git-branch from the clicked <a>; nothing else is ever navigated to
// except a github.com URL vetted by branchTarget.
export function useTerminalLinks({ cwd, host, onOpenPath }: Opts) {
  const key = `${host ?? ""}|${cwd ?? ""}`;
  const [refs, setRefs] = useState<GitRefs | null>(null);

  useEffect(() => {
    if (!cwd) { setRefs(null); return; }
    let alive = true;
    setRefs(cache.get(key)?.refs ?? null);
    const load = () => { void fetchRefs(key, cwd, host).then((r) => { if (alive) setRefs(r); }); };
    const onVisible = () => { if (document.visibilityState === "visible") load(); };
    load();
    document.addEventListener("visibilitychange", onVisible);
    return () => { alive = false; document.removeEventListener("visibilitychange", onVisible); };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  const branches = useMemo(() => branchTitles(refs), [refs]);

  const onClick = useCallback((e: MouseEvent<HTMLElement>) => {
    if (!(e.target instanceof Element)) return;
    const a = e.target.closest("a[data-fs-path],a[data-git-branch]");
    if (!a) return;
    if (window.getSelection()?.toString()) return; // finishing a text selection, not a click
    e.preventDefault();
    const fsPath = a.getAttribute("data-fs-path");
    if (fsPath) { onOpenPath?.(fsPath, host); return; }
    const name = a.getAttribute("data-git-branch");
    const ref = refs?.branches.find((b) => b.name === name);
    const target = ref ? branchTarget(ref, refs?.root ?? null) : null;
    if (!target) return;
    if (target.kind === "url") window.open(target.url, "_blank", "noopener,noreferrer");
    else onOpenPath?.(target.path, host);
  }, [refs, host, onOpenPath]);

  return { branches, onClick };
}
