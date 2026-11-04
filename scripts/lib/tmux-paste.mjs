import { randomBytes } from "node:crypto";

// Contador monotónico por proceso del módulo — cada envío pide un slot distinto al nombre fijo compartido.
let sendCounter = 0;

/**
 * Nombre de buffer tmux único por envío (pid + contador + aleatorio corto).
 * Varios procesos del servidor (hosts federados) no chocan gracias al pid y al hex.
 */
export function makeBufferName(pid = process.pid, counterArg) {
  const n = counterArg ?? ++sendCounter;
  const hex = randomBytes(2).toString("hex");
  return `mt3k_send_${pid}_${n}_${hex}`;
}

/**
 * Factory del pegado: misma semántica que el pasteToPane del servidor, pero buffer único por llamada.
 * @param {{ run: Function, cwd: string, tmuxArgs?: string[], tmuxBin?: string, targetBuffers?: boolean }} opts — run = spawn helper del server; tmuxArgs p.ej. ['-L', socket] en tests; tmuxBin = ruta del binario tmux/psmux; targetBuffers = añade `-t pane` a set-buffer/delete-buffer (psmux: un servidor por sesión, sin target el buffer cae en otro servidor).
 */
export function createPasteToPane({ run, cwd, tmuxArgs = [], tmuxBin = "tmux", targetBuffers = false }) {
  const tmux = (subargs, timeoutMs = 5000) => run(tmuxBin, [...tmuxArgs, ...subargs], cwd, timeoutMs);

  return async (paneId, text, enter) => {
    const target = targetBuffers ? ["-t", paneId] : [];
    const buf = makeBufferName();
    const set = await tmux(["set-buffer", ...target, "-b", buf, "--", text]);
    if (!set.ok) return { ok: false, err: set.err || "set-buffer falló" };
    const paste = await tmux(["paste-buffer", "-d", "-p", "-b", buf, "-t", paneId]);
    if (!paste.ok) {
      // Mejor esfuerzo: si el paste falló, el buffer puede quedar huérfano — lo intentamos borrar.
      await tmux(["delete-buffer", ...target, "-b", buf]);
      return { ok: false, err: paste.err || "paste-buffer falló" };
    }
    if (enter) {
      // Los TUI de agentes se tragan un Enter instantáneo tras bracketed paste — pausa corta como en server.mjs.
      await new Promise((r) => setTimeout(r, 300));
      await tmux(["send-keys", "-t", paneId, "Enter"]);
    }
    return { ok: true };
  };
}
