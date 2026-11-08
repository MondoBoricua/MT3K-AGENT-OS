import { agentKey, type AgentRow, type PaneRef } from "./api.ts";

export type MosaicSlot = { agentKey: string; cwd: string; name?: string } | null;
export type MosaicPreset = { name: string; slots: MosaicSlot[] };
export type Session = { agent: AgentRow; pane: PaneRef };

export const MOSAIC_SLOTS = 4;
export const MAX_PRESETS = 12;
export const PRESETS_STORAGE_KEY = "mt3k.mosaic.presets";
export const LAST_SLOTS_STORAGE_KEY = "mt3k.mosaic.last";

export function normalizeSlots(slots: readonly MosaicSlot[]): MosaicSlot[] {
  return Array.from({ length: MOSAIC_SLOTS }, (_, i) => {
    const s = slots[i];
    if (!s || typeof s.agentKey !== "string" || typeof s.cwd !== "string") return null;
    const name = typeof s.name === "string" && s.name.trim() ? s.name.trim() : undefined;
    return name ? { agentKey: s.agentKey, cwd: s.cwd, name } : { agentKey: s.agentKey, cwd: s.cwd };
  });
}

export function resolveSlots(slots: readonly MosaicSlot[], sessions: readonly Session[]): (Session | null)[] {
  const usedPaneIds = new Set<string>();
  const keyOf = (s: Session) => `${agentKey(s.agent)}|${s.pane.paneId}`;
  const result: (Session | null)[] = Array.from({ length: MOSAIC_SLOTS }, () => null);

  // First pass: resolve named slots within the same agentKey so unnamed slots cannot steal them.
  for (let i = 0; i < MOSAIC_SLOTS; i++) {
    const slot = slots[i];
    const slotName = slot?.name?.trim();
    if (!slot || !slotName) continue;
    const match = sessions.find(
      (s) => !usedPaneIds.has(keyOf(s)) && agentKey(s.agent) === slot.agentKey && s.pane.name === slotName
    );
    if (match) {
      usedPaneIds.add(keyOf(match));
      result[i] = match;
    }
  }

  // Second pass: fall back to agentKey + cwd for any remaining unresolved slots.
  for (let i = 0; i < MOSAIC_SLOTS; i++) {
    if (result[i]) continue;
    const slot = slots[i];
    if (!slot) continue;
    const match = sessions.find(
      (s) => !usedPaneIds.has(keyOf(s)) && agentKey(s.agent) === slot.agentKey && s.pane.cwd === slot.cwd
    );
    if (match) {
      usedPaneIds.add(keyOf(match));
      result[i] = match;
    }
  }

  return result;
}

export function slotsFrom(sessions: readonly (Session | null)[]): MosaicSlot[] {
  return Array.from({ length: MOSAIC_SLOTS }, (_, i) => {
    const s = sessions[i];
    if (!s) return null;
    const name = s.pane.name?.trim();
    return name
      ? { agentKey: agentKey(s.agent), cwd: s.pane.cwd, name }
      : { agentKey: agentKey(s.agent), cwd: s.pane.cwd };
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
