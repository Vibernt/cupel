# External collector commands

Configure a command in `cupel.json`:

```json
{
  "spec": "cupel-spec/1",
  "runners": {
    "myrunner": {
      "collector": "node ./tools/cupel-myrunner.mjs",
      "prepare": "node ./tools/build-tests.mjs"
    }
  }
}
```

The [executable demo](demo/) is deliberately status-only: its [collector](demo/collector.mjs) actually runs one `node:test` fixture and writes the result, but reports no source or per-test coverage. From the repository root run:

```sh
node packages/cupel/bin/cupel.mjs report --config docs/extending/demo/cupel.json --no-mutation --runs 1 --out .scratch/extending-demo-input.json
node packages/cupel/bin/cupel.mjs validate .scratch/extending-demo-input.json
```

This demonstrates command wiring and honest missing evidence. It is not a guard-capable framework adapter; implement the [four adapter operations](adapter-template.md) before claiming per-test coverage or exact selection.

`cupel report` executes the named collector in the project root, outside Cupel's process. It appends `--root <path> --runs <positive integer> --out <temporary JSON path>` and zero or more `--recheck <unit id>` arguments. The command must run the selected suite, write a complete `cupel-spec/1` input to `--out`, and exit nonzero with a clear error when it cannot collect. Standard output is not the input channel for this command. Cupel reports a failed command, invalid JSON or a missing `--out` file as an environment error (exit 3). It does not recover by selecting a different collector.

Parse options as arguments in your command. Use `--root` for source paths and runner cwd, `--runs` for repeated measurements, and `--recheck` only after running that unit alone in a separate process and replacing its shared-process coverage. If the runner cannot select a unit exactly, fail the command; do not list it as rechecked. For a named runner, set `tests` in config only if that runner's collector supports it; Cupel currently forwards `--tests` to the Go, Cargo and Minitest external collectors, not every custom command. A `prepare` command runs before collection; its failures stop collection. `runners.<name>.env` supplies additional runner environment variables.

Use [the input guide](input.md) to map results, covered lines, setup and optional mutation data. `cupel validate <written-file>` checks structure and integrity. Then run the [conformance fixture](adapter-template.md#conformance) and a real project. When guard compares a base commit, it extracts and collects that tree separately with the same effective config. Commands that need dependencies in the extracted tree must have them available without network installation.

The runner command is local code with the same trust level as the repository's tests. Keep guard policy and any approvals in trusted CI scope; see the [Action](../../action/README.md). Cupel itself performs no network call, installation or upload.
