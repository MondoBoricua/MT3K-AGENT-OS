// Vibrant palette for community clusters — hex so canvas fillStyle is universally happy.
const PALETTE = [
  "#34d399", "#f472b6", "#a78bfa", "#22d3ee", "#fbbf24", "#f87171",
  "#60a5fa", "#4ade80", "#fb923c", "#e879f9", "#2dd4bf", "#facc15",
  "#818cf8", "#fca5a5", "#5eead4", "#c084fc",
];

export function communityColor(c: number): string {
  const n = ((Math.round(c) % PALETTE.length) + PALETTE.length) % PALETTE.length;
  return PALETTE[n];
}

export function langTint(lang: string): string {
  const m: Record<string, string> = {
    TypeScript: "#60a5fa", JavaScript: "#facc15", Astro: "#fb923c", Vue: "#4ade80",
    PHP: "#a78bfa", Python: "#34d399", Swift: "#f87171", Go: "#22d3ee", Mixed: "#94a3b8",
  };
  return m[lang] || "#94a3b8";
}

export const fmt = (n: number): string =>
  n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + "k" : String(n);

export const money = (n: number): string => "$" + n.toFixed(2);
