import { MOSAIC_SLOTS } from "./mosaic-presets.ts";

export type MosaicLayout = "1x1" | "1x2" | "2x2";

export const LAYOUT_STORAGE_KEY = "mt3k.mosaic.layout";
export const DEFAULT_LAYOUT: MosaicLayout = "2x2";

/** At 600px a two-column grid leaves <300px per tile after padding and gap.
 * Keep four-tile layouts desktop-only; retain the saved desktop preference. */
export function layoutsForViewport(isDesktop: boolean): MosaicLayout[] {
  return isDesktop ? ["1x1", "1x2", "2x2"] : ["1x1", "1x2"];
}

export function layoutForViewport(saved: MosaicLayout, isDesktop: boolean): MosaicLayout {
  return layoutsForViewport(isDesktop).includes(saved) ? saved : "1x2";
}

export function parseLayout(raw: unknown): MosaicLayout {
  return raw === "1x1" || raw === "1x2" || raw === "2x2" ? raw : DEFAULT_LAYOUT;
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

/** Slot indexes mounted for a layout: one in 1x1, the pair holding `active` in 1x2, all four in 2x2. */
export function visibleSlotsFor(layout: MosaicLayout, rawActive: number): number[] {
  const active = Number.isInteger(rawActive) && rawActive >= 0 && rawActive < MOSAIC_SLOTS ? rawActive : 0;
  if (layout === "2x2") return Array.from({ length: MOSAIC_SLOTS }, (_, i) => i);
  if (layout === "1x1") return [active];
  const start = Math.floor(active / 2) * 2;
  return [start, start + 1];
}

/** Layouts that show the 1 2 3 4 slot strip and react to keys 1-4. */
export function usesSlotStrip(layout: MosaicLayout): boolean {
  return layout !== "2x2";
}
