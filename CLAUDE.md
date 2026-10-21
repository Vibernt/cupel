@AGENTS.md

## Code map

- `plans/`: product, architecture, spikes (`plans/spikes/`), roadmap, decisions. Read before changing scope.
- `spec/`: `cupel-spec/1`, plus conformance cases in `spec/conformance/`.
- `packages/cupel/`: the JS implementation (Node 22+, ESM, no dependencies). The CLI is in `bin/cupel.mjs`, the library in `src/` and the tests in `test/`.
- `packages/cupel-py/`: the pytest collector (stdlib only). The code is in `src/vibernt_cupel/`.
- `action/`: the GitHub Action (M5).
- `scripts/check.mjs`: repository rule checks (no network, determinism, pinned deps, still private).
- `.scratch/`: git-ignored scratch copies for spikes.

## Commands

```bash
npm run check      # repository rule checks
npm test           # Node tests, quiet
npm run test:py    # Python tests
```
