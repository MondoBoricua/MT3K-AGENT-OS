import {
  LAST_SLOTS_STORAGE_KEY,
  MOSAIC_SLOTS,
  MAX_PRESETS,
  PRESETS_STORAGE_KEY,
  normalizeSlots,
  type MosaicPreset,
  type MosaicSlot,
} from "./mosaic-presets";

export function loadPresets(): MosaicPreset[] {
  try {
    const raw = localStorage.getItem(PRESETS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: MosaicPreset[] = [];
    for (const item of parsed) {
      if (item && typeof item.name === "string" && item.name.trim() && Array.isArray(item.slots)) {
        out.push({ name: item.name.trim(), slots: normalizeSlots(item.slots) });
        if (out.length >= MAX_PRESETS) break;
      }
    }
    return out;
  } catch {
    return [];
  }
}

export function savePresets(list: readonly MosaicPreset[]): void {
  try {
    localStorage.setItem(PRESETS_STORAGE_KEY, JSON.stringify(list.slice(0, MAX_PRESETS)));
  } catch {
    /* private mode */
  }
}

export function loadLastSlots(): MosaicSlot[] {
  try {
    const raw = localStorage.getItem(LAST_SLOTS_STORAGE_KEY);
    if (!raw) return Array<MosaicSlot>(MOSAIC_SLOTS).fill(null);
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return Array<MosaicSlot>(MOSAIC_SLOTS).fill(null);
    return normalizeSlots(parsed);
  } catch {
    return Array<MosaicSlot>(MOSAIC_SLOTS).fill(null);
  }
}

export function saveLastSlots(slots: readonly MosaicSlot[]): void {
  try {
    localStorage.setItem(LAST_SLOTS_STORAGE_KEY, JSON.stringify(normalizeSlots(slots)));
  } catch {
    /* private mode */
  }
}
