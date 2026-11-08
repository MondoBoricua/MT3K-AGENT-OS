# Vendored Herdr Agent Detection Manifests

- **Source repository**: https://github.com/herdrdev/herdr
- **Commit**: `ee5bfb5041bb3e4a49d591c72308aae3c81ecdde`
- **Vendored date**: 2026-11-07
- **License**: Apache-2.0 (see [`LICENSE-herdr`](./LICENSE-herdr))

## How to Refresh

To update the vendored detection rules from a newer checkout of `herdr`, copy `src/detect/manifests/*.toml` from the `herdr` repository into `scripts/agent-detection/manifests/` (and `LICENSE` into `scripts/agent-detection/LICENSE-herdr` if changed), update the commit hash in `scripts/agent-detection/ORIGIN.md` and `scripts/agent-detection/vendor.mjs`, and run `node scripts/agent-detection/vendor.mjs` to regenerate `scripts/agent-detection/manifests.json`. Verify with `node scripts/agent-detection/vendor.mjs --check` and `node --test 'scripts/tests/*.test.mjs'` before committing.
