// Why node:test did not measure a JSX source (SPEC K2, I3). Shared by the collector and the shard merge.
//
// node:test runs JSX only through a loader the project sets up, so a JSX source no test loaded has no evidence
// either way; one loaded without a usable source map cannot be mapped back.

export const JSX_NOT_LOADED = 'JSX not loaded by any test: node:test runs JSX only through a loader the project sets up (for example --import tsx), so its lines are not measured';
export const JSX_IN_CHILD = 'JSX not loaded in any test process Cupel measures, but tests start node processes that may run it unseen, so its lines are not measured';
export const JSX_NO_MAP = 'JSX loaded without a usable source map, so its lines are not measured';
export const JSX_NO_TYPESCRIPT = 'JSX lines come from the project\'s typescript, which is not resolvable from the project root';
export const JSX_UNPARSED = 'JSX the project\'s typescript cannot parse, so its lines are not measured';
