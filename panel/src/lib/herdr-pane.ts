// Terminales de Herdr (hc) que el servidor lista como panes con backend "herdr".
// Los ids empiezan por "hc:"; los panes tmux no llevan campo backend (ausencia = tmux).
export const HERDR_UNAVAILABLE_TITLE = "no disponible para sesiones de Herdr";

export const isHerdrPaneId = (id?: string | null): boolean => typeof id === "string" && id.startsWith("hc:");

export const isHerdrPane = (p?: { backend?: string; paneId?: string } | null): boolean =>
  p?.backend === "herdr" || isHerdrPaneId(p?.paneId);
