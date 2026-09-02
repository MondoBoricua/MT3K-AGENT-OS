# File Manager location sync — TDD evidence

## Source and user journey

No plan file was provided. The journey came from the reported regression:

> As a file-manager user, I want the location field to follow the folder I select, so the visible location and the destination used for file operations agree.

## Task report

- Added a regression test for the selected directory state.
- RED: `npm test` failed because `directorySelection` did not exist; checkpoint `44fbf7c`.
- GREEN: `npm test` passed all 3 tests after synchronizing `selectedDir` and `pathInput`; checkpoint `d876a8b`.
- Build: `npm run build` completed successfully.
- Browser verification: selecting `/Users/mondo/MT3K-AGENT-OS/panel` updated the location field and destination label to that exact path, kept the folder selected, and left its children expanded.

## Test specification

| # | What is guaranteed | Test or command | Type | Result | Evidence |
|---|---|---|---|---|---|
| 1 | Selecting a folder produces the same value for the operational destination and visible location | `panel/tests/file-manager.test.ts` | Unit | PASS | `npm test` — 3/3 passed |
| 2 | The extracted file-manager helper remains fully covered | Node test coverage | Coverage | PASS | 100% lines, branches, and functions |
| 3 | The React/TypeScript production bundle compiles | `npm run build` | Integration/build | PASS | TypeScript and Vite build completed |
| 4 | The live UI updates the field and keeps the selected folder expanded | Browser automation against `http://localhost:4288/` | E2E | PASS | Exact path, `aria-pressed=true`, and visible child asserted |

## Coverage and known gaps

`node --experimental-strip-types --experimental-test-coverage --test tests/*.test.ts` reports 100% coverage for `src/lib/file-manager.ts`. The browser assertion is an executed verification rather than a checked-in Playwright suite because Playwright is not a project dependency.

## Merge evidence

- RED checkpoint: `44fbf7c test: reproduce stale file manager location`
- GREEN checkpoint: `d876a8b fix: sync file manager location with folder selection`
