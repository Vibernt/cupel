import { isCriticalSource } from '../engine/model.mjs';
import { anyGlobMatches } from '../engine/match.mjs';
import { lines as parseLines } from '../engine/lines.mjs';
import { mutationModel } from '../mutate/model.mjs';
import { refuse } from './errors.mjs';

const expand = (intervals) => intervals.flatMap(([a, b]) => Array.from({ length: b - a + 1 }, (_, i) => a + i));
const specified = (value) => Array.isArray(value) ? value.map((n) => [n, n]) : parseLines(String(value ?? ''));

export function scopeGo(input, cfg, scope) {
  if (scope.functions) refuse('unsupported-scope', 'Go function/body mutation scope is not implemented');
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
    if (!model.sources.has(source)) continue;
    const ranges = specified(value);
    add(source, ranges.length ? ranges : model.sources.get(source).coverable);
  }
  const own = new Map();
  for (const uid of scope.targeted ?? []) {
    const unit = model.unitById.get(uid);
    if (!unit) refuse('scope', `targeted Go unit is absent from input: ${uid}`);
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
