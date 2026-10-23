import { useState } from "react";
// Per-agent brand logo (real SVGs in /public/logos). Agents without a brand mark
// fall back to a generic terminal glyph. Dimmed + desaturated when offline.
const BRAND = new Set(["claude", "codex", "grok", "cursor", "antigravity", "opencode", "deepseek", "zcode"]);
const BASE = import.meta.env.BASE_URL;

function GenericGlyph({ className, dim }: { className: string; dim: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
      className={`${className} shrink-0 ${dim}`}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="m7 9 3 3-3 3M13.5 15H17" />
    </svg>
  );
}

export default function AgentLogo({
  id,
  logo,
  online = true,
  className = "h-[18px] w-[18px]",
}: {
  id: string;
  logo?: string;
  online?: boolean;
  className?: string;
}) {
  const dim = online ? "" : "opacity-40 grayscale";
  const [customFailed, setCustomFailed] = useState(false);
  // Logo explícito en la fila (p. ej. agents.local.json) — solo si el SVG existe en /logos/
  const customSlug = logo && !customFailed ? logo : null;
  if (customSlug) {
    return (
      <img
        src={`${BASE}logos/${customSlug}.svg`}
        alt=""
        aria-hidden
        className={`${className} shrink-0 object-contain ${dim}`}
        onError={() => setCustomFailed(true)}
      />
    );
  }
  if (BRAND.has(id)) {
    return <img src={`${BASE}logos/${id}.svg`} alt="" aria-hidden className={`${className} shrink-0 object-contain ${dim}`} />;
  }
  return <GenericGlyph className={className} dim={dim} />;
}
