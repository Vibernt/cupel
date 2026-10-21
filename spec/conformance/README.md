# Conformance

Every Cupel implementation must pass everything here. The rules are in [../SPEC.md](../SPEC.md).

## Engine cases (`cases/`)

Each directory is one case: `case.json`, the input or inputs, an optional `config.json` and `expected.json`. Section 16 of the spec gives the matching rules.

- Every engine rule (I, T, S, A, P, C, G, L, R, E) has at least one positive and one negative case. A test in `packages/cupel/test/conformance-cases.test.mjs` enforces this.
- The cases are generated from [`build.mjs`](build.mjs). Edit the definitions there, then run `node spec/conformance/build.mjs`. `--check` fails when the files on disk differ from the definitions.
- Every expected value was worked out by hand from the spec, never produced by an engine.

## Adapter fixtures (`adapters/`)

There is one tiny project per test framework, with the input an adapter must produce. These prove the collector rules (K) and the adapter contract (spec section 15). `node-test/` is the first.
