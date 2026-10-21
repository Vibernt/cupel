/**
 * Textual mutation over lexer tokens (spike S3, decision D6). Zero dependencies, deterministic: the same source, the
 * same operators and the same seed give the same mutants in the same order, with the same ids.
 *
 * Operators (plans/ARCHITECTURE.md "Mutation"):
 *   cmp-flip      === <-> !==, == <-> !=, < -> >=, >= -> <, > -> <=, <= -> >
 *   boundary      < <-> <=, > <-> >=
 *   bool-literal  true <-> false
 *   logical       && <-> ||
 *   negate-cond   if (c) / while (c)  ->  if (!(c))
 *   remove-not    !x -> x
 *   arith         + <-> -, * <-> /, % -> *, += <-> -=, ++ <-> --   (not a `+` next to a string or template literal)
 *   return-value  return e -> return undefined   (return true <-> return false; bare return, null, undefined skipped)
 *   remove-call   a statement that is only a call, `[await] f(...);`  ->  `;`
 *
 * A cheap filter marks mutants that are meaningless by construction (inside a console.* call, or removing one) as
 * `filtered: 'logging'`. Duplicate mutants (two edits giving the same text, like either `!` of `!!x`) are dropped.
 *
 * Usage as a library: generateMutants(file, source) -> mutants; applyMutant(source, mutant) -> text;
 *                     sample(list, cap, seed) -> deterministic subset; validate(text) -> null | error message
 *                     (validate needs `node --experimental-vm-modules`).
 * Usage as a CLI:     node --experimental-vm-modules plans/spikes/s3/mutate.mjs <file.mjs> [--show]
 *                     prints the counts per operator, validity and the filter; --show prints every mutant.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { tokenize, matchBrackets, regexAllowed } from './lexer.mjs';

export const OPERATORS = ['cmp-flip', 'boundary', 'bool-literal', 'logical', 'negate-cond', 'remove-not', 'arith', 'return-value', 'remove-call'];

const CMP_FLIP = { '===': '!==', '!==': '===', '==': '!=', '!=': '==', '<': '>=', '>=': '<', '>': '<=', '<=': '>' };
const BOUNDARY = { '<': '<=', '<=': '<', '>': '>=', '>=': '>' };
const ARITH = { '+': '-', '-': '+', '*': '/', '/': '*', '%': '*', '+=': '-=', '-=': '+=', '++': '--', '--': '++' };
const RESERVED = new Set(['if', 'else', 'for', 'while', 'do', 'return', 'throw', 'const', 'let', 'var', 'function', 'class', 'new', 'delete', 'typeof', 'void', 'switch', 'case', 'default', 'break', 'continue', 'try', 'catch', 'finally', 'import', 'export', 'yield', 'in', 'of', 'instanceof', 'async']);

/** mulberry32: a tiny seeded PRNG (deterministic sampling). */
export function prng(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

export function applyMutant(source, mutant) {
    let out = source;
    for (const e of [...mutant.edits].sort((a, b) => b.start - a.start))
        out = out.slice(0, e.start) + e.text + out.slice(e.end);
    return out;
}

/** Ranges [start, end) of every `console.<name>(...)` call: mutants inside them only change log lines. */
function loggingRanges(tokens, pairs) {
    const ranges = [];
    for (let k = 0; k + 3 < tokens.length; k++) {
        const t = tokens[k];
        if (t.type === 'name' && t.value === 'console' && tokens[k + 1].value === '.' && tokens[k + 2].type === 'name' && tokens[k + 3].value === '(' && tokens[k - 1]?.value !== '.') {
            const close = pairs.get(k + 3);
            if (close !== undefined)
                ranges.push([t.start, tokens[close].end]);
        }
    }
    return ranges;
}

/** Index of the token that ends the statement or expression starting at `from`: a `;` or an unmatched `)`, `]`, `}` at depth 0. */
function expressionEnd(tokens, pairs, from) {
    for (let k = from; k < tokens.length; k++) {
        const t = tokens[k];
        if (t.type === 'punct' && (t.value === '(' || t.value === '[' || t.value === '{') && pairs.has(k)) {
            k = pairs.get(k);
            continue;
        }
        if (t.type === 'template' && t.value.endsWith('${') && pairs.has(k)) {
            // jump over the whole template (to its last piece)
            let j = pairs.get(k);
            while (tokens[j].value.endsWith('${') && pairs.has(j) && pairs.get(j) > j)
                j = pairs.get(j);
            k = j;
            continue;
        }
        if (t.type === 'punct' && (t.value === ';' || t.value === ')' || t.value === ']' || t.value === '}' || t.value === ','))
            return k;
    }
    return tokens.length;
}

/** Whether token k can begin a statement: after `;`, `{`, `}`, `else`, `do`, a control header `)`, or at the start. */
function statementStart(tokens, pairs, k) {
    const p = tokens[k - 1];
    if (!p)
        return true;
    if (p.type === 'punct' && (p.value === ';' || p.value === '{' || p.value === '}'))
        return true;
    if (p.type === 'name' && (p.value === 'else' || p.value === 'do'))
        return true;
    if (p.type === 'punct' && p.value === ')') {
        const open = pairs.get(k - 1);
        const before = tokens[open - 1];
        return before?.type === 'name' && ['if', 'for', 'while'].includes(before.value);
    }
    return false;
}

/**
 * Every mutant of one file, in source order. Each: { id, file, op, line, col, start, original, replacement, edits,
 * filtered }. `id` is stable for the same source: file:line:col:op:replacement.
 */
export function generateMutants(file, source) {
    const tokens = tokenize(source);
    const pairs = matchBrackets(tokens);
    const logging = loggingRanges(tokens, pairs);
    const inLogging = pos => logging.some(([s, e]) => pos >= s && pos < e);
    const out = [];
    const seen = new Set();
    const add = (op, tok, replacement, edits, extra = {}) => {
        const text = applyMutant(source, { edits });
        const hash = createHash('sha1').update(text).digest('hex');
        if (seen.has(hash))
            return;
        seen.add(hash);
        out.push({
            id: `${file}:${tok.line}:${tok.col + 1}:${op}:${replacement}`,
            file, op, line: tok.line, col: tok.col + 1, start: tok.start,
            original: tok.value, replacement, edits,
            filtered: inLogging(tok.start) ? 'logging' : null,
            ...extra
        });
    };
    for (let k = 0; k < tokens.length; k++) {
        const t = tokens[k], prev = tokens[k - 1], next = tokens[k + 1];
        if (t.type === 'punct') {
            const v = t.value;
            if (CMP_FLIP[v])
                add('cmp-flip', t, CMP_FLIP[v], [{ start: t.start, end: t.end, text: CMP_FLIP[v] }]);
            if (BOUNDARY[v])
                add('boundary', t, BOUNDARY[v], [{ start: t.start, end: t.end, text: BOUNDARY[v] }]);
            if (v === '&&' || v === '||') {
                const r = v === '&&' ? '||' : '&&';
                add('logical', t, r, [{ start: t.start, end: t.end, text: r }]);
            }
            // `*` of `import * as`, `export *`, `function*`, `yield*` is syntax, not multiplication.
            const starSyntax = v === '*' && (regexAllowed(prev) || (prev?.type === 'name' && ['import', 'export', 'function', 'yield', 'async'].includes(prev.value)));
            if (ARITH[v] && !starSyntax) {
                const nearString = [prev, next].some(x => x && (x.type === 'string' || x.type === 'template'));
                if (!(v === '+' && nearString) && !(v === '+=' && next?.type === 'string' || v === '+=' && next?.type === 'template')) {
                    const unary = (v === '+' || v === '-') && regexAllowed(prev);
                    // A space keeps `a - -b` from becoming `a --b` and `+ +` from becoming `++`.
                    const r = ARITH[v];
                    const text = (unary && (prev?.value === '+' || prev?.value === '-')) ? ` ${r}` : r;
                    add('arith', t, r, [{ start: t.start, end: t.end, text }], unary ? { unary: true } : {});
                }
            }
            if (v === '!')
                add('remove-not', t, '', [{ start: t.start, end: t.end, text: '' }]);
            continue;
        }
        if (t.type !== 'name' || prev?.value === '.' || prev?.value === '?.')
            continue;
        if (t.value === 'true' || t.value === 'false') {
            const isKey = next?.value === ':' && (prev?.value === '{' || prev?.value === ',');
            if (!isKey) {
                const r = t.value === 'true' ? 'false' : 'true';
                add('bool-literal', t, r, [{ start: t.start, end: t.end, text: r }]);
            }
        }
        else if ((t.value === 'if' || t.value === 'while') && next?.value === '(' && pairs.has(k + 1)) {
            const close = pairs.get(k + 1);
            add('negate-cond', t, `${t.value} (!(…))`, [{ start: next.end, end: next.end, text: '!(' }, { start: tokens[close].start, end: tokens[close].start, text: ')' }]);
        }
        else if (t.value === 'return') {
            if (!next || next.value === ';' || next.value === '}' || next.line !== t.line)
                continue;
            const end = expressionEnd(tokens, pairs, k + 1);
            if (end <= k + 1)
                continue;
            const exprStart = next.start, exprEnd = tokens[end - 1].end;
            const single = end === k + 2 ? next.value : null;
            if (single === 'null' || single === 'undefined')
                continue;
            const r = single === 'true' ? 'false' : single === 'false' ? 'true' : 'undefined';
            add('return-value', t, `return ${r}`, [{ start: exprStart, end: exprEnd, text: r }]);
        }
        else if (!RESERVED.has(t.value) && statementStart(tokens, pairs, k)) {
            // `[await] callee(...)...(...);` and nothing else in the statement.
            let j = k;
            if (t.value === 'await')
                j++;
            if (tokens[j]?.type !== 'name' || RESERVED.has(tokens[j].value))
                continue;
            let sawCall = false, ok = true, last = j;
            j++;
            while (j < tokens.length) {
                const u = tokens[j];
                if (u.value === ';' || u.value === '}')
                    break;
                if ((u.value === '.' || u.value === '?.') && tokens[j + 1]?.type === 'name') {
                    last = j + 1;
                    j += 2;
                    continue;
                }
                if ((u.value === '(' || u.value === '[') && pairs.has(j)) {
                    sawCall = sawCall || u.value === '(';
                    last = pairs.get(j);
                    j = last + 1;
                    continue;
                }
                ok = false;
                break;
            }
            const endTok = tokens[j];
            if (!ok || !sawCall || tokens[last].value !== ')' || !endTok || endTok.value !== ';')
                continue;
            const c0 = t.value === 'await' ? k + 1 : k;
            let p = c0;
            while (tokens[p].value !== '(' && tokens[p].value !== '[')
                p++;
            const callee = source.slice(tokens[c0].start, tokens[p].start).replace(/\s+/g, '').slice(0, 40);
            const isLog = tokens[t.value === 'await' ? k + 1 : k].value === 'console';
            const m = { start: t.start, end: endTok.end, text: ';' };
            const before = out.length;
            add('remove-call', t, `remove ${callee}…`, [m]);
            if (isLog && out.length > before)
                out[out.length - 1].filtered = 'logging';
        }
    }
    return out;
}

/** A deterministic subset of `cap` items (Fisher-Yates with the seed), returned in the input order. */
export function sample(list, cap, seed) {
    if (list.length <= cap)
        return [...list];
    const idx = list.map((_, k) => k);
    const rand = prng(seed);
    for (let k = idx.length - 1; k > 0; k--) {
        const j = Math.floor(rand() * (k + 1));
        [idx[k], idx[j]] = [idx[j], idx[k]];
    }
    return idx.slice(0, cap).sort((a, b) => a - b).map(k => list[k]);
}

let vmModule = null;
/** null when the mutated module text parses as an ES module, else the SyntaxError message. Needs --experimental-vm-modules. */
export async function validate(text) {
    vmModule ||= await import('node:vm');
    if (typeof vmModule.SourceTextModule !== 'function')
        throw new Error('validate() needs node --experimental-vm-modules');
    try {
        new vmModule.SourceTextModule(text);
        return null;
    }
    catch (error) {
        return `${error.name}: ${error.message}`;
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const file = process.argv[2];
    const source = readFileSync(file, 'utf8');
    const mutants = generateMutants(file, source);
    const counts = {};
    let invalid = 0, filtered = 0;
    for (const m of mutants) {
        const err = await validate(applyMutant(source, m));
        m.invalid = err;
        counts[m.op] ||= { generated: 0, invalid: 0, filtered: 0 };
        counts[m.op].generated++;
        if (err) {
            counts[m.op].invalid++;
            invalid++;
        }
        if (m.filtered) {
            counts[m.op].filtered++;
            filtered++;
        }
        if (process.argv.includes('--show'))
            console.log(`${m.line}:${m.col}\t${m.op}\t${JSON.stringify(m.original)} -> ${JSON.stringify(m.replacement)}${m.filtered ? `\t[${m.filtered}]` : ''}${err ? `\tINVALID ${err}` : ''}`);
    }
    console.log(JSON.stringify({ file, mutants: mutants.length, invalid, filtered, counts }, null, 1));
}
