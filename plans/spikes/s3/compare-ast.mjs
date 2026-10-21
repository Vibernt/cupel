/**
 * D6 comparison (spike S3): what a real parser buys over the zero-dependency lexer.
 *
 * It needs acorn, but never installs it: pass the path of a copy that is already on the machine (read-only), for
 * example one nested under a globally installed tool. Nothing here is a dependency of Cupel.
 *
 *   node plans/spikes/s3/compare-ast.mjs --acorn <path to acorn/dist/acorn.mjs> --repo <suite root> \
 *        [--files a.mjs,b.mjs] [--all-src] [--out result.json]
 *
 * 1. Tokens: every name, number, string, regex and punctuator the lexer emits must be an acorn token with the same
 *    start and end, and the reverse (template pieces are compared by their code positions only). --all-src runs this
 *    over every .mjs/.js file under src/ and public/ for the lexer's error rate.
 * 2. Mutation sites (on --files): the same operators found from the AST, compared site by site with the lexer's
 *    (key: operator and offset). Sites only one side finds are listed with their line.
 */
import { readFileSync, readdirSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tokenize } from './lexer.mjs';
import { generateMutants } from './mutate.mjs';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
    const k = args.indexOf(`--${name}`);
    return k >= 0 ? args[k + 1] : fallback;
};
const acorn = await import(pathToFileURL(resolve(opt('acorn'))).href);
const REPO = resolve(opt('repo', '.'));
const PARSE = { ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true };

function walkFiles(dir, out = []) {
    for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        const st = statSync(p);
        if (st.isDirectory()) {
            if (name !== 'node_modules' && name !== 'generated')
                walkFiles(p, out);
        }
        else if (/\.m?js$/.test(name))
            out.push(p);
    }
    return out;
}

/** Token positions the lexer and acorn disagree on. */
function compareTokens(source) {
    let mine;
    const t0 = process.hrtime.bigint();
    try {
        mine = tokenize(source);
    }
    catch (error) {
        return { lexError: error.message };
    }
    const lexMs = Number(process.hrtime.bigint() - t0) / 1e6;
    const t1 = process.hrtime.bigint();
    let theirs;
    try {
        theirs = [...acorn.tokenizer(source, PARSE)];
    }
    catch (error) {
        return { acornError: error.message };
    }
    const acornMs = Number(process.hrtime.bigint() - t1) / 1e6;
    const t2 = process.hrtime.bigint();
    acorn.parse(source, PARSE);
    const parseMs = Number(process.hrtime.bigint() - t2) / 1e6;
    // Template pieces: the lexer emits one token per piece (with the backtick, `${` or `}`), acorn several. Keep
    // only tokens outside template text on both sides.
    const templateSpans = mine.filter(t => t.type === 'template').map(t => [t.start, t.end]);
    const inTemplate = (s, e) => templateSpans.some(([a, b]) => s >= a && e <= b);
    const key = t => `${t.start}:${t.end}`;
    const mineSet = new Map(mine.filter(t => t.type !== 'template').map(t => [key(t), t]));
    const theirSet = new Map(theirs.filter(t => !['template', '`', '${', 'invalidTemplate', 'eof'].includes(t.type.label) && !inTemplate(t.start, t.end)).map(t => [key(t), t]));
    const onlyMine = [...mineSet.keys()].filter(k => !theirSet.has(k)).map(k => mineSet.get(k));
    const onlyTheirs = [...theirSet.keys()].filter(k => !mineSet.has(k)).map(k => theirSet.get(k));
    return { tokens: mineSet.size, onlyMine, onlyTheirs, lexMs, acornMs, parseMs };
}

