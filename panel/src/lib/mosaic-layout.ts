import { MOSAIC_SLOTS } from "./mosaic-presets.ts";

export type MosaicLayout = "1x1" | "2x2";

export const LAYOUT_STORAGE_KEY = "mt3k.mosaic.layout";
export const DEFAULT_LAYOUT: MosaicLayout = "2x2";

export function parseLayout(raw: unknown): MosaicLayout {
  return raw === "1x1" || raw === "2x2" ? raw : DEFAULT_LAYOUT;
}

/** Slot shown in 1x1: the focused slot if it is filled, else the first non-empty slot, else slot 0. */
export function pickActiveSlot(slots: readonly unknown[], focus: number | null): number {
  const filled = (i: number) => slots[i] !== null && slots[i] !== undefined;
  if (focus !== null && Number.isInteger(focus) && focus >= 0 && focus < MOSAIC_SLOTS && filled(focus)) return focus;
  for (let i = 0; i < MOSAIC_SLOTS; i++) if (filled(i)) return i;
  return 0;
}

/** Maps a digit key ("1".."4") to a slot index, or null. */
export function slotForKey(key: string): number | null {
  if (!/^[1-9]$/.test(key)) return null;
  const idx = Number(key) - 1;
  return idx < MOSAIC_SLOTS ? idx : null;
}
