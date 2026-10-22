# Vitest collection

Cupel uses the project's installed Vitest 3, 4 or 5. It detects Vitest from a `vitest` dependency, `vitest.config.*`, a `vite.config.*` with a `test` block, or `runners.vitest` in `cupel.json`. A plain Node project keeps node:test.

`cupel report` runs `vitest run` with the `forks` pool, a setup hook and a reporter. Vitest's own coverage is disabled. The hook uses an in-process inspector session to take precise V8 coverage at test boundaries; the collector maps ranges from Vite's evaluated code through its inline source map to original lines. TypeScript-only lines do not count as coverable. The input holds individual tests, `test.each` rows sharing a unit, tags, durations, source hashes, per-test coverage, setup coverage, brittleness and shapes. `cupel report` currently skips mutation for Vitest and says so in one progress line.

All Vitest cache and generated config files go under the project's `.scratch/` directory and are removed after collection. Cupel does not download Vitest. If it is not resolvable from the project root, collection fails with a cause.

Optional `cupel.json` settings:

```json
{
  "runners": {
    "vitest": {
      "tests": "tests/**/*.test.ts",
      "command": "node ./node_modules/vitest/vitest.mjs"
    }
  }
}
```

`tests` narrows test file discovery; `command` replaces the executable portion of the run command. It accepts quoted paths with spaces, then Cupel adds `run`, the generated config, reporter, pool and selected files. `runners.vitest.env` supplies test-run environment variables. Cupel still resolves Vitest from the project root to verify its version and load the matching test APIs.

The collector has a programmatic interface: `collectVitest({ root, config, files, runs, recheck, log })`. `recheck` selects a unit with `vitest run <file> -t <full name>` in its own process and replaces its shared-run coverage only when all rows execute with their original status.

Current limits: Node's `stripTypeScriptTypes` rejects JSX syntax in `.tsx`; Cupel stops with a clear error for such a file, pending a chosen parser path. Vitest 3 is version-detected but has not been run locally. Re-checks mark tests that spawn Node but do not yet add child-process coverage to their line sets.
