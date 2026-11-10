import { useSyncExternalStore } from "react";

export const DESKTOP_QUERY = "(min-width: 1024px)";
// Mosaic chrome stays compact; only width gates the four-tile layout.
export const MOSAIC_DESKTOP_QUERY = DESKTOP_QUERY;
export const MOSAIC_QUERY = "(min-width: 600px)";
export const COMPACT_MOSAIC_QUERY = MOSAIC_QUERY;

export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};
      const mql = window.matchMedia(query);
      mql.addEventListener("change", onChange);
      return () => mql.removeEventListener("change", onChange);
    },
    () => (typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia(query).matches : false),
    () => false,
  );
}
