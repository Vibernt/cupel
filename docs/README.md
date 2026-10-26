# Cupel documentation

Start with the [README](../README.md). The [support matrix](support.md) defines
core JS/TS/Python ordinary full guard, bounded Go/Ruby/Rust previews and
experimental selection outside the supported first release.

## Getting started

- [Install from the source checkout](install.md): source CLI, offline npm tarball and Python wheel.
- [Review and protect a change](private-use.md): installed workflow, baseline choice and artifact provenance.
- [Support matrix](support.md): exact tested versions, scope boundaries and unverified gates.

## Usage

- [CLI reference](cli.md): commands, configuration, exit codes, baseline dependencies and JUnit import.
- [Local MCP](mcp.md): client setup, tools, fresh reports and historical snapshot pages.
- [GitHub Action wrapper](../action/README.md): local acceptance only; hosted enforcement is unverified.
- [Selective PR experiment](selective-pr.md): experimental profile outside the supported first release.

## Runners

- Core: [Jest](jest.md), [Vitest](vitest.md), [Python/pytest](python.md); `node:test` uses the [CLI](cli.md) and [config](extending/config.md).
- Bounded previews: [Go](go.md), [Ruby/Minitest](ruby.md), [Rust/Cargo](rust.md). Each page retains its exact restrictions.

## Extensions

- [Extension kit](extending/README.md): choose a data, collector or adapter extension.
- [Input contract](extending/input.md), [config](extending/config.md), [collectors](extending/collectors.md) and [stability](extending/stability.md).
- [Adapter template](extending/adapter-template.md) and [unittest example](extending/unittest-example/README.md).

## Developer evidence

- [LinkedIn launch copy](announcements/linkedin.md): prepared copy; posting is a separate action.

- [Contributing](../CONTRIBUTING.md) and [development checks](development.md): targeted tests, required tools, optional fixture skips and artifact gates.
- [Spec](../spec/SPEC.md) and [locked decisions](../plans/DECISIONS.md): normative behavior and constraints.
- [First-release checklist](../plans/FIRST-RELEASE-CHECKLIST.md) and [release readiness](../plans/RELEASE-READINESS.md): source/artifact gates, named handoffs and pending work.
- [Runner completion](../plans/RUNNER-COMPLETION.md): capability and evidence detail.
- [Jest real-repository acceptance](../plans/results/2026-10-26-jest-acceptance.md): complete 51-test lane, mutants and negative guard control.
- [Audited benchmark](../bench/BENCHMARK.md): historical measurements and their limitations.

Plans and spike records remain in their original locations so their provenance
and existing links are preserved. New support claims belong in the support
matrix and must link their evidence.
