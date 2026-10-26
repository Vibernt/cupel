# Version and compatibility

The public input, config and report contract is `cupel-spec/1`. An implementation of major 1 accepts `cupel-spec/1` and `cupel-spec/1.<n>` inputs and configs. An additive optional field or hint bumps the minor. A change to an existing report for the same input bumps the major. These guarantees are normative in [SPEC.md section 1](../../spec/SPEC.md). Compatibility of a future major version with prior majors is not yet specified there; do not rely on it without a new spec decision.

Validate against the schema shipped with the Cupel version actually running. The [source schemas](../../spec/schemas/) and the package copies must match. Unknown fields are invalid where a schema says `additionalProperties: false`; do not pass through arbitrary tool data. A converter should emit the version it implements and fail explicitly when the source format cannot supply required fields. Record runtime name and exact version for every collection; guard refuses incompatible runtimes with exit 3.

This kit documents the current CLI. Adapter capabilities beyond the fixture-output check still need direct tests: exact selection, hook boundaries, stable ids across moves, concurrency, rechecks and error cases. These obligations are in [K1–K14](../../spec/SPEC.md#14-collector-obligations-proved-by-the-adapter-kit-not-by-engine-cases).
