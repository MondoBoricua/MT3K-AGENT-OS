const HOOKS = ["client-attached", "client-session-changed"];

export function missingHooks(showHooksOutput) {
  const lines = showHooksOutput.split(/\r?\n/);
  return HOOKS.filter((hook) => {
    // tmux prints `hook[0] cmd`; psmux prints `hook -> cmd` (and `(no hooks)` when empty)
    const expected = new RegExp(`^${hook}(?:\\[\\d+\\])?\\s+(?:->\\s+)?(?:set|set-option) -w window-size latest\\s*$`);
    return !lines.some((line) => expected.test(line));
  });
}
