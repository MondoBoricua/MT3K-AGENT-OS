import { memo, useMemo } from "react";
import { ansiToHtml } from "../lib/ansi";

type Props = { line: string; last: boolean };

// Memoized by raw line: unchanged rows keep their HTML and DOM, including selection.
// sanitized HTML: ansiToHtml escapes all text; spans carry only numeric-derived colors
export const TerminalLine = memo(function TerminalLine({ line, last }: Props) {
  const html = useMemo(() => ansiToHtml(line), [line]);
  return <span className="whitespace-pre-wrap break-words" dangerouslySetInnerHTML={{ __html: html + (last ? "" : "\n") }} />;
});

export default TerminalLine;
