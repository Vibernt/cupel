import { environment } from './errors.mjs';

// Only these collector/mutator pairs have a live mutation implementation.
const MUTATION_RUNTIME = Object.freeze({ node: 'node', vitest: 'node', jest: 'node', pytest: 'python', go: 'go', cargo: 'rust', minitest: 'ruby' });

export function mutationRequested(scope) {
  return !!(scope.functions || scope.critical || (scope.changed && Object.keys(scope.changed).length) || scope.targeted?.length);
}

export function assertLiveMutationRunner(input, cfg, collectorKind, runnerName) {
  const configured = Object.keys(cfg.runners ?? {});
  const name = runnerName ?? (configured.length === 1 ? configured[0] :
    configured.length ? null : collectorKind || ({ python: 'pytest', node: 'node', go: 'go', rust: 'cargo', ruby: 'minitest' }[input.runtime?.name] ?? null));
  const runtime = input.runtime?.name ?? 'unknown';
  if (name === 'cargo' && runtime === 'rust') {
    const unsupported = Object.keys(cfg.runners?.cargo ?? {}).filter(key => key !== 'tests');
    if (unsupported.length)
      throw environment(`runner cargo: unsupported custom mutation configuration: ${unsupported.join(', ')}`);
  }
  if (MUTATION_RUNTIME[name] === runtime) return;
  throw environment(`runner ${name ?? 'unknown'} (runtime ${runtime}): mutation is not implemented; use --no-mutation only when intentionally collecting without it`);
}
