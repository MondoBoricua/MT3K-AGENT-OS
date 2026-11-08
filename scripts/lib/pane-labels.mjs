import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const MAX_PANE_LABEL_LENGTH = 40;

export function sessionNameOf(labelOrSession) {
  if (typeof labelOrSession !== "string") return "";
  const trimmed = labelOrSession.trim();
  const colonIdx = trimmed.indexOf(":");
  return (colonIdx >= 0 ? trimmed.slice(0, colonIdx) : trimmed).trim();
}

export function labelKey(agentId, cwd, sessionName) {
  return `${String(agentId || "").trim()}|${String(cwd || "").trim()}|${sessionNameOf(sessionName)}`;
}

export function sanitizePaneLabel(raw) {
  if (raw === undefined || raw === null) return { ok: true, name: "" };
  if (typeof raw !== "string") return { ok: false, err: "nombre inválido" };
  const stripped = raw
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (stripped.length > MAX_PANE_LABEL_LENGTH) {
    return { ok: false, err: `nombre demasiado largo (máx ${MAX_PANE_LABEL_LENGTH})` };
  }
  return { ok: true, name: stripped };
}

export function readLabels(file) {
  if (!file || !existsSync(file)) return {};
  try {
    const raw = JSON.parse(readFileSync(file, "utf8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const out = {};
    for (const [k, v] of Object.entries(raw)) {
      if (typeof v === "string" && v.trim()) {
        out[k] = { label: v.trim(), at: "" };
      } else if (v && typeof v === "object" && typeof v.label === "string" && v.label.trim()) {
        out[k] = { label: v.label.trim(), at: typeof v.at === "string" ? v.at : "" };
      }
    }
    return out;
  } catch {
    return {};
  }
}

export function writeLabels(file, map) {
  mkdirSync(dirname(file), { recursive: true });
  const clean = {};
  for (const [k, v] of Object.entries(map || {})) {
    const lbl = typeof v === "string" ? v.trim() : typeof v?.label === "string" ? v.label.trim() : "";
    if (!lbl) continue;
    clean[k] = {
      label: lbl,
      at: typeof v?.at === "string" && v.at ? v.at : new Date().toISOString(),
    };
  }
  const tmp = `${file}.mt3k-tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  try {
    writeFileSync(tmp, JSON.stringify(clean, null, 2) + "\n", "utf8");
    renameSync(tmp, file);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* ignore */ }
    throw err;
  }
}

export function applyLabels(rows, map) {
  if (!Array.isArray(rows)) return rows;
  const labels = map && typeof map === "object" ? map : {};
  for (const r of rows) {
    if (!Array.isArray(r?.panes)) continue;
    for (const p of r.panes) {
      const key = labelKey(r.id, p.cwd, p.session || p.label);
      const entry = labels[key];
      const lbl = typeof entry === "string" ? entry.trim() : typeof entry?.label === "string" ? entry.label.trim() : "";
      if (lbl) {
        p.name = lbl;
      } else {
        delete p.name;
      }
    }
  }
  return rows;
}
