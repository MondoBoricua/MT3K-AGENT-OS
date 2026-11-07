import { useEffect, useRef } from "react";
import { getPane, getToken, type PaneEvent } from "./api";

export function usePaneStream(opts: {
  paneId: string | null;
  host?: string;
  enabled: boolean;
  tickMs?: number;
  onEvent: (ev: PaneEvent) => void;
  // Each flag is independent: `null` means "this frame did not carry it" (a partial diff or an
  // old/federated server), so the caller keeps its previous value for that flag.
  onAlt?: (alt: boolean | null, mouseSgr: boolean | null) => void;
}): void {
  const { paneId, host, enabled, tickMs, onEvent, onAlt } = opts;
  const onEventRef = useRef(onEvent);
  const onAltRef = useRef(onAlt);
  onEventRef.current = onEvent;
  onAltRef.current = onAlt;
  const emitFlags = (alt: unknown, mouseSgr: unknown) => {
    const a = typeof alt === "boolean" ? alt : null;
    const m = typeof mouseSgr === "boolean" ? mouseSgr : null;
    if (a !== null || m !== null) onAltRef.current?.(a, m);
  };

  useEffect(() => {
    if (!paneId || !enabled) return;
    let alive = true;
    let iv: ReturnType<typeof setInterval> | undefined;
    let es: EventSource | null = null;

    const poll = () => {
      const pull = async () => {
        const r = await getPane(paneId, host);
        if (alive && r?.ok) {
          onEventRef.current(r.content ?? "");
          emitFlags(r.alternate, r.mouse_sgr);
        }
      };
      void pull();
      iv = setInterval(pull, 900);
    };

    try {
      const t = getToken(); // EventSource can't send headers → token rides the query string
      const hq = host ? `&host=${encodeURIComponent(host)}` : "";
      const tq = t ? `&t=${encodeURIComponent(t)}` : "";
      const tickQ = tickMs !== undefined ? `&tick=${encodeURIComponent(String(tickMs))}` : "";
      es = new EventSource(`/api/pane-stream?id=${encodeURIComponent(paneId)}${hq}${tq}&fmt=lines${tickQ}`);
      es.onmessage = (e) => {
        if (!alive) return;
        const ev = JSON.parse(e.data) as PaneEvent;
        onEventRef.current(ev);
        // diffs also carry `alt`: a proxy that drops NAMED events can't leave the alt state stale
        const frame = ev as { alt?: unknown; mouse_sgr?: unknown };
        emitFlags(frame.alt, frame.mouse_sgr);
      };
      es.addEventListener("alt", (e) => {
        // named event: old servers never send it, old bundles ignore it
        try {
          if (!alive) return;
          const frame = JSON.parse((e as MessageEvent).data) as { alt?: boolean; mouse_sgr?: boolean };
          emitFlags(frame.alt === true, frame.mouse_sgr);
        } catch {
          /* bad frame */
        }
      });
      es.onerror = () => {
        es?.close();
        es = null;
        if (alive && !iv) poll();
      };
    } catch {
      poll();
    }

    return () => {
      alive = false;
      es?.close();
      if (iv) clearInterval(iv);
    };
  }, [paneId, host, enabled, tickMs]);
}
