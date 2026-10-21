#!/usr/bin/env node
// S9: map every test definition (S6 site: file and line of its title) to the commit that introduced it, and annotate
// commits. Imported by the analysis scripts; run directly it writes results/mapping.json (ambiguity and timing).
//
// Usage: node plans/spikes/s9/sites.mjs
//
// Mapping. The introducing commit of a test is the blame commit of its title line (the S6 detector's `line`). Checks:
// - moved: blame's filename for that line differs from the current path (blame followed a rename);
// - title-newer: some line of the test body is older than its title line (the title was edited later, or the body
//   came from elsewhere): the oldest body commit is kept as the alternative mapping;
// - possible-move: the introducing commit is the path's first commit in the `--no-renames` history and it also deletes
//   at least as many lines as the test is long from another test file (`*.test.*` or `test_*.py`): a move or split
//   blame did not follow;
// - not-in-log: the blame commit is not in the exported history.
// A mapping is ambiguous when title-newer, possible-move or not-in-log holds.

import { writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { S9, SUITES, parseHistory, parseBlame, blameName, loadSites, isFix, isMerge, agentOf, commitKind, looksSquashed, pathClass } from './lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
/** A test file proper (not a support module or a data file). */
const TEST_FILE_RE = /(\.test\.[cm]?[jt]sx?|(^|\/)test_[^/]*\.py)$/;

export function buildSuite(suite, timing = {}) {
  let t0 = performance.now();
  const log = parseHistory(join(S9, SUITES[suite].history));
  timing.parseHistoryMs = Math.round(performance.now() - t0);
  const root = log.filter((c) => c.parents.length === 0).map((c) => c.sha);
  const commits = new Map();
  log.forEach((c, i) => {
    const sq = looksSquashed(c);
    commits.set(c.sha, {
      sha: c.sha, order: i, date: c.date, subject: c.subject, merge: isMerge(c), root: c.parents.length === 0,
      fixAny: isFix(c), fixSubject: isFix(c, { subjectOnly: true }), agent: agentOf(c), kind: commitKind(c),
      files: c.files.length, testFiles: c.files.filter((f) => pathClass(f.path) === 'test').length,
      added: c.files.reduce((s, f) => s + (f.add ?? 0), 0), squash: sq,
      // test files whose lines this commit removed, for the move check
      testDeletes: c.files.filter((f) => TEST_FILE_RE.test(f.path) && (f.del ?? 0) > 0).map((f) => ({ path: f.path, del: f.del })),
      sites: 0,
    });
  });
  // First commit touching each path (oldest; the log is newest first).
  const firstOf = new Map();
  for (let i = log.length - 1; i >= 0; i--) for (const f of log[i].files) if (!firstOf.has(f.path)) firstOf.set(f.path, log[i].sha);

  t0 = performance.now();
  const sites = [...loadSites(suite).values()];
  const blames = new Map();
  let blameLines = 0, missingBlame = 0;
  for (const s of sites) {
    if (!blames.has(s.file)) {
      const p = join(S9, SUITES[suite].blame, blameName(s.file));
      blames.set(s.file, existsSync(p) ? parseBlame(p) : null);
      if (blames.get(s.file)) blameLines += blames.get(s.file).lines.length;
    }
    const b = blames.get(s.file);
    if (!b || !b.lines[s.line - 1]) { s.intro = null; missingBlame++; continue; }
    const title = b.lines[s.line - 1];
    s.intro = title.sha;
    s.introFilename = title.filename;
    const end = Math.min(s.endLine, b.lines.length);
    const shas = new Set();
    let oldest = title.sha, oldestT = b.meta.get(title.sha).authorTime;
    for (let l = s.line; l <= end; l++) {
      const x = b.lines[l - 1];
      if (!x) continue;
      shas.add(x.sha);
      const t = b.meta.get(x.sha).authorTime;
      if (t < oldestT) { oldestT = t; oldest = x.sha; }
    }
    s.bodyShas = [...shas];
    s.oldest = oldest;
    s.length = end - s.line + 1;
    const c = commits.get(s.intro);
    s.flags = [];
    if (title.filename !== s.file) s.flags.push('moved');
    if (oldest !== s.intro) s.flags.push('title-newer');
    if (!c) s.flags.push('not-in-log');
    else {
      if (firstOf.get(s.file) === s.intro && title.filename === s.file && c.testDeletes.some((d) => d.path !== s.file && d.del >= s.length)) s.flags.push('possible-move');
      c.sites++;
    }
    if (b.meta.get(s.intro).boundary) s.flags.push('boundary');
    s.ambiguous = s.flags.some((f) => f === 'title-newer' || f === 'possible-move' || f === 'not-in-log');
  }
  timing.blameParseMs = Math.round(performance.now() - t0);
  timing.blameFiles = [...blames.values()].filter(Boolean).length;
  timing.blameLines = blameLines;
  return { log, commits, sites, root, firstOf, blames, missingBlame };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const out = {};
  for (const suite of Object.keys(SUITES)) {
    const timing = {};
    const t0 = performance.now();
    const { log, commits, sites, root, missingBlame } = buildSuite(suite, timing);
    timing.totalMs = Math.round(performance.now() - t0);
    const mapped = sites.filter((s) => s.intro);
    const count = (f) => mapped.filter((s) => s.flags.includes(f)).length;
    const introCommits = new Set(mapped.map((s) => s.intro));
    const rootSites = mapped.filter((s) => root.includes(s.intro)).length;
    out[suite] = {
      commits: log.length, merges: log.filter(isMerge).length, rootCommits: root.length,
      sites: sites.length, mapped: mapped.length, missingBlame,
      flags: { moved: count('moved'), 'title-newer': count('title-newer'), 'possible-move': count('possible-move'), 'not-in-log': count('not-in-log'), boundary: count('boundary') },
      ambiguous: mapped.filter((s) => s.ambiguous).length,
      introCommits: introCommits.size, sitesFromRootCommit: rootSites,
      timing,
    };
  }
  writeFileSync(join(HERE, 'results/mapping.json'), JSON.stringify(out, null, 1));
  console.log(JSON.stringify(out, null, 1));
}
