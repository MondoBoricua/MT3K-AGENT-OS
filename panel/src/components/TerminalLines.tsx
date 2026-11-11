import { memo, useMemo } from "react";
import { ansiToHtml, type BranchTitles } from "../lib/ansi";

type Props = { line: string; last: boolean; branches?: BranchTitles };

// Memoized by raw line: unchanged rows keep their HTML and DOM, including selection.
// sanitized HTML: ansiToHtml escapes all text; spans carry only numeric-derived colors; links carry only
// an http(s) href or escaped data- attributes (clicks: one delegated handler, lib/use-terminal-links.ts)
export const TerminalLine = memo(function TerminalLine({ line, last, branches }: Props) {
  const html = useMemo(() => ansiToHtml(line, { branches }), [line, branches]);
  return <span className="whitespace-pre-wrap break-words" dangerouslySetInnerHTML={{ __html: html + (last ? "" : "\n") }} />;
});

export default TerminalLine;
