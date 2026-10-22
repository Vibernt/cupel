# Go collector fixture

This package has three top-level tests, a critical tag, a branchy function,
package initialization, and an uncalled function. `expected.json` was written
from the source and the statement-block rule in `docs/go.md`: the initializer
at line 6 is setup, the branch test covers lines 10-11, the zero test covers
10 and 13-14, and the positive test covers 10, 13 and 16. The uncalled line 20
is coverable but uncovered. Runtime version and durations are dynamic.
Verification compares this expectation with a fresh collector run, validates
the schema, and runs the report engine. A `go test` coverprofile independently
shows the seven statement blocks and confirms the line mapping. The test binary
is compiled once, then each test runs in its own process. The empty
`-test.run '^$'` process measures setup coverage.
