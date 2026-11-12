// Terminales de Herdr (hc) que el servidor lista como panes con backend "herdr".
// Los ids empiezan por "hc:"; los panes tmux no llevan campo backend (ausencia = tmux).
export const HERDR_UNAVAILABLE_TITLE = "no disponible para sesiones de Herdr";

export const isHerdrPaneId = (id?: string | null): boolean => typeof id === "string" && id.startsWith("hc:");

export const HERDR_NOT_KILLABLE_TITLE = "solo se pueden cerrar los terminales de Herdr que abrió el panel";

/** ¿Se puede cerrar desde el panel? tmux siempre; Herdr solo si el servidor lo marcó `killable` (lo abrió el panel). */
export const isPaneKillable = (p?: { backend?: string; paneId?: string; killable?: boolean } | null): boolean =>
  !isHerdrPane(p) || p?.killable === true;

export type LaunchBackendHerdr = { installed: boolean; running: boolean; app: boolean };

/** Estado del selector "Abrir terminales con": Herdr deshabilitado sin instalar; con aviso si no está corriendo. */
export function herdrChoice(herdr: LaunchBackendHerdr | null | undefined): { disabled: boolean; hint: string } {
  if (!herdr || !herdr.installed) return { disabled: true, hint: "Herdr no está instalado en este host" };
  if (!herdr.running) return { disabled: false, hint: "Herdr no está corriendo: se abrirá en tmux hasta que lo abras" };
  return { disabled: false, hint: "" };
}

export const isHerdrPane = (p?: { backend?: string; paneId?: string } | null): boolean =>
  p?.backend === "herdr" || isHerdrPaneId(p?.paneId);
