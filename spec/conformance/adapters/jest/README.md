# Jest adapter conformance fixture

This fixture owns Jest 30.2.0 and TypeScript 5.9.3 as test-only dependencies. Run
`npm ci --prefix spec/conformance/adapters/jest` before its actual-runtime tests.
The Cupel package does not depend on Jest or TypeScript. The fixture exercises
parameterized and duplicate IDs, exact selection, hooks, overlapping concurrent
tests, a transformed TypeScript source map, and a source-text pin.