/** The same operators as mutate.mjs, from acorn's AST: [{ op, start, line }]. */
function astSites(source) {
    const tokens = [...acorn.tokenizer(source, { ...PARSE, locations: true })];
    const ast = acorn.parse(source, { ...PARSE, locations: true });
    const opToken = (from, to, value) => tokens.find(t => t.start >= from && t.end <= to && source.slice(t.start, t.end) === value);
    const sites = [];
    const add = (op, start, extra = '') => sites.push({ op, start, extra });
    const CMP = new Set(['===', '!==', '==', '!=', '<', '>', '<=', '>=']);
    const ARITH = new Set(['+', '-', '*', '/', '%']);
    const isStringy = n => (n.type === 'Literal' && typeof n.value === 'string') || n.type === 'TemplateLiteral';
    let insideConsole = 0;
    function visit(node, parent) {
        if (!node || typeof node.type !== 'string')
            return;
        const isConsole = node.type === 'CallExpression' && node.callee.type === 'MemberExpression' && node.callee.object.type === 'Identifier' && node.callee.object.name === 'console';
        if (isConsole)
            insideConsole++;
        const tag = insideConsole ? 'logging' : '';
        switch (node.type) {
            case 'BinaryExpression': {
                const tok = opToken(node.left.end, node.right.start, node.operator);
                if (CMP.has(node.operator)) {
                    add('cmp-flip', tok.start, tag);
                    if (['<', '>', '<=', '>='].includes(node.operator))
                        add('boundary', tok.start, tag);
                }
                if (ARITH.has(node.operator)) {
                    // The lexer's rule: no `+` right next to a string or template literal.
                    const stringy = node.operator === '+' && (isStringy(node.left) || isStringy(node.right));
                    add('arith', tok.start, stringy ? 'string-concat' : tag);
                }
                break;
            }
            case 'LogicalExpression':
                if (node.operator !== '??')
                    add('logical', opToken(node.left.end, node.right.start, node.operator).start, tag);
                break;
            case 'AssignmentExpression':
                if (node.operator === '+=' || node.operator === '-=')
                    add('arith', opToken(node.left.end, node.right.start, node.operator).start, node.operator === '+=' && isStringy(node.right) ? 'string-concat' : tag);
                break;
            case 'UpdateExpression':
                add('arith', node.prefix ? node.start : opToken(node.argument.end, node.end, node.operator).start, tag);
                break;
            case 'UnaryExpression':
                if (node.operator === '!')
                    add('remove-not', node.start, tag);
                if (node.operator === '-' || node.operator === '+')
                    add('arith', node.start, tag);
                break;
            case 'Literal':
                // `return true` flipped is the return-value mutant already (the lexer drops the duplicate text).
                if (typeof node.value === 'boolean' && !(parent?.type === 'Property' && parent.key === node) && parent?.type !== 'ReturnStatement')
                    add('bool-literal', node.start, tag);
                break;
            case 'IfStatement':
            case 'WhileStatement':
                add('negate-cond', node.start, tag);
                break;
            case 'DoWhileStatement': {
                const kw = tokens.findLast(t => t.end <= node.test.start && source.slice(t.start, t.end) === 'while');
                add('negate-cond', kw.start, tag);
                break;
            }
            case 'ReturnStatement': {
                const a = node.argument;
                if (a && !(a.type === 'Literal' && a.value === null) && !(a.type === 'Identifier' && a.name === 'undefined'))
                    add('return-value', node.start, tag);
                break;
            }
            case 'ExpressionStatement': {
                let e = node.expression;
                if (e.type === 'AwaitExpression')
                    e = e.argument;
                if (e.type === 'ChainExpression')
                    e = e.expression;
                if (e.type === 'CallExpression') {
                    const callee = e.callee;
                    const log = callee.type === 'MemberExpression' && callee.object.type === 'Identifier' && callee.object.name === 'console';
                    add('remove-call', node.start, log ? 'logging' : tag);
                }
                break;
            }
            // What only an AST offers cheaply (counted, not compared): conditions of ternaries and for-loops,
            // `??` defaults, arrow functions' expression bodies.
            case 'ConditionalExpression':
                add('ast-only:ternary-cond', node.test.start, tag);
                break;
            case 'ForStatement':
                if (node.test)
                    add('ast-only:for-cond', node.test.start, tag);
                break;
            case 'ArrowFunctionExpression':
                if (node.expression)
                    add('ast-only:arrow-return', node.body.start, tag);
                break;
        }
        if (node.type === 'LogicalExpression' && node.operator === '??')
            add('ast-only:nullish', opToken(node.left.end, node.right.start, '??').start, tag);
        for (const [k, v] of Object.entries(node)) {
            if (k === 'loc')
                continue;
            if (Array.isArray(v))
                v.forEach(c => c && typeof c.type === 'string' && visit(c, node));
            else if (v && typeof v.type === 'string')
                visit(v, node);
        }
        if (isConsole)
            insideConsole--;
    }
    visit(ast, null);
    const lineOf = pos => source.slice(0, pos).split('\n').length;
    return sites.map(s => ({ ...s, line: lineOf(s.start) }));
}

const result = { acornVersion: acorn.version, tokens: null, sites: {} };

