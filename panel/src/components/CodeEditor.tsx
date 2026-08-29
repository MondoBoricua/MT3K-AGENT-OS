import { useEffect, useRef } from "react";
import { EditorView, basicSetup } from "codemirror";
import { EditorState, type Extension } from "@codemirror/state";
import { keymap } from "@codemirror/view";
import { indentWithTab } from "@codemirror/commands";
import { oneDark } from "@codemirror/theme-one-dark";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { markdown } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";

// VS Code-style editor for the Files page: CodeMirror 6 + One Dark. Lazy-loaded (dynamic
// import in Files.tsx) so the main bundle stays lean — this chunk only downloads when a
// text file is actually opened. Monaco was rejected on purpose: ~3MB and poor on phones.

type Props = {
  value: string; // initial doc — the parent remounts us (key=path) per file, so no sync-back needed
  filename: string;
  onChange: (v: string) => void;
  onSave: () => void;
};

function langFor(name: string): Extension[] {
  if (/\.(ts|tsx|js|jsx|mjs|cjs)$/i.test(name)) return [javascript({ typescript: /\.tsx?$/i.test(name), jsx: /\.(tsx|jsx)$/i.test(name) })];
  if (/\.json$/i.test(name)) return [json()];
  if (/\.css$/i.test(name)) return [css()];
  if (/\.(html?|svg|xml|vue|astro)$/i.test(name)) return [html()];
  if (/\.(md|markdown)$/i.test(name)) return [markdown()];
  if (/\.py$/i.test(name)) return [python()];
  return [];
}

// transparent chrome AFTER oneDark so the page's frosted glass shows through the editor
const glassTheme = EditorView.theme({
  "&": { backgroundColor: "transparent", height: "100%", fontSize: "12px" },
  ".cm-gutters": { backgroundColor: "transparent", border: "none", color: "rgba(255,255,255,0.28)" },
  ".cm-activeLineGutter": { backgroundColor: "rgba(255,255,255,0.06)" },
  ".cm-activeLine": { backgroundColor: "rgba(255,255,255,0.045)" },
  ".cm-content": { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", caretColor: "oklch(70% 0.2 25)" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { overflow: "auto" },
});

export default function CodeEditor({ value, filename, onChange, onSave }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const saveRef = useRef(onSave);
  const changeRef = useRef(onChange);
  saveRef.current = onSave;
  changeRef.current = onChange;

  useEffect(() => {
    if (!hostRef.current) return;
    const view = new EditorView({
      parent: hostRef.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          basicSetup,
          keymap.of([{ key: "Mod-s", preventDefault: true, run: () => { saveRef.current(); return true; } }, indentWithTab]),
          oneDark,
          glassTheme,
          ...langFor(filename),
          EditorView.lineWrapping,
          EditorView.updateListener.of((u) => { if (u.docChanged) changeRef.current(u.state.doc.toString()); }),
        ],
      }),
    });
    return () => view.destroy();
    // parent remounts per file via key={path} — the doc never changes underneath a live view
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return <div ref={hostRef} className="h-full min-h-[50vh] [&_.cm-editor]:h-full" />;
}
