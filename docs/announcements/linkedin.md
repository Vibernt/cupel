# LinkedIn launch post

Your tests are green. But would they still catch the bug?

That question is why I built Cupel, now open-source under the MIT licence.

As coding agents write more code and more tests, I want a stronger review loop.
A test can execute the right lines and still have a weak assertion. A test
refactor can keep the suite passing while quietly removing protection.

Cupel helps make that loss visible.

It runs your tests, maps coverage to individual tests, and introduces small
source faults to check which tests actually fail. Then its full guard compares
a Git baseline with your proposed change, checking for lost coverage and lost
critical mutation protection within the configured scope.

One concrete result from our real-project Jest validation:

- The original suite had 51 tests across 4 files.
- It caught all 11 tested mutations in two declared critical API paths.
- We weakened one assertion. All 51 tests still passed, with unchanged coverage.
- Cupel detected the lost fault detection and failed the guard.

That is the problem I want solved before accepting a test change: a green suite
that has quietly become less useful.

My must-have in an AI-assisted coding workflow is a protection check alongside
the normal test run and code review. Cupel makes that practical through a local
CLI and MCP server, so developers and coding agents can inspect the same evidence.

No model calls inside Cupel. No telemetry. Its shipped runtime makes no network
calls; the tests and preparation commands it runs are still your project's code.

The first version supports ordinary full guard for node:test, Vitest, a documented
Jest profile, and pytest. Go, Ruby and Rust are bounded previews. Selective PR
execution is experimental; I am not claiming general CI speedups or automatic
test deletion.

Try it on a test change in your own project. I would love feedback on the gaps
it exposes and the workflows it should support next.

https://github.com/Vibernt/cupel

#OpenSource #SoftwareTesting #MutationTesting #DeveloperTools #AIEngineering
