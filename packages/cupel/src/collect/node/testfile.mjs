// Static analysis of a node:test file: test definitions, their body shapes (K12) and brittle pins (S6).
//
// Definitions are the calls `test(…)`, `it(…)`, `x.test(…)` (subtests) and `test.only|skip|todo(…)`. Each is
// located by the line and column of its callee name, which is where node:test reports a test's location, so
// the collector joins definitions to executed tests by location and never by name.
//
// Shapes (K12): the definition's body is every token of the call after its first argument (the name): the
// options and the callback. Strings and template pieces become `S`, numbers `N` and regular expressions `R`;
// consecutive 4-token shingles are joined by single spaces and hashed with 32-bit FNV-1a over their UTF-8
// bytes. The shape is the sorted set of distinct hashes.
//
// Brittleness: the strict detector of spike S6 (plans/spikes/s6/detect-js.mjs --strict), with the fixes S6.md
// lists for the next round:
//  - a read counts only when its path is anchored on the repository: import.meta, __dirname, __filename,
//    process.cwd(), a module-level constant built from one of those, or a path made of literals only (relative
//    to the working directory, which is the repository root). Reads under a temporary directory, a fixture
//    directory or any other variable never count;
//  - a read wrapped in a parse*/load* call (JSON.parse, yaml.load, parseConfig, …) is data, not text;
//  - snapshot APIs count only as member calls (t.assert.snapshot, expect(x).toMatchSnapshot), never a local
//    function named snapshot;
//  - no second-order taint through object literals.
// The rest is S6's strict rules: module-level taint only, fixture paths are input unless they name an
// expected/golden/snapshot file, file-snapshot needs the read as a direct argument of an equality assertion,
// source-text and doc-wording need an assertion with a literal, css strings count only inside assertions.

import { tokenize, matchBrackets } from '../../lang/js/lexer.mjs';

