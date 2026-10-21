// Public entry point for the Cupel JS implementation.

export const SPEC_VERSION = 'cupel-spec/1';

// Stable exit codes (plans/ARCHITECTURE.md). Never renumber.
export const EXIT = Object.freeze({
  OK: 0,
  FAILED: 1, // a guardrail or check failed
  USAGE: 2, // bad arguments or unknown command
  ENVIRONMENT: 3, // a collector could not run
});

// The pure engine (cupel-spec/1): run(command, inputs, config, args, schemas) -> { report, exit }.
export { run } from './engine/index.mjs';
