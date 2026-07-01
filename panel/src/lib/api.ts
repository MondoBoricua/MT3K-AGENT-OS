export interface SkillRow { name: string; slug: string; description: string }
export interface LogEntry { date: string; content: string }
export interface PaneRef { paneId: string; label: string; window: string; cwd: string }
export interface AgentRow { id: string; name: string; online: boolean; running: boolean; launchable?: boolean; panes?: PaneRef[] }

async function jget<T>(url: string): Promise<T | null> {
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch {
    return null;
  }
}
async function jpost<T>(url: string, body: unknown): Promise<T | null> {
  try {
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return (await r.json()) as T;
  } catch {
    return null;
  }
}

export const getSkills = () => jget<{ skills: SkillRow[] }>("/api/skills");
export const getAgents = () => jget<{ agents: AgentRow[] }>("/api/agents");
export const getLogs = () => jget<{ logs: LogEntry[] }>("/api/logs");
export const askQuery = (projectId: string, q: string) => jpost<{ ok: boolean; answer: string }>("/api/query", { projectId, q });
export const sendToPane = (paneId: string, text: string, enter = true) => jpost<{ ok: boolean; paneId?: string; err?: string }>("/api/send", { paneId, text, enter });
export const getPane = (paneId: string) => jget<{ ok: boolean; content: string }>(`/api/pane?id=${encodeURIComponent(paneId)}`);
export const sendKey = (paneId: string, key: string) => jpost<{ ok: boolean; paneId?: string; key?: string; err?: string }>("/api/key", { paneId, key });
export const launchAgent = (agentId: string, opts: { projectId?: string; cwd?: string; create?: boolean }) =>
  jpost<{ ok: boolean; paneId?: string; label?: string; session?: string; cwd?: string; err?: string; missingDir?: boolean }>("/api/launch", { agentId, ...opts });
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
