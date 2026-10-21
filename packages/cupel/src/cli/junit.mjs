// JUnit XML to a cupel-spec/1 input (D10). Results and durations only: sources are empty and coverage
// is `file` granularity with no `byFile`, so the engine can plan, label and report tiers, but never
// advises retire from JUnit alone.
//
// Id mapping: `<file or classname>::<name>`, where the first part is the testcase's `file` attribute,
// else its `classname`, else the enclosing testsuite's `file`, else its `name`, else the XML file's path.
// The same id seen again (another file from a repeated run, or a rerun) is another run of that test:
// its duration is appended to `durationsMs`, and the test is failed if any run failed, skipped only if
// every run was skipped, and passed otherwise.
// Durations: `time` in seconds, rounded to whole milliseconds; a missing or unreadable `time` records
// no duration for that run.
// Status: a `<failure>` or `<error>` child is failed; `<skipped>` is skipped; anything else (including
// surefire's `<flakyFailure>` and `<rerunFailure>`, after which the test passed) is passed.
// Tier tags written in a test name (`[critical]`, `[standard]`, `[minor]`) become `tags`.

import { parseXml, XmlError } from './xml.mjs';
import { cmp } from '../engine/order.mjs';

const TIER_TAGS = ['critical', 'standard', 'minor'];

function* testcases(el, suites) {
  if (el.name === 'testcase') {
    yield { el, suites };
    return;
  }
  const next = el.name === 'testsuite' ? [...suites, el] : suites;
  for (const child of el.children) yield* testcases(child, next);
}

function statusOf(el) {
  const names = new Set(el.children.map((c) => c.name));
  if (names.has('failure') || names.has('error')) return 'failed';
  if (names.has('skipped')) return 'skipped';
  return 'passed';
}

function durationMs(el) {
  const t = el.attrs.time;
  if (t === undefined) return null;
  // "1,234.5" (thousands separators, as some surefire versions write) is read; a comma alone
  // ("0,5") is ambiguous between locales, so that run records no duration.
  let v = t.trim();
  if (v.includes(',')) {
    if (!/^\d{1,3}(,\d{3})+\.\d+$/.test(v)) return null;
    v = v.replace(/,/g, '');
  }
  if (!/^\d+(\.\d+)?([eE][-+]?\d+)?$/.test(v)) return null;
  const s = Number(v);
  if (!Number.isFinite(s) || s < 0) return null;
  return Math.round(s * 1000);
}

function fileOf(el, suites, xmlPath) {
  const a = el.attrs;
  if (a.file) return a.file;
  if (a.classname) return a.classname;
  for (let i = suites.length - 1; i >= 0; i--) if (suites[i].attrs.file) return suites[i].attrs.file;
  for (let i = suites.length - 1; i >= 0; i--) if (suites[i].attrs.name) return suites[i].attrs.name;
  return xmlPath;
}

const merge = (a, b) => {
  if (a === 'failed' || b === 'failed') return 'failed';
  if (a === 'skipped' && b === 'skipped') return 'skipped';
  return 'passed';
};

/**
 * @param {{ path: string, text: string }[]} files JUnit XML documents
 * @param {{ name?: string, version?: string }} runtime
 */
export function junitToInput(files, runtime = {}) {
  const byId = new Map();
  for (const { path, text } of files) {
    let root;
    try {
      root = parseXml(text);
    } catch (e) {
      throw e instanceof XmlError ? new XmlError(`${path}: ${e.message}`) : e;
    }
    if (root.name !== 'testsuites' && root.name !== 'testsuite' && root.name !== 'testcase') {
      throw new Error(`${path}: root element <${root.name}> is not <testsuites> or <testsuite>`);
    }
    for (const { el, suites } of testcases(root, [])) {
      const name = el.attrs.name ?? '';
      const file = fileOf(el, suites, path);
      const id = `${file}::${name}`;
      const status = statusOf(el);
      const ms = durationMs(el);
      const prev = byId.get(id);
      if (prev) {
        if (prev.file !== file) throw new Error(`${path}: test id ${JSON.stringify(id)} appears with two files`);
        prev.status = merge(prev.status, status);
        if (ms !== null) prev.durationsMs.push(ms);
      } else {
        const test = { id, file, name, status, durationsMs: ms === null ? [] : [ms] };
        const tags = TIER_TAGS.filter((t) => name.includes(`[${t}]`));
        if (tags.length) test.tags = tags;
        byId.set(id, test);
      }
    }
  }
  const tests = [...byId.values()]
    .sort((a, b) => cmp(a.id, b.id))
    .map(({ id, file, name, tags, status, durationsMs }) => {
      const t = { id, file, name };
      if (tags) t.tags = tags;
      t.status = status;
      if (durationsMs.length) t.durationsMs = durationsMs;
      return t;
    });
  return {
    spec: 'cupel-spec/1',
    kind: 'input',
    runtime: { name: runtime.name || 'unknown', version: runtime.version || 'unknown' },
    sources: {},
    tests,
    coverage: { granularity: 'file' },
  };
}
