import { refuse } from './errors.mjs';

const actions = new Map([['pass', 'passed'], ['fail', 'failed'], ['skip', 'skipped']]);
const topLevel = (name) => /^Test[A-Z0-9_]/.test(name) && !name.includes('/');

export function parseGoResults(output, inventory) {
  const statuses = new Map();
  const packageFailures = new Set();
  for (const line of output.split('\n').filter(Boolean)) {
    let event;
    try { event = JSON.parse(line); }
    catch { refuse('go-results', `go test -json emitted non-JSON output: ${line.slice(0, 160)}`); }
    if (!event || typeof event !== 'object') refuse('go-results', 'go test -json emitted a non-object event');
    if (!event.Test && event.Action === 'fail') packageFailures.add(event.Package);
    if (!event.Test || !topLevel(event.Test) || !actions.has(event.Action)) continue;
    const test = inventory.lookup.get(`${event.Package}\0${event.Test}`);
    if (!test) refuse('isolation-mismatch', `go test reported an uncollected top-level test: ${event.Package} ${event.Test}`);
    if (statuses.has(test.id)) refuse('isolation-mismatch', `go test reported duplicate terminal status: ${test.id}`);
    statuses.set(test.id, actions.get(event.Action));
  }
  return { statuses, packageFailures };
}

export function baselineMatches(input, result, parsed) {
  if (result.timedOut || result.signal || result.status !== 0)
    refuse('baseline', `ordinary Go baseline did not pass (exit ${result.status}, signal ${result.signal ?? 'none'})`);
  const expected = new Map(input.tests.map((test) => [test.id, test.status]));
  if (parsed.statuses.size !== expected.size)
    refuse('isolation-mismatch', `ordinary Go baseline reported ${parsed.statuses.size} top-level tests; input has ${expected.size}`);
  for (const [id, status] of expected) {
    if (parsed.statuses.get(id) !== status)
      refuse('isolation-mismatch', `ordinary Go baseline differs from collected status: ${id} (${status} vs ${parsed.statuses.get(id) ?? 'missing'})`);
    if (status === 'failed') refuse('baseline', `ordinary Go baseline contains a failed test: ${id}`);
  }
  if (parsed.packageFailures.size) refuse('baseline', `ordinary Go baseline has package failure: ${[...parsed.packageFailures].join(', ')}`);
}

export function classifyGo(input, result, parsed) {
  if (result.timedOut) return { status: 'timeout', killedBy: [] };
  if (result.signal) return { status: 'error', killedBy: [] };
  if (parsed.statuses.size !== input.tests.length) return { status: 'error', killedBy: [] };
  const killers = [];
  for (const test of input.tests) {
    const actual = parsed.statuses.get(test.id);
    if (!actual) return { status: 'error', killedBy: [] };
    if (test.status === 'passed' && actual === 'failed') killers.push(test.id);
    else if (actual !== test.status) return { status: 'error', killedBy: [] };
  }
  if (killers.length) return { status: 'killed', killedBy: killers.sort() };
  if (result.status !== 0 || parsed.packageFailures.size) return { status: 'error', killedBy: [] };
  return { status: 'survived', killedBy: [] };
}
