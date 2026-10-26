# Config extensions

Write `cupel.json` at the repository root and check it with `cupel validate cupel.json`. Every key and allowed value is in the [config schema](../../spec/schemas/config.schema.json). These rules are data, not executable plugins.

```json
{
  "spec": "cupel-spec/1",
  "scope": { "include": ["src/**"], "exclude": ["src/generated/**"] },
  "tiers": {
    "critical": ["tests/auth/**"],
    "minor": ["tests/examples/**"],
    "extraPathWords": ["settlement"],
    "extraTitleWords": ["fraud"]
  },
  "brittleness": {
    "patterns": [
      { "kind": "source-text", "language": "javascript", "pattern": "readFileSync\\s*\\(", "description": "Review tests that pin source text" }
    ]
  }
}
```

`tiers.critical` and `tiers.minor` are path patterns; title tags such as `[critical]`, `[standard]` and `[minor]` can mark individual tests. Built-in critical path/title words remain active; `extraPathWords` and `extraTitleWords` add words without replacing them. `pathWords` and `titleWords` replace the corresponding defaults if explicitly supplied. A word that tokenizes to nothing is invalid. An unknown tier tag is a label error, not silently ignored. See [SPEC.md section 5](../../spec/SPEC.md) for precedence and matching.

The example brittleness pattern is a regular-expression string interpreted by a collector for matching test source. A finding in the input has `{ "test": "<id>", "kind": "source-text" }`; the engine does not scan source or execute the regex. Collector support for a language and pattern kind must be checked before depending on it. Mark a deliberate source pin with `deliberate: true` in its finding. Avoid rules that flag every test.

For guard enforcement, keep the effective config outside a proposed change's write scope. The [Action](../../action/README.md) reads `cupel.json` from the exact trusted base commit. Test a rule with `cupel label --input <measured-input> --config cupel.json --json`; a config file alone cannot demonstrate that a collector produced expected tags or findings.
