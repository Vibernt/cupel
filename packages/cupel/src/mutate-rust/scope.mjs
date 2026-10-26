import { isCriticalSource } from '../engine/model.mjs';
import { anyGlobMatches } from '../engine/match.mjs';
import { parse } from '../engine/lines.mjs';
import { mutationModel } from '../mutate/model.mjs';
import { refuse } from './errors.mjs';

const expand = (intervals) => {
  if (intervals.reduce((sum,[a,b]) => sum+b-a+1,0)>1_000_000) refuse('scope-bound','Rust line scope exceeds one million lines');
  return intervals.flatMap(([a,b]) => Array.from({length:b-a+1},(_,i)=>a+i));
};
function specified(value) {
  if (Array.isArray(value)) {
    if (value.some((n)=>!Number.isSafeInteger(n)||n<1)) refuse('scope','Rust changed lines must be positive safe integers');
    return value.map((n)=>[n,n]);
  }
  const row=parse(value);
  if (row.malformed || row.bad.length) refuse('scope','Rust changed line ranges are malformed');
  return row.set;
}

export function scopeRust(input, cfg, scope) {
  if (scope.functions) refuse('unsupported-scope', 'Rust function/body mutation scope is not implemented');
  const model = mutationModel(input, cfg, scope.targeted ?? []);
  const wanted = new Map();
  const add = (source, ranges) => {
    if (!model.sources.has(source)) return;
    const coverable = new Set(expand(model.sources.get(source).coverable));
    const target = wanted.get(source) ?? new Set();
    for (const line of expand(ranges)) if (coverable.has(line)) target.add(line);
    wanted.set(source, target);
  };
  if (scope.critical) for (const [source, row] of model.sources)
    if (isCriticalSource(source, cfg)) add(source, row.coverable);
  for (const [source, value] of Object.entries(scope.changed ?? {})) {
    if (!model.sources.has(source)) refuse('scope', `changed Rust source is absent from canonical input: ${source}`);
    const ranges = specified(value);
    add(source, ranges);
  }
  const own = new Map();
  for (const uid of scope.targeted ?? []) {
    const unit = model.unitById.get(uid);
    if (!unit) refuse('scope', `targeted Rust unit is absent from input: ${uid}`);
    own.set(uid, unit.own);
    for (const [source, ranges] of unit.own) add(source, ranges);
  }
  const include = cfg.scope?.include ?? ['**'];
  const exclude = cfg.scope?.exclude ?? [];
  for (const source of wanted.keys()) if (!anyGlobMatches(include, source) || anyGlobMatches(exclude, source) || !wanted.get(source).size)
    wanted.delete(source);
  return { wanted, own };
}

export function lineIn(ranges, line) {
  return ranges.some(([a, b]) => line >= a && line <= b);
}