const KIND_OF_PATH = (text) => {
  if (/\.json\b/.test(text)) return null;
  if (/fixture/i.test(text)) return /expected|golden|snap/i.test(text) ? 'golden' : 'fixture';
  if (/\.css\b/.test(text)) return 'css-class';
  if (/\.(md|txt)\b|docs\/|README|CHANGELOG|GUIDE/.test(text)) return 'doc-wording';
  if (/\.(mjs|cjs|js|ts|tsx|jsx|html|py|sh|ya?ml|toml)\b|(^|[^\w])(src|public|scripts|actions|sdk|cli|router|runner|daemon|docker|infra)\//.test(text)) return 'source-text';
  return 'unknown';
};
const READERS = new Set(['readFileSync', 'readFile']);
const TEXT_ASSERT = /^(match|doesNotMatch|includes|test|indexOf|startsWith|endsWith|equal|strictEqual|notEqual|ok)$/;
const EQ_ASSERT = /^(equal|strictEqual|deepEqual|deepStrictEqual)$/;
const SNAPSHOT_API = /^(snapshot|toMatchSnapshot|fileSnapshot|toMatchFileSnapshot)$/;
const DATA_WRAPPER = /^(parse|load|safeLoad)/i;
const PATH_BUILDERS = new Set(['path', 'posix', 'win32', 'join', 'resolve', 'normalize', 'URL', 'new', 'fileURLToPath', 'pathToFileURL', 'String', 'await']);
const TEST_CALLEES = new Set(['test', 'it']);
const MODIFIERS = new Set(['only', 'skip', 'todo']);
const DECLARE = new Set(['const', 'let', 'var']);

/** 32-bit FNV-1a over the UTF-8 bytes of a string. */
export function fnv1a(text) {
  let h = 0x811c9dc5;
  for (const b of Buffer.from(text, 'utf8')) {
    h ^= b;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** The K12 shape of a list of tokens: the sorted distinct FNV-1a hashes of its masked 4-token shingles. */
export function shapeOf(tokens) {
  const masked = tokens.map((t) => (t.type === 'string' || t.type === 'template' ? 'S' : t.type === 'num' ? 'N' : t.type === 'regex' ? 'R' : t.value));
  const hashes = new Set();
  for (let i = 0; i + 4 <= masked.length; i++) hashes.add(fnv1a(masked.slice(i, i + 4).join(' ')));
  return [...hashes].sort((a, b) => a - b);
}

/**
 * Analyses one test file. Returns [{ line, column, start, end, flags: [{ kind, line }], shape }], one per
 * definition; `line` and `column` (1-based) locate the callee name, `start` and `end` are source offsets.
 * Throws the lexer's LexError when the file cannot be tokenised.
 */
export function analyseTestFile(src) {
  const toks = tokenize(src);
  const pairs = matchBrackets(toks);
  const N = toks.length;
  const v = (k) => toks[k]?.value;
  const depthAt = new Int32Array(N);
  for (let k = 0, d = 0; k < N; k++) {
    if (toks[k].type === 'punct' && toks[k].value === '}') d = Math.max(0, d - 1);
    depthAt[k] = d;
    if (toks[k].type === 'punct' && toks[k].value === '{') d++;
  }
  const skipPair = (q) => (pairs.has(q) && pairs.get(q) > q ? pairs.get(q) : q);

  // Test definitions.
  const defs = [];
  const inTest = new Uint8Array(N);
  for (let k = 0; k < N; k++) {
    const t = toks[k];
    if (t.type !== 'name') continue;
    const prev = v(k - 1);
    const isTest = (TEST_CALLEES.has(t.value) && (prev !== '.' || toks[k - 2]?.type === 'name') && prev !== 'function') ||
      (MODIFIERS.has(t.value) && prev === '.' && TEST_CALLEES.has(v(k - 2)));
    if (!isTest) continue;
    let open = k + 1;
    if (v(k + 1) === '.' && v(k + 2) === 'each' && v(k + 3) === '(' && pairs.has(k + 3)) {
      open = pairs.get(k + 3) + 1;
    }
    if (v(open) !== '(' || !pairs.has(open)) continue;
    const close = pairs.get(open);
    if (v(close + 1) === '{') continue; // a method definition named test
    defs.push({ k, open, close });
    for (let q = k; q <= close; q++) inTest[q] = 1;
  }

  // Assertion calls: assert(…) and assert.x(…).
  const inAssert = new Uint8Array(N);
  for (let k = 0; k < N; k++) {
    if (toks[k].type !== 'name' || toks[k].value !== 'assert') continue;
    const open = v(k + 1) === '(' ? k + 1 : (v(k + 1) === '.' && v(k + 3) === '(' ? k + 3 : -1);
    if (open > 0 && pairs.has(open)) for (let q = open + 1; q < pairs.get(open); q++) inAssert[q] = 1;
  }

  // End of the statement that starts its initializer at `from` (a `;` or the next top-level declaration).
  const statementEnd = (from) => {
    let q = from;
    while (q < N && v(q) !== ';' && !(q > from && depthAt[q] === 0 && toks[q].type === 'name' && (DECLARE.has(v(q)) || v(q) === 'function' || v(q) === 'import' || v(q) === 'export'))) {
      const s = skipPair(q);
      q = s === q ? q + 1 : s + 1;
    }
    return Math.min(q, N) - 1;
  };
  const text = (a, b) => (a <= b ? src.slice(toks[a].start, toks[b].end) : '');

  // Module-level constants anchored on the repository (fix 1).
  const rootNames = new Map(); // name -> initializer text
  const hasAnchor = (a, b) => {
    for (let q = a; q <= b; q++) {
      const t = toks[q];
      if (t.type !== 'name' || v(q - 1) === '.') continue;
      if (t.value === 'import' && v(q + 1) === '.' && v(q + 2) === 'meta') return true;
      if (t.value === '__dirname' || t.value === '__filename') return true;
      if (t.value === 'process' && v(q + 1) === '.' && v(q + 2) === 'cwd') return true;
      if (rootNames.has(t.value) && v(q + 1) !== ':') return true;
    }
    return false;
  };
  for (let pass = 0; pass < 2; pass++) {
    for (let k = 0; k < N; k++) {
      if (depthAt[k] || inTest[k] || !DECLARE.has(v(k)) || toks[k + 1]?.type !== 'name' || v(k + 2) !== '=') continue;
      const end = statementEnd(k + 3);
      if (!rootNames.has(v(k + 1)) && hasAnchor(k + 3, end)) rootNames.set(v(k + 1), text(k + 3, end));
    }
  }
  /** Whether a path argument (tokens a..b) is anchored on the repository, and the text that names it. */
  const pathInfo = (a, b) => {
    let named = text(a, b);
    let unknown = false, literal = false;
    for (let q = a; q <= b; q++) {
      const t = toks[q];
      if (t.type === 'string' || (t.type === 'template' && !t.value.endsWith('${'))) literal = true;
      if (t.type !== 'name' || v(q - 1) === '.' || v(q + 1) === ':') continue;
      if (rootNames.has(t.value)) named += ` ${rootNames.get(t.value)}`;
      else if (!PATH_BUILDERS.has(t.value) && t.value !== 'import' && t.value !== 'meta' && t.value !== '__dirname' &&
        t.value !== '__filename' && t.value !== 'process' && t.value !== 'utf8') unknown = true;
    }
    return { anchored: hasAnchor(a, b) || (literal && !unknown), named };
  };
  /** The first argument's token range of the call whose `(` is at `open`. */
  const firstArg = (open) => {
    const close = pairs.get(open);
    let q = open + 1;
    while (q < close && v(q) !== ',') q = skipPair(q) + 1;
    return [open + 1, Math.min(q, close) - 1];
  };
  const wrappedAsData = (k) => {
    let q = k - 1;
    if (v(q) === 'await') q--;
    return v(q) === '(' && toks[q - 1]?.type === 'name' && DATA_WRAPPER.test(v(q - 1));
  };

  // Helpers whose body reads a file: `const read = (p) => readFileSync(…)`, `function read(p) {…}`.
  const helpers = new Map(); // name -> { kind, anchored }
  const readAt = (k) => {
    const t = toks[k];
    if (t.type !== 'name' || v(k + 1) !== '(' || !pairs.has(k + 1)) return null;
    if (v(k - 1) === '.' && !READERS.has(t.value)) return null;
    if (!READERS.has(t.value) && !helpers.has(t.value)) return null;
    if (v(k - 1) === 'function') return null;
    const close = pairs.get(k + 1);
    const [a, b] = firstArg(k + 1);
    const info = pathInfo(a, b);
    let kind = KIND_OF_PATH(info.named);
    let anchored = info.anchored;
    if (!READERS.has(t.value)) {
      const h = helpers.get(t.value);
      if (kind === 'unknown' || kind === null) kind = h.kind;
      anchored = anchored || h.anchored;
    }
    if (wrappedAsData(k)) kind = null; // fix 2: parsed reads are data
    return { kind, anchored, end: close };
  };
  for (let pass = 0; pass < 2; pass++) {
    for (let k = 0; k < N; k++) {
      let name = null, bodyStart = null;
      if (DECLARE.has(v(k)) && toks[k + 1]?.type === 'name' && v(k + 2) === '=') {
        let j = k + 3;
        if (v(j) === 'async') j++;
        if (v(j) === '(' && pairs.has(j) && v(pairs.get(j) + 1) === '=>') { name = v(k + 1); bodyStart = pairs.get(j) + 2; }
        else if (toks[j]?.type === 'name' && v(j + 1) === '=>') { name = v(k + 1); bodyStart = j + 2; }
        else if (v(j) === 'function') { name = v(k + 1); bodyStart = j; }
      } else if (v(k) === 'function' && toks[k + 1]?.type === 'name') { name = v(k + 1); bodyStart = k + 2; }
      if (!name || depthAt[k] > 0) continue;
      let end = bodyStart;
      if (v(end) === '(' || v(end) === '{') end = pairs.get(end) ?? end;
      else if (v(end) === 'function') { let q = end; while (q < N && v(q) !== '{') q++; end = pairs.get(q) ?? q; }
      else { let q = end; while (q < N && v(q) !== ';' && v(q) !== ',') q = skipPair(q) + 1; end = q; }
      if (v(end + 1) === '.' || v(end + 1) === '(') { let q = end + 1; while (q < N && v(q) !== ';') q = skipPair(q) + 1; end = q; }
      if (v(bodyStart) === '(' && v(k) === 'function') {
        // function name(params) { body }: skip the parameter list to the body.
        const pc = pairs.get(bodyStart);
        if (v(pc + 1) === '{') end = pairs.get(pc + 1) ?? end;
      }
      for (let q = bodyStart; q <= end && q < N; q++) {
        const r = readAt(q);
        if (r && r.kind && r.kind !== 'fixture' && !helpers.has(name)) helpers.set(name, { kind: r.kind, anchored: r.anchored });
      }
    }
  }

  // Reads, anchored on the repository (fix 1). A helper passed by reference (`paths.map(read)`) reads too.
  const reads = new Map(); // token index -> { kind, end }
  for (let k = 0; k < N; k++) {
    const r = readAt(k);
    if (r) { if (r.anchored) reads.set(k, r); continue; }
    const t = toks[k];
    if (t.type === 'name' && helpers.has(t.value) && v(k - 1) !== '.' && (v(k + 1) === ')' || v(k + 1) === ',') && (v(k - 1) === '(' || v(k - 1) === ',')) {
      const h = helpers.get(t.value);
      if (h.anchored) reads.set(k, { kind: h.kind, end: k });
    }
  }

  // Module-level names that hold a read.
  const tainted = new Map(); // name -> kind
  for (const [k, r] of reads) {
    if (inTest[k] || !r.kind || r.kind === 'fixture' || depthAt[k] > 0) continue;
    let q = k - 1;
    while (q >= 0) {
      const val = v(q);
      if (pairs.has(q) && pairs.get(q) < q) { q = pairs.get(q) - 1; continue; }
      if (val === ';' || val === '}' || val === '{') break;
      if (toks[q].type === 'name' && DECLARE.has(val)) {
        let eq = q + 1;
        while (eq < N && v(eq) !== '=') eq++;
        for (let i = q + 1; i < eq; i++) if (toks[i].type === 'name' && v(i - 1) !== ':') tainted.set(toks[i].value, r.kind);
        break;
      }
      q--;
    }
  }
  // Second-order taint (`const lines = text.split('\n')`), never through an object literal (fix 4) or a parse.
  for (let k = 0; k < N; k++) {
    if (inTest[k] || depthAt[k] > 0) continue;
    if (!(DECLARE.has(v(k)) && toks[k + 1]?.type === 'name' && v(k + 2) === '=')) continue;
    let q = k + 3;
    let braces = 0;
    while (q < N && v(q) !== ';' && !(toks[q].type === 'name' && (DECLARE.has(v(q)) || v(q) === 'test'))) {
      if (v(q) === '{') braces++;
      else if (v(q) === '}') braces--;
      else if (braces === 0 && toks[q].type === 'name' && tainted.has(v(q)) && v(q - 1) !== '.' && !wrappedAsData(q)) {
        tainted.set(v(k + 1), tainted.get(v(q)));
        break;
      }
      q++;
    }
  }

  const lit = (q) => toks[q] && (toks[q].type === 'string' || toks[q].type === 'regex' || (toks[q].type === 'template' && v(q).startsWith('`') && v(q).endsWith('`') && v(q).length > 1));
  const okEqKind = (kd) => kd === 'source-text' || kd === 'doc-wording' || kd === 'css-class' || kd === 'golden';
  const out = [];
  for (const d of defs) {
    const flags = [];
    const has = (kind) => flags.some((f) => f.kind === kind);
    let textAssert = false;
    const sourceKinds = new Map(); // kind -> first line
    for (let k = d.k; k <= d.close; k++) {
      const t = toks[k];
      if (t.type === 'name' && v(k - 1) === '.' && TEXT_ASSERT.test(t.value) && v(k + 1) === '(') {
        const close = pairs.get(k + 1) ?? k + 1;
        if (t.value === 'match' || t.value === 'doesNotMatch') {
          for (let q = k + 2; q < close; q = skipPair(q) + 1) {
            if (v(q) === ',') { if (lit(q + 1) || v(q + 1) === 'new') textAssert = true; break; }
          }
        } else if (/^(includes|indexOf|startsWith|endsWith)$/.test(t.value)) { if (lit(k + 2)) textAssert = true; }
        else if (t.value === 'test' && toks[k - 2]?.type === 'regex') textAssert = true;
      }
      if (t.type === 'name' && tainted.has(t.value) && v(k - 1) !== '.' && v(k + 1) !== ':') {
        const kind = tainted.get(t.value);
        if (!sourceKinds.has(kind)) sourceKinds.set(kind, t.line);
      }
      const rd = reads.get(k);
      if (rd && rd.kind && rd.kind !== 'fixture' && !sourceKinds.has(rd.kind)) sourceKinds.set(rd.kind, t.line);
      if ((t.type === 'string' || t.type === 'template' || t.type === 'regex') && inAssert[k] &&
        (/class(Name)?\s*=|classList|class:\s*['"]|\bclass\\?=/.test(t.value) || (t.type === 'regex' && /\\\.[a-z][\w-]*(\\s\*)?\s*\\?\{/.test(t.value)))) {
        if (!has('css-class')) flags.push({ kind: 'css-class', line: t.line });
      }
      // fix 3: snapshot APIs only as member calls.
      if (t.type === 'name' && SNAPSHOT_API.test(t.value) && v(k + 1) === '(' && v(k - 1) === '.') {
        if (!has('file-snapshot')) flags.push({ kind: 'file-snapshot', line: t.line });
      }
      // An equality assertion with a whole-file read (or a name holding one) as a direct argument.
      if (t.type === 'name' && EQ_ASSERT.test(t.value) && v(k - 1) === '.' && v(k + 1) === '(' && pairs.has(k + 1)) {
        const close = pairs.get(k + 1);
        for (let q = k + 2; q < close; q++) {
          const rr = reads.get(q);
          const tv = toks[q].type === 'name' && tainted.has(v(q)) && v(q - 1) !== '.' && v(q + 1) !== '.' && v(q + 1) !== '[' && v(q + 1) !== '(';
          if ((rr && rr.kind !== null && okEqKind(rr.kind)) || (tv && okEqKind(tainted.get(v(q))))) {
            if (!has('file-snapshot')) flags.push({ kind: 'file-snapshot', line: t.line });
            break;
          }
          if (rr) q = rr.end;
          else if (toks[q].type === 'punct') q = skipPair(q);
        }
      }
    }
    if (textAssert) {
      for (const [kind, line] of sourceKinds) {
        if (kind === 'unknown' || kind === 'golden') continue;
        if (!has(kind)) flags.push({ kind, line });
      }
    }
    // The body: every token after the first argument.
    let bodyStart = d.close;
    for (let q = d.open + 1; q < d.close; q = skipPair(q) + 1) if (v(q) === ',') { bodyStart = q + 1; break; }
    out.push({
      line: toks[d.k].line,
      column: toks[d.k].col + 1,
      start: toks[d.k].start,
      end: toks[d.close].end,
      flags,
      shape: shapeOf(toks.slice(bodyStart, d.close)),
    });
  }
  return out;
}

/**
 * Findings from config `brittleness.patterns` (D13) for one definition: each pattern is a regular expression
 * matched against the definition's source text; a match gives one finding at the line of its first match.
 * Patterns with a `language` other than JavaScript are skipped.
 */
export function patternFindings(src, def, patterns) {
  const out = [];
  const body = src.slice(def.start, def.end);
  for (const p of patterns) {
    const m = p.re.exec(body);
    p.re.lastIndex = 0;
    if (!m) continue;
    let line = def.line;
    for (let i = 0; i < m.index; i++) if (body.charCodeAt(i) === 10) line++;
    out.push({ kind: p.kind, line, ...(p.deliberate ? { deliberate: true } : {}) });
  }
  return out;
}
