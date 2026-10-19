const HOOKS = ["client-attached", "client-session-changed"];

export function missingHooks(showHooksOutput) {
  const lines = showHooksOutput.split(/\r?\n/);
  return HOOKS.filter((hook) => {
    const expected = new RegExp(`^${hook}\\[\\d+\\]\\s+(?:set|set-option) -w window-size latest\\s*$`);
    return !lines.some((line) => expected.test(line));
  });
}
