// Pure helpers behind the clickable terminal links (no React, no imports: unit-testable).
export interface GitRef { name: string; current: boolean; pushed: boolean; url: string | null; worktree: string | null }
export interface GitRefs { ok: boolean; root: string | null; branches: GitRef[]; err?: string }

const GITHUB_TREE_RE = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/tree\//;

// where a click on a branch goes: GitHub page when pushed, else its worktree, else the repo root
export type BranchTarget = { kind: "url"; url: string } | { kind: "files"; path: string };
export function branchTarget(ref: GitRef, root: string | null): BranchTarget | null {
  if (ref.url && GITHUB_TREE_RE.test(ref.url)) return { kind: "url", url: ref.url }; // only github.com is ever opened
  const path = ref.worktree || root;
  return path ? { kind: "files", path } : null;
}

export function branchTitle(ref: GitRef, root: string | null): string {
  const t = branchTarget(ref, root);
  if (t?.kind === "url") return `GitHub: ${GITHUB_TREE_RE.exec(t.url)?.[1] ?? "github.com"}@${ref.name}`;
  return `local: ${t?.path ?? ref.name}`;
}

// name -> tooltip, the shape ansiToHtml takes
export function branchTitles(refs: GitRefs | null): Map<string, string> {
  const m = new Map<string, string>();
  if (refs?.ok) for (const b of refs.branches) m.set(b.name, branchTitle(b, refs.root));
  return m;
}

// parent directory of a file path, either separator; "" when there is none. Roots keep their separator
// ("C:\\", "\\\\host\\share\\", "/") because "C:" alone is drive-relative.
export function parentDir(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  if (i < 0) return "";
  if (i === 0) return "/";
  const parent = p.slice(0, i);
  if (/^[A-Za-z]:$/.test(parent) || /^[\\/]{2}[^\\/]+[\\/][^\\/]+$/.test(parent)) return parent + p[i];
  return parent;
}
