# Extending Cupel

> Status: planned. This page lists the extension points. Their references, worked examples and templates arrive with the spec (M2), the Node build (M3) and the extension kit (M6c).

Cupel is built so that you can add a test framework, a language or a tool without changing Cupel itself. Extensions run outside Cupel's process; Cupel never loads your code into itself.

| You want to | Do this | Code? |
|---|---|---|
| Mark tests critical or minor | Path rules in `cupel.json`, or a tag in the test | No |
| Flag your own brittle patterns | Pattern rules in `cupel.json` | No |
| Feed results from any tool or language | Write the input format, then run `cupel import`. Check your file with `cupel validate` | A converter |
| Collect from a runner Cupel does not know | Name an external collector command in `cupel.json` | A command, any language |
| Get per-test coverage for a framework | Write a framework adapter: list, select, boundaries, tags | Small |
| Prove your adapter is correct | Run `cupel conformance --adapter <command>` | No |

The input and report formats are versioned JSON Schemas (`cupel-spec/1`) and follow semver. A breaking change bumps the major version, and the previous version stays readable for at least one major release.

The design is in [plans/ARCHITECTURE.md](../../plans/ARCHITECTURE.md), under "Extending Cupel".
