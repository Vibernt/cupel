import { fingerprint } from './value.mjs';
import { sourceReader } from './source.mjs';
export const DEFAULT_CAP = 1000;
export const bucket = () => ({ count: 0, capHit: false, incomplete: false, errors: [], records: [] });
export function recorder(root, owners, cap = DEFAULT_CAP) {
  if (!Number.isSafeInteger(cap) || cap < 1) throw new Error('assertion cap must be a positive integer');
  const read = sourceReader(root);
  return (matcher, actual, expected, { framework = 'node', negated = false, promise = '', stack = new Error().stack } = {}) => {
    const targets = owners();
    if (!targets.length) return;
    for (const target of targets) {
      target.count++;
      if (targets.length > 1) { target.incomplete = true; if (!target.errors.includes('concurrent attribution is ambiguous')) target.errors.push('concurrent attribution is ambiguous'); }
      if (target.records.length >= cap) { target.capHit = true; continue; }
      try {
        const { site, subject, expectedExpression } = read(stack, matcher, framework);
        const trivial = !negated && !promise && ((matcher === 'ok' && actual === true && subject === 'true') ||
          (matcher === 'toBeDefined' && actual !== undefined) ||
          (matcher === 'toBe' && subject !== null && subject === expectedExpression && /^[A-Za-z_$][\w$]*(?: \. [A-Za-z_$][\w$]*)*$/.test(subject)));
        target.records.push({ site, matcher: [promise, negated ? 'not' : '', matcher].filter(Boolean).join('.'),
          subject, expectedFingerprint: fingerprint(expected), actualFingerprint: fingerprint(actual), trivial });
      } catch (error) {
        target.incomplete = true;
        target.errors.push(`assertion recording failed: ${error.message}`);
      }
    }
  };
}
