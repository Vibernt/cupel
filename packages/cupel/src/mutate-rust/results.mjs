import { refuse } from './errors.mjs';
export function parseResults(output, inventory) {
  const statuses = new Map();
  const body = output.split(/\nfailures:\s*\n/)[0];
  for (const line of body.split('\n')) {
    const match = /^test ([A-Za-z_][A-Za-z_0-9:]*) \.\.\. (ok|FAILED|ignored)$/.exec(line.trim());
    if (!match) continue;
    const test = inventory.tests.get(match[1]);
    if (!test || statuses.has(test.id)) refuse('rust-results',`unknown or duplicate Rust harness terminal: ${match[1]}`);
    statuses.set(test.id,{ok:'passed',FAILED:'failed',ignored:'skipped'}[match[2]]);
  }
  return statuses;
}
export function baselineMatches(input,result,statuses) {
  if (result.timedOut || result.signal || result.status !== 0) refuse('baseline',`ordinary Cargo baseline did not pass (exit ${result.status}, signal ${result.signal ?? 'none'})`);
  if (statuses.size !== input.tests.length) refuse('isolation-mismatch','ordinary Rust baseline has incomplete test inventory');
  for (const test of input.tests) if (statuses.get(test.id) !== test.status || test.status === 'failed') refuse('isolation-mismatch',`ordinary Rust baseline differs from input status: ${test.id}`);
}
export function classify(input,result,statuses) {
  if (result.timedOut) return {status:'timeout',killedBy:[]};
  if (result.signal || statuses.size !== input.tests.length) return {status:'error',killedBy:[]};
  const killedBy = [];
  for (const test of input.tests) {
    const status = statuses.get(test.id);
    if (test.status === 'passed' && status === 'failed') killedBy.push(test.id);
    else if (status !== test.status) return {status:'error',killedBy:[]};
  }
  if (killedBy.length && result.status !== 0) return {status:'killed',killedBy:killedBy.sort()};
  if (result.status !== 0 || killedBy.length) return {status:'error',killedBy:[]};
  return {status:'survived',killedBy:[]};
}
export function invalidCompile(result, source, backing) {
  if (result.status === 0 || result.signal || result.timedOut) return false;
  const diagnostics = result.stdout.split('\n').filter(Boolean).flatMap((line) => { try { const row=JSON.parse(line); return row.reason==='compiler-message' ? [row.message] : []; } catch { return []; } });
  const errors = diagnostics.filter((d) => d?.level === 'error');
  return errors.length > 0 && errors.every((d) => d.code?.code && /^E\d{4}$/.test(d.code.code) && d.spans?.some((s) => s.is_primary && [source,backing].includes(s.file_name)));
}
