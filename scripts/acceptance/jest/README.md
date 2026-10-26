# Ordinary Jest acceptance helpers

These offline helpers compare the complete original Jest result with collected
Cupel rows and capture command stdout, stderr, exit and whole-call cost. They
neither acquire projects/dependencies nor choose a subject or installed artifact.

Import `ordinaryRows` / `assertCollectionParity` from `compare.mjs`, `command`
from `command.mjs`, and `pinnedProducer` from `producer.mjs`. Supply explicit
absolute subject, Node, binary and evidence paths plus the independently
approved producer hash. A pin mismatch is an error. Execute commands with an
explicit minimal environment appropriate to the original project, preserving
its configuration, setup, reporters and documented runtime flags.

Run the helper smoke tests with:

```sh
node --test scripts/acceptance/jest/*.test.mjs
```

The actual 2026-10-26 real-project method, immutable project/tool pins, policy,
whole-lane counts and acceptance verdict are recorded in
`plans/results/2026-10-26-jest-acceptance.md`. Raw public subject content,
dependencies, invocation logs and supplemental control copies stay in ignored
scratch. Supplemental source-pin tests must remain distinct from the original
upstream suite.
