// Clasifica un adjunto del picker (iPhone a veces manda type vacío — miramos la extensión también).
const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "heic", "heif", "webp", "gif"]);
const AUDIO_EXT = new Set(["mp3", "m4a", "wav", "ogg", "webm", "aac", "flac"]);

function extFromName(name: string): string {
  const m = name.match(/\.([^.]+)$/i);
  return m ? m[1].toLowerCase() : "";
}

export function attachKind(name: string, type: string): "image" | "pdf" | "audio" | null {
  const t = (type || "").trim().toLowerCase();
  if (t.startsWith("image/")) return "image";
  if (t === "application/pdf") return "pdf";
  if (t.startsWith("audio/")) return "audio";

  const ext = extFromName(name);
  if (!ext) return null;
  if (IMAGE_EXT.has(ext)) return "image";
  if (ext === "pdf") return "pdf";
  if (AUDIO_EXT.has(ext)) return "audio";
  return null;
}
