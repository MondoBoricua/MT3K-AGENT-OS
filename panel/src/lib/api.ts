export interface SkillRow { name: string; slug: string; description: string }
export interface LogEntry { date: string; content: string }
export interface PaneRef { paneId: string; label: string; window: string; cwd: string; waiting?: boolean }
export interface AgentRow { id: string; name: string; online: boolean; running: boolean; launchable?: boolean; waiting?: boolean; host?: string; panes?: PaneRef[] }
// unique key for an agent across federated hosts (same CLI can exist on several machines)
export const agentKey = (a: Pick<AgentRow, "id" | "host">) => `${a.host ?? "local"}:${a.id}`;
// tmux-touching endpoints ride ?host= so the server proxies them to the right federated panel
const hostQ = (host?: string) => (host ? `?host=${encodeURIComponent(host)}` : "");

// optional bearer token (only needed when the server runs with MT3K_TOKEN set)
export const getToken = () => localStorage.getItem("mt3k.token") ?? "";
export const setToken = (t: string) => localStorage.setItem("mt3k.token", t);
const authHeaders = (): Record<string, string> => (getToken() ? { authorization: `Bearer ${getToken()}` } : {});
const notifyUnauthorized = (r: Response) => { if (r.status === 401) window.dispatchEvent(new Event("mt3k:unauthorized")); };

async function jget<T>(url: string): Promise<T | null> {
  try {
    const r = await fetch(url, { headers: authHeaders() });
    if (!r.ok) { notifyUnauthorized(r); return null; }
    return (await r.json()) as T;
  } catch {
    return null;
  }
}
async function jpost<T>(url: string, body: unknown): Promise<T | null> {
  try {
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...authHeaders() }, body: JSON.stringify(body) });
    if (!r.ok) notifyUnauthorized(r);
    return (await r.json()) as T;
  } catch {
    return null;
  }
}

export const getSkills = () => jget<{ skills: SkillRow[] }>("/api/skills");
export const getAgents = () => jget<{ agents: AgentRow[] }>("/api/agents");
export const getLogs = () => jget<{ logs: LogEntry[] }>("/api/logs");
export const askQuery = (projectId: string, q: string) => jpost<{ ok: boolean; answer: string }>("/api/query", { projectId, q });
export const sendToPane = (paneId: string, text: string, enter = true, host?: string) => jpost<{ ok: boolean; paneId?: string; err?: string }>(`/api/send${hostQ(host)}`, { paneId, text, enter });
export const getPane = (paneId: string, host?: string) => jget<{ ok: boolean; content: string }>(`/api/pane?id=${encodeURIComponent(paneId)}${host ? `&host=${encodeURIComponent(host)}` : ""}`);
export const sendKey = (paneId: string, key: string, host?: string) => jpost<{ ok: boolean; paneId?: string; key?: string; err?: string }>(`/api/key${hostQ(host)}`, { paneId, key });
export const killPane = (paneId: string, host?: string) => jpost<{ ok: boolean; err?: string }>(`/api/kill${hostQ(host)}`, { paneId });
export const launchAgent = (agentId: string, opts: { projectId?: string; cwd?: string; create?: boolean; firstPrompt?: string; host?: string }) => {
  const { host, ...rest } = opts;
  return jpost<{ ok: boolean; paneId?: string; label?: string; session?: string; cwd?: string; err?: string; missingDir?: boolean }>(`/api/launch${hostQ(host)}`, { agentId, ...rest });
};
export const broadcast = (text: string) => jpost<{ ok: boolean; sent?: number; err?: string }>("/api/broadcast", { text });
export const getMacros = () => jget<{ macros: string[] }>("/api/macros");
export const refreshProject = (projectId: string) => jpost<{ ok: boolean; log: string }>("/api/refresh", { projectId });

export interface DiscoverRepo { name: string; path: string; files: number }
export const discoverRepos = () => jget<{ repos: DiscoverRepo[] }>("/api/discover");
export const addProject = (path: string, name?: string) => jpost<{ ok: boolean; id: string }>("/api/add-project", { path, name });

export interface SystemStatus {
  agents: AgentRow[];
  uptimeMs: number;
  graphify: string;
  skills: number;
  projects: number;
  lastIngest: string | null;
  port: number;
  lan: string;
}
export const getStatus = () => jget<SystemStatus>("/api/status");
export const removeProject = (id: string) => jpost<{ ok: boolean }>("/api/remove-project", { id });
export const reingest = () => jpost<{ ok: boolean }>("/api/reingest", {});

export interface SearchHit { project: string; projectName: string; id: string; label: string; community: number }
export const searchNodes = (q: string) => jget<{ results: SearchHit[] }>(`/api/search?q=${encodeURIComponent(q)}`);
