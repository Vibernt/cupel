# Cupel spec (`cupel-spec/1`)

This is the single source of truth for every Cupel implementation. It covers:

- tier labels and path rules
- the value signals and how they combine
- the keep, consolidate, rewrite and retire rules
- the guardrails
- the report and config formats, as JSON Schemas

It is written in milestone M2, after the M1 spikes. See [plans/ARCHITECTURE.md](../plans/ARCHITECTURE.md) and [plans/ROADMAP.md](../plans/ROADMAP.md).

`conformance/` holds the input fixtures and the exact expected reports. Every implementation must pass every case.
