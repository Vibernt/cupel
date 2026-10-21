// S9: shared helpers. Parse the exported git history and blame, classify commits and paths, load S6's data,
// and a two-sided Fisher exact test. Node ESM, standard library only; no git, no network.

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export const SCRATCH = process.env.CUPEL_SCRATCH ?? '/Users/vid/cupel/.scratch';
export const S9 = join(SCRATCH, 'out-s9');
export const S6OUT = join(SCRATCH, 'out-s6');
export const SUITES = {
  assay: { history: 'history-assay.log', head: 'head-assay.txt', blame: 'blame-assay', s6: 'assay', tree: 'assay-base' },
  cc: { history: 'history-cc.log', head: 'head-cc.txt', blame: 'blame-cc', s6: 'cc', tree: 'cc-s6' },
};

export function args(argv, defaults = {}) {
  const o = { ...defaults };
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const k = argv[i].slice(2);
    if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) o[k] = argv[++i]; else o[k] = true;
  }
  return o;
}

// ---------------------------------------------------------------- history

/**
 * Parse `git log --no-renames --numstat` in the export's block format:
 * commit <sha> / parents ... / author ... / date <unix> / subject ... / body / ... / endbody / numstat lines.
 * Returns commits newest first: { sha, parents, author, date, subject, body, files: [{ add, del, path }] }.
 */
export function parseHistory(path) {
  const lines = readFileSync(path, 'utf8').split('\n');
  const commits = [];
  let c = null, inBody = false;
  for (const line of lines) {
    if (inBody) {
      if (line === 'endbody') { inBody = false; c.body = c.bodyLines.join('\n').trim(); delete c.bodyLines; continue; }
      c.bodyLines.push(line);
      continue;
    }
    const m = /^commit ([0-9a-f]{40})$/.exec(line);
    if (m) { c = { sha: m[1], parents: [], author: '', date: 0, subject: '', body: '', files: [] }; commits.push(c); continue; }
    if (!c) continue;
    if (line.startsWith('parents')) { c.parents = line.slice(7).trim().split(/\s+/).filter(Boolean); continue; }
    if (line.startsWith('author ')) { c.author = line.slice(7); continue; }
    if (line.startsWith('date ')) { c.date = Number(line.slice(5)); continue; }
    if (line.startsWith('subject ')) { c.subject = line.slice(8); continue; }
    if (line === 'subject') { c.subject = ''; continue; }
    if (line === 'body') { inBody = true; c.bodyLines = []; continue; }
    const n = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
    if (n) c.files.push({ add: n[1] === '-' ? null : Number(n[1]), del: n[2] === '-' ? null : Number(n[2]), path: n[3] });
  }
  return commits;
}

// ---------------------------------------------------------------- blame

/** Blame file name for a repository path (the export replaced `/` with `_`). */
export const blameName = (path) => `${path.replaceAll('/', '_')}.porcelain`;

/**
 * Parse `git blame --line-porcelain`. Returns { lines: [ { sha, origLine, filename } ] (index 0 = line 1), meta: Map sha ->
 * { authorTime, summary, filename, boundary } }.
 */
export function parseBlame(path) {
  const text = readFileSync(path, 'utf8').split('\n');
  const lines = [];
  const meta = new Map();
  let cur = null;
  for (const line of text) {
    if (line.startsWith('\t')) { lines[cur.final - 1] = { sha: cur.sha, origLine: cur.orig, filename: cur.filename }; cur = null; continue; }
    const h = /^([0-9a-f]{40}) (\d+) (\d+)(?: \d+)?$/.exec(line);
    if (h) { cur = { sha: h[1], orig: Number(h[2]), final: Number(h[3]), filename: null }; if (!meta.has(h[1])) meta.set(h[1], { authorTime: 0, summary: '', filename: null, boundary: false }); continue; }
    if (!cur) continue;
    const m = meta.get(cur.sha);
    if (line.startsWith('author-time ')) m.authorTime = Number(line.slice(12));
    else if (line.startsWith('summary ')) m.summary = line.slice(8);
    else if (line === 'boundary') m.boundary = true;
    else if (line.startsWith('filename ')) { cur.filename = line.slice(9); if (!m.filename) m.filename = cur.filename; }
  }
  return { lines, meta };
}