if (args.includes('--all-src')) {
    const files = ['src', 'public'].filter(d => existsSync(join(REPO, d))).flatMap(d => walkFiles(join(REPO, d)));
    const agg = { files: files.length, tokens: 0, lexErrors: [], acornErrors: 0, filesWithMismatch: 0, onlyMine: 0, onlyTheirs: 0, lexMs: 0, acornTokenizeMs: 0, acornParseMs: 0, examples: [] };
    for (const f of files) {
        const src = readFileSync(f, 'utf8');
        const r = compareTokens(src);
        if (r.lexError) {
            agg.lexErrors.push(`${relative(REPO, f)}: ${r.lexError}`);
            continue;
        }
        if (r.acornError) {
            agg.acornErrors++;
            continue;
        }
        agg.tokens += r.tokens;
        agg.lexMs += r.lexMs;
        agg.acornTokenizeMs += r.acornMs;
        agg.acornParseMs += r.parseMs;
        if (r.onlyMine.length || r.onlyTheirs.length) {
            agg.filesWithMismatch++;
            agg.onlyMine += r.onlyMine.length;
            agg.onlyTheirs += r.onlyTheirs.length;
            if (agg.examples.length < 15) {
                const t = r.onlyMine[0] || r.onlyTheirs[0];
                const lineStart = src.lastIndexOf('\n', t.start) + 1;
                agg.examples.push({ file: relative(REPO, f), line: src.slice(0, t.start).split('\n').length, mine: r.onlyMine.length, acorn: r.onlyTheirs.length, text: src.slice(lineStart, src.indexOf('\n', t.start)).trim().slice(0, 160) });
            }
        }
    }
    for (const k of ['lexMs', 'acornTokenizeMs', 'acornParseMs'])
        agg[k] = Math.round(agg[k]);
    result.tokens = agg;
}

const siteFiles = opt('files', '') === 'ALL' ? walkFiles(join(REPO, 'src')).map(f => relative(REPO, f)) : (opt('files', '') || '').split(',').filter(Boolean);
for (const file of siteFiles) {
    const source = readFileSync(join(REPO, file), 'utf8');
    const lex = generateMutants(file, source);
    const ast = astSites(source);
    const k = (op, start) => `${op}@${start}`;
    // A lexer site is keyed by the operator's offset; negate-cond and return-value by the keyword, remove-call by the
    // statement's first token: the same anchors the AST side uses.
    const lexKeys = new Map(lex.map(m => [k(m.op, m.start), m]));
    // Both sides skip a `+` next to a string literal on purpose; such AST sites are not compared.
    const astKeys = new Map(ast.filter(s => !s.op.startsWith('ast-only') && s.extra !== 'string-concat').map(s => [k(s.op, s.start), s]));
    const onlyLex = [...lexKeys.keys()].filter(x => !astKeys.has(x)).map(x => lexKeys.get(x));
    const onlyAst = [...astKeys.keys()].filter(x => !lexKeys.has(x)).map(x => astKeys.get(x));
    const lines = source.split('\n');
    const astOnlyExtras = {};
    for (const s of ast.filter(s => s.op.startsWith('ast-only') && s.extra !== 'logging'))
        astOnlyExtras[s.op] = (astOnlyExtras[s.op] || 0) + 1;
    result.sites[file] = {
        lexer: lexKeys.size, ast: astKeys.size, both: [...lexKeys.keys()].filter(x => astKeys.has(x)).length,
        onlyLexer: onlyLex.map(m => ({ op: m.op, line: m.line, text: lines[m.line - 1].trim().slice(0, 140) })),
        onlyAst: onlyAst.map(s => ({ op: s.op, line: s.line, why: s.extra || null, text: lines[s.line - 1].trim().slice(0, 140) })),
        astOnlyExtras,
        tokens: (({ tokens, onlyMine, onlyTheirs }) => ({ tokens, onlyMine: onlyMine.length, onlyTheirs: onlyTheirs.length }))(compareTokens(source))
    };
}

if (siteFiles.length > 10) {
    // Many files: keep the totals and a few examples of each disagreement.
    const all = Object.entries(result.sites);
    const sum = k => all.reduce((n, [, v]) => n + (typeof v[k] === 'number' ? v[k] : v[k].length), 0);
    const extras = {};
    for (const [, v] of all)
        for (const [k, n] of Object.entries(v.astOnlyExtras))
            extras[k] = (extras[k] || 0) + n;
    const byOp = list => list.reduce((m, x) => ({ ...m, [`${x.op}${x.why ? `/${x.why}` : ''}`]: (m[`${x.op}${x.why ? `/${x.why}` : ''}`] || 0) + 1 }), {});
    const onlyLexer = all.flatMap(([f, v]) => v.onlyLexer.map(x => ({ file: f, ...x })));
    const onlyAst = all.flatMap(([f, v]) => v.onlyAst.map(x => ({ file: f, ...x })));
    result.sites = {
        files: all.length, lexer: sum('lexer'), ast: sum('ast'), both: sum('both'),
        onlyLexer: onlyLexer.length, onlyAst: onlyAst.length, onlyLexerByOp: byOp(onlyLexer), onlyAstByOp: byOp(onlyAst), astOnlyExtras: extras,
        examplesOnlyLexer: onlyLexer.slice(0, 25), examplesOnlyAst: onlyAst.filter(x => x.why !== 'string-concat').slice(0, 25)
    };
}
const text = JSON.stringify(result, null, 1);
if (opt('out'))
    writeFileSync(opt('out'), text);
console.log(text);
