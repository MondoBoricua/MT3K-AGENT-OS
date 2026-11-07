import { agentKey, type AgentRow, type PaneRef } from "./api.ts";

export type MosaicSlot = { agentKey: string; cwd: string } | null;
export type MosaicPreset = { name: string; slots: MosaicSlot[] };
export type Session = { agent: AgentRow; pane: PaneRef };

export const MOSAIC_SLOTS = 4;
export const MAX_PRESETS = 12;
export const PRESETS_STORAGE_KEY = "mt3k.mosaic.presets";
export const LAST_SLOTS_STORAGE_KEY = "mt3k.mosaic.last";

export function normalizeSlots(slots: readonly MosaicSlot[]): MosaicSlot[] {
  return Array.from({ length: MOSAIC_SLOTS }, (_, i) => {
    const s = slots[i];
    return s && typeof s.agentKey === "string" && typeof s.cwd === "string"
      ? { agentKey: s.agentKey, cwd: s.cwd }
      : null;
  });
}

export function resolveSlots(slots: readonly MosaicSlot[], sessions: readonly Session[]): (Session | null)[] {
  const usedPaneIds = new Set<string>();
  return Array.from({ length: MOSAIC_SLOTS }, (_, i) => {
    const slot = slots[i];
    if (!slot) return null;
    const match = sessions.find((s) => {
      const key = `${agentKey(s.agent)}|${s.pane.paneId}`;
      if (usedPaneIds.has(key)) return false;
      return agentKey(s.agent) === slot.agentKey && s.pane.cwd === slot.cwd;
    });
    if (!match) return null;
    usedPaneIds.add(`${agentKey(match.agent)}|${match.pane.paneId}`);
    return match;
  });
}

export function slotsFrom(sessions: readonly (Session | null)[]): MosaicSlot[] {
  return Array.from({ length: MOSAIC_SLOTS }, (_, i) => {
    const s = sessions[i];
    return s ? { agentKey: agentKey(s.agent), cwd: s.pane.cwd } : null;
  });
}

export function upsertPreset(list: readonly MosaicPreset[], preset: MosaicPreset): MosaicPreset[] {
  const name = preset.name.trim();
  if (!name) return [...list];
  const entry: MosaicPreset = { name, slots: normalizeSlots(preset.slots) };
  const idx = list.findIndex((p) => p.name === name);
  if (idx >= 0) {
    return list.map((p, i) => (i === idx ? entry : p));
  }
  const next = [...list, entry];
  return next.length > MAX_PRESETS ? next.slice(next.length - MAX_PRESETS) : next;
}

export function removePreset(list: readonly MosaicPreset[], name: string): MosaicPreset[] {
  const target = name.trim();
  return list.filter((p) => p.name !== target);
}
