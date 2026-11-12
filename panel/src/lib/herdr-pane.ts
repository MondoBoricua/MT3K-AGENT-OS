// Terminales de Herdr (hc) que el servidor lista como panes con backend "herdr".
// Los ids empiezan por "hc:"; los panes tmux no llevan campo backend (ausencia = tmux).
export const HERDR_UNAVAILABLE_TITLE = "no disponible para sesiones de Herdr";

export const isHerdrPaneId = (id?: string | null): boolean => typeof id === "string" && id.startsWith("hc:");

export const KILL_CONFIRM_TMUX = "¿Matar esta sesión de tmux? El agente que corre ahí se cierra.";
export const KILL_CONFIRM_HERDR_OWNED = "¿Cerrar esta terminal de Herdr? El agente que corre ahí se cierra.";
export const KILL_CONFIRM_HERDR_FOREIGN = "Esta terminal la abriste tú en Herdr, no el panel. ¿Cerrarla de todos modos?";

type KillablePane = { backend?: string; paneId?: string; killable?: boolean } | null | undefined;

/**
 * Qué confirmación y qué petición corresponden al cerrar un pane. tmux y los terminales de Herdr que abrió el panel:
 * confirmación normal, sin `force`. Los demás de Herdr: confirmación aparte y SOLO entonces `force: true`.
 */
export function killPlan(p: KillablePane): { confirm: string; force: boolean; title: string } {
  if (!isHerdrPane(p)) return { confirm: KILL_CONFIRM_TMUX, force: false, title: "matar esta sesión de tmux" };
  if (p?.killable === true) return { confirm: KILL_CONFIRM_HERDR_OWNED, force: false, title: "cerrar esta terminal de Herdr" };
  return { confirm: KILL_CONFIRM_HERDR_FOREIGN, force: true, title: "cerrar esta terminal de Herdr (no la abrió el panel)" };
}

/** ¿El servidor pide confirmar un cierre que se mandó sin force (la etiqueta cambió mientras tanto)? */
export const needsForceRetry = (res: { ok?: boolean; needsConfirm?: boolean } | null | undefined, sentForce: boolean): boolean =>
  !sentForce && res?.ok !== true && res?.needsConfirm === true;

export type LaunchBackendHerdr = { installed: boolean; running: boolean; app: boolean };

/** Estado del selector "Abrir terminales con": Herdr deshabilitado sin instalar; con aviso si no está corriendo. */
export function herdrChoice(herdr: LaunchBackendHerdr | null | undefined): { disabled: boolean; hint: string } {
  if (herdr == null) return { disabled: true, hint: "" }; // estado aún cargando
  if (!herdr.installed) return { disabled: true, hint: "Herdr no está instalado en este host" };
  if (!herdr.running) return { disabled: false, hint: "Herdr no está corriendo: se abrirá en tmux hasta que lo abras" };
  return { disabled: false, hint: "" };
}

export const isHerdrPane = (p?: { backend?: string; paneId?: string } | null): boolean =>
  p?.backend === "herdr" || isHerdrPaneId(p?.paneId);