export function listBlameFiles(suite) {
  return readdirSync(join(S9, SUITES[suite].blame)).filter((f) => f.endsWith('.porcelain')).sort();
}

// ---------------------------------------------------------------- commit classification

/**
 * Fix commit: the subject or body names a fix, bug, regression, revert, hotfix, a crash or a flake, a fault tag, or an
 * issue reference closed by the commit. Words are matched whole and case-insensitively. `subjectOnly` is the stricter
 * variant compared in S9.md.
 */
export const FIX_RE = /\b(?:fix(?:e[sd]|ing|up)?|bug(?:s|fix(?:es)?)?|regress(?:ion|ions|ed|es)?|revert(?:s|ed)?|hotfix(?:es)?|crash(?:es|ed)?|flak(?:e|es|ed|y|iness))\b|\[fault:|\b(?:close[sd]?|resolve[sd]?)\s+#\d+|\bGH-\d+\b/i;
export const isFix = (c, { subjectOnly = false } = {}) => FIX_RE.test(c.subject) || (!subjectOnly && FIX_RE.test(c.body));

/** Agent trailers: Co-Authored-By (any case) naming a coding agent. */
export const AGENT_RE = /^co-authored-by:.*\b(claude|anthropic|codex|openai|cursor|copilot|devin|aider|gemini|jules|windsurf|cline|amp|sweep|codegen|chatgpt|gpt-?\d)/im;
export const agentOf = (c) => {
  const m = AGENT_RE.exec(c.body);
  return m ? m[1].toLowerCase() : null;
};
export const isMerge = (c) => c.parents.length > 1;

/** Squash-merge look: GitHub's "(#123)" subject suffix, or a body listing two or more "* " commit subjects. */
export function looksSquashed(c) {
  if (isMerge(c)) return false;
  const pr = /\(#\d+\)\s*$/.test(c.subject);
  const bullets = (c.body.match(/^\* \S/gm) ?? []).length;
  const coauthors = new Set((c.body.match(/^co-authored-by:.*$/gim) ?? []).map((s) => s.toLowerCase())).size;
  return { pr, bullets, coauthors, squashed: pr || bullets >= 2 };
}

// ---------------------------------------------------------------- path classification (H3)

const TEST_RE = /(^|\/)(tests?|__tests__|spec)\/|(\.test|\.spec)\.[cm]?[jt]sx?$|(^|\/)test_[^/]*\.py$|_test\.(py|go)$/;
const DOC_RE = /\.(md|mdx|txt|rst|adoc)$|(^|\/)(docs?|changes|changelog)\/|(^|\/)(README|CHANGELOG|SECURITY|CONTRIBUTING|LICENSE|NOTICE)[^/]*$/i;
const STYLE_RE = /\.(css|scss|sass|less)$/i;
const MARKUP_RE = /\.(html|htm|svg)$/i;
const CODE_RE = /\.([cm]?[jt]sx?|py|rs|go|java|kt|cs|rb|php|c|cc|cpp|h|hpp|sh|sql|swift)$/i;
/** UI code: console pages and web front ends, where copy and layout live beside logic. */
const UI_RE = /^(public|web)\//;

/** 'test' | 'doc' | 'style' | 'markup' | 'ui' | 'logic' | 'data' */
export function pathClass(p) {
  if (TEST_RE.test(p)) return 'test';
  if (DOC_RE.test(p)) return 'doc';
  if (STYLE_RE.test(p)) return 'style';
  if (MARKUP_RE.test(p)) return 'markup';
  if (CODE_RE.test(p)) return UI_RE.test(p) ? 'ui' : 'logic';
  return 'data';
}

/**
 * Kind of a commit by its non-test files:
 * - 'logic': touches a logic file;
 * - 'presentation': touches only doc, style or markup files (strict copy/CSS/doc change);
 * - 'ui': no logic file, at least one UI code file (copy and layout in console pages);
 * - 'test-only': only test files (and data);
 * - 'data': only data or config files besides tests.
 */
export function commitKind(c) {
  const k = new Set(c.files.map((f) => pathClass(f.path)));
  if (k.has('logic')) return 'logic';
  if (k.has('ui')) return 'ui';
  if (k.has('doc') || k.has('style') || k.has('markup')) return 'presentation';
  if (k.has('data')) return 'data';
  return 'test-only';
}

// ---------------------------------------------------------------- S6 data

export const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

/** The S6 test definitions (sites) at HEAD: file, name, line, endLine, shape, flags, from the strict detector. */
export function loadSites(suite) {
  const b = readJson(join(S6OUT, SUITES[suite].s6, 'brittle-strict.json'));
  const sites = new Map();
  for (const t of b.tests) {
    const key = `${t.file}:${t.line}`;
    if (!sites.has(key)) sites.set(key, { site: key, file: t.file, line: t.line, endLine: t.endLine ?? t.line, name: t.name, shape: t.shape ?? '', flags: t.flags ?? [] });
  }
  return sites;
}

/**
 * S6 tests (ids, status, site) and reports v0 and v1. Returns { tests, siteOfTest, v0, v1, siteOfUnit }.
 * v1 units are either a test id or `file:line (N rows of name)`.
 */
export function loadS6(suite) {
  const dir = join(S6OUT, SUITES[suite].s6);
  const input = readJson(join(dir, 'input-v1.json'));
  const siteOfTest = new Map();
  for (const t of input.tests) siteOfTest.set(t.id, t.site);
  const tests = input.tests.map((t) => ({ id: t.id, file: t.file, name: t.name, status: t.status, site: t.site }));
  const v0 = readJson(join(dir, 'report-v0.json'));
  const v1 = readJson(join(dir, 'report-v1.json'));
  const siteOfUnit = (id) => {
    if (siteOfTest.has(id)) return siteOfTest.get(id);
    const m = /^(.*):(\d+) \(\d+ rows of /.exec(id);
    return m ? `${m[1]}:${m[2]}` : null;
  };
  return { tests, siteOfTest, v0, v1, siteOfUnit };
}

// ---------------------------------------------------------------- statistics

const lf = (() => { const a = [0]; return (n) => { while (a.length <= n) a.push(a[a.length - 1] + Math.log(a.length)); return a[n]; }; })();
/** Two-sided Fisher exact p for [[a, b], [c, d]] (sum of tables at most as likely as the observed). */
export function fisher(a, b, c, d) {
  const r1 = a + b, r2 = c + d, c1 = a + c, n = r1 + r2;
  const p = (x) => Math.exp(lf(r1) + lf(r2) + lf(c1) + lf(n - c1) - lf(n) - lf(x) - lf(r1 - x) - lf(c1 - x) - lf(r2 - c1 + x));
  const lo = Math.max(0, c1 - r2), hi = Math.min(r1, c1);
  const p0 = p(a);
  let s = 0;
  for (let x = lo; x <= hi; x++) { const px = p(x); if (px <= p0 * (1 + 1e-7)) s += px; }
  return Math.min(1, s);
}
/** One-sided binomial P(X >= k) for n trials at rate q (k hits observed against a base rate). */
export function binomUpper(k, n, q) {
  let s = 0;
  for (let x = k; x <= n; x++) s += Math.exp(lf(n) - lf(x) - lf(n - x) + x * Math.log(q) + (n - x) * Math.log(1 - q));
  return Math.min(1, s);
}
export const pct = (a, b) => (b ? `${((100 * a) / b).toFixed(1)} %` : 'n/a');
export const rate = (a, b) => (b ? Math.round((1000 * a) / b) / 1000 : null);

export function mulberry32(a) { return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
export function shuffle(xs, seed) { const rand = mulberry32(seed); const a = [...xs]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

/** Masked-body shingles (k = 4), as S6's engine. */
export function shingles(shape, k = 4) {
  const t = (shape ?? '').split(' ').filter(Boolean);
  const out = new Set();
  for (let i = 0; i + k <= t.length; i++) out.add(t.slice(i, i + k).join(' '));
  if (!out.size && t.length) out.add(t.join(' '));
  return out;
}
export function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}
