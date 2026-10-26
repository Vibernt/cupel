# Extend Cupel

Cupel accepts extensions as files and commands outside its process. It never imports third-party extension code. The normative contract is [SPEC.md](../../spec/SPEC.md), especially sections 3, 4, 14 and 15; the current schemas are [config](../../spec/schemas/config.schema.json), [input](../../spec/schemas/input.schema.json) and [report](../../spec/schemas/report.schema.json). The package ships copies of those schemas.

| Need | Entry point | Guide |
| --- | --- | --- |
| Tier paths, title words and brittleness rules | `cupel.json` | [Config](config.md) |
| Results from an existing tool | `cupel-spec/1` JSON and `cupel import` | [Input](input.md) |
| Run another test tool | `runners.<name>.collector` command | [External collectors](collectors.md) |
| Per-test coverage in a framework | List, select, boundaries, tags | [Adapter template](adapter-template.md) |

Start with the [small input example](example-input.json): `cupel validate docs/extending/example-input.json`, then `cupel report --input docs/extending/example-input.json --json`. The file demonstrates a valid input and its limits; it is not a substitute for executing tests.

The [external collector demo](demo/) actually runs a tiny test and emits status-only input. It makes the absent coverage evidence explicit.

The [unittest example](unittest-example/) was built by a fresh agent using only
these public documents and their linked specification. Its measured tiny fixture
exercises list, exact selection, boundaries and tags. Its unsupported recheck and
multi-run modes fail explicitly; it is a documentation acceptance example, not a
production unittest collector.

A **status-only collector** can pass its own fixture-output check while providing
no per-test coverage, boundaries or tags. That is command/input acceptance, not
full framework-adapter certification. A **framework adapter** must implement all
four operations in SPEC section 15 and test their behavior. The current
`cupel conformance` command checks the emitted input; it does not independently
certify the other operations. Name the supported capability in every result.

An adapter must produce measured data from the runner, including failures and setup coverage. Validate its output, run the [adapter conformance command](adapter-template.md#conformance), then exercise it on a real repository. A schema-valid report alone does not prove the collector's coverage or selection behavior.

Versions and compatibility are in [Stability](stability.md). The spec and schemas take precedence when these examples lag a rule change.
