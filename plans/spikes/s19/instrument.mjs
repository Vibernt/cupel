import assert from 'node:assert/strict';
import { sha256 } from './pin.mjs';

export const SELECT_SHA256 = '6073bca97712239b7b09277d2e5feea89d826b9c94f5bc5fc464933c682f15b7';
const START = '  select(m) {';
const END = '  /**\n   * Orders a mutant';

export function selectMethod(source) {
  assert.equal(source.split(START).length, 2, 'Session.select anchor changed');
  const start = source.indexOf(START);
  const end = source.indexOf(END, start);
  assert.ok(end > start, 'Session.select end anchor missing');
  const method = source.slice(start, end);
  assert.equal(sha256(method), SELECT_SHA256, 'Session.select source changed');
  assert.equal(method.match(/parseLines\(/g)?.length, 2, 'unexpected coverage parse sites');
  return { start, end, method };
}

export function newProfile() {
  return { calls: 0, selectNs: 0, parseCalls: 0, parseNs: 0,
    firstParseCalls: 0, firstParseNs: 0, repeatedParseCalls: 0, repeatedParseNs: 0,
    testRows: 0, fileRows: 0, selectedTests: 0, selectedFiles: 0,
    targetedFull: 0, seen: new Set() };
}

export function profileData(profile) {
  const { seen, ...rest } = profile;
  return { ...rest, uniqueCoverageStrings: seen.size };
}

export function transformSelect(source, mode = 'full') {
  if (!['full', 'outer'].includes(mode)) throw new Error('unsupported S19 instrument mode');
  const { start, end, method } = selectMethod(source);
  const body = method.slice(START.length, method.lastIndexOf('  }'));
  const profile = `    const profile = globalThis.__CUPEL_S19_PROFILE;\n    if (!profile) throw new Error('S19 profile must be explicitly installed');\n    const started = process.hrtime.bigint();\n    profile.calls++;\n    try {`;
  const close = `    } finally { profile.selectNs += Number(process.hrtime.bigint() - started); }\n  }\n\n`;
  if (mode === 'outer') {
    const wrapped = `${START}\n${profile}\n${body}${close}`;
    return source.slice(0, start) + wrapped + source.slice(end);
  }
  const parse = `    const parseSelected = (value) => {\n      const begun = process.hrtime.bigint();\n      const set = parseLines(value);\n      const elapsed = Number(process.hrtime.bigint() - begun);\n      profile.parseCalls++;\n      profile.parseNs += elapsed;\n      if (profile.seen.has(value)) { profile.repeatedParseCalls++; profile.repeatedParseNs += elapsed; }\n      else { profile.seen.add(value); profile.firstParseCalls++; profile.firstParseNs += elapsed; }\n      return set;\n    };\n`;
  let measured = body.replaceAll('parseLines(', 'parseSelected(');
  measured = measured.replace('    for (const t of this.input.tests) {',
    '    for (const t of this.input.tests) {\n      profile.testRows++;');
  measured = measured.replace('      for (const [file, cov] of index) {',
    '      for (const [file, cov] of index) {\n        profile.fileRows++;');
  measured = measured.replace('    return { tests, counts, needsFull };',
    '    profile.selectedTests += tests.length;\n    profile.selectedFiles += counts.size;\n    if (needsFull) profile.targetedFull++;\n    return { tests, counts, needsFull };');
  const wrapped = `${START}\n${profile}\n${parse}${measured}${close}`;
  return source.slice(0, start) + wrapped + source.slice(end);
}

export function exportSession(source) {
  if (source.includes('export { Session };')) throw new Error('Session already exported');
  return `${source}\nexport { Session }; // S19 scratch replay only\n`;
}
