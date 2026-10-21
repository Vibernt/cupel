// Shared JavaScript lexer for Cupel: line rule (K1), test shapes (K12) and textual mutation (D6).
// Ported unchanged from spike S3 (plans/spikes/s3/lexer.mjs), where it matched acorn on 2 M tokens of Assay.

/**
 * A small JavaScript lexer for textual mutation (spike S3, decision D6). Zero dependencies.
 *
 * It splits ES2024 module source into tokens and knows enough to never mutate inside strings, template literal
 * text, comments or regular expression literals. It is not a parser: it keeps a brace stack (for `${ }` inside
 * templates) and a paren stack (to know the `)` of an `if (...)` header), and decides "regex or division" from the
 * previous significant token. The one known wrong guess: a regex literal right after the `}` of a block
 * (`function f() {} /re/.test(s)`) is read as a division.
 *
 * Token: { type, value, start, end, line, col } with type one of
 *   name     identifiers and keywords (`if`, `return`, `true`, `foo`, `#private`)
 *   num      numeric literals (also bigint)
 *   string   '...' and "..."
 *   template a whole template piece: `...${  or  }...${  or  }...`  or  `...` (no substitutions)
 *   regex    /.../flags
 *   punct    operators and punctuation, longest match (`===`, `?.`, `=>`, `...`)
 * Comments and whitespace are skipped (`opts.comments` keeps comments as type `comment`).
 *
 * Usage: import { tokenize } from './lexer.mjs'; const tokens = tokenize(source);
 */

const PUNCTUATORS = [
    '>>>=', '...', '===', '!==', '**=', '<<=', '>>=', '>>>', '&&=', '||=', '??=',
    '=>', '==', '!=', '<=', '>=', '&&', '||', '??', '?.', '++', '--', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '**', '<<', '>>',
    '{', '}', '(', ')', '[', ']', ';', ',', '<', '>', '+', '-', '*', '/', '%', '&', '|', '^', '!', '~', '?', ':', '=', '.', '@'
];
/** After these keywords a `/` starts a regular expression, not a division. */
const REGEX_AFTER_KEYWORD = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await', 'extends']);
const ID_START = /[\p{ID_Start}$_]/u;
const ID_CONTINUE = /[\p{ID_Continue}$‌‍]/u;

export class LexError extends Error {
    constructor(message, pos) {
        super(`${message} at offset ${pos}`);
        this.pos = pos;
    }
}

/** Whether a `/` at this point starts a regex, judged from the previous significant token (the lexer's one guess). */
export function regexAllowed(prev) {
    if (!prev)
        return true;
    if (prev.type === 'num' || prev.type === 'string' || prev.type === 'regex')
        return false;
    if (prev.type === 'template')
        return !prev.value.endsWith('`') ? true : false;
    if (prev.type === 'name')
        return REGEX_AFTER_KEYWORD.has(prev.value);
    // `)` of `if (...)`, `while (...)`, `for (...)`, `with (...)` ends a header, so a statement (maybe a regex) follows.
    if (prev.value === ')')
        return prev.controlClose === true;
    // `]` `}` end an expression (the `}` of a block followed by a regex statement is the one known miss).
    return !(prev.value === ']' || prev.value === '}' || prev.value === '++' || prev.value === '--');
}

export function tokenize(src, opts = {}) {
    const tokens = [];
    const braces = []; // 'brace' or 'template' for each open `{` / `${`
    const parens = []; // for each open `(`: whether it opens a control header (if/while/for/with)
    let i = 0, line = 1, lineStart = 0;
    let prev = null;
    const n = src.length;
    const push = (type, start, end) => {
        const tok = { type, value: src.slice(start, end), start, end, line: lineAt(start), col: 0 };
        tok.col = start - lineStartAt(start);
        if (type !== 'comment')
            prev = tok;
        tokens.push(tok);
        return tok;
    };
    // Line bookkeeping: count newlines lazily as we move forward.
    let scannedTo = 0;
    function advanceLines(to) {
        for (let k = scannedTo; k < to; k++) {
            const c = src.charCodeAt(k);
            if (c === 10 || ((c === 0x2028 || c === 0x2029)) || (c === 13 && src.charCodeAt(k + 1) !== 10)) {
                line++;
                lineStart = k + 1;
            }
        }
        scannedTo = Math.max(scannedTo, to);
    }
    const lineAt = pos => (advanceLines(pos), line);
    const lineStartAt = pos => (advanceLines(pos), lineStart);

    if (src.startsWith('#!')) {
        while (i < n && src[i] !== '\n')
            i++;
    }
    /** Scans template text from i (just after ` or }) to the closing ` or to ${; returns the end index. */
    function scanTemplate(from) {
        let k = from;
        while (k < n) {
            const c = src[k];
            if (c === '\\') {
                k += 2;
                continue;
            }
            if (c === '`')
                return { end: k + 1, open: false };
            if (c === '$' && src[k + 1] === '{')
                return { end: k + 2, open: true };
            k++;
        }
        throw new LexError('Unterminated template literal', from);
    }
    while (i < n) {
        const c = src[i];
        const code = src.charCodeAt(i);
        // whitespace (incl. line terminators, BOM, NBSP and other Zs)
        if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\v' || c === '\f' || code === 0xfeff || code === 0xa0 || code === 0x2028 || code === 0x2029 || (code > 127 && /\s/u.test(c))) {
            i++;
            continue;
        }
        if (c === '/' && src[i + 1] === '/') {
            const start = i;
            while (i < n && src[i] !== '\n' && src[i] !== '\r' && src[i] !== ' ' && src[i] !== ' ')
                i++;
            if (opts.comments)
                push('comment', start, i);
            continue;
        }
        if (c === '/' && src[i + 1] === '*') {
            const start = i;
            const end = src.indexOf('*/', i + 2);
            if (end < 0)
                throw new LexError('Unterminated comment', i);
            i = end + 2;
            if (opts.comments)
                push('comment', start, i);
            continue;
        }
        if (c === "'" || c === '"') {
            const start = i;
            i++;
            while (i < n && src[i] !== c) {
                if (src[i] === '\\')
                    i++;
                else if (src[i] === '\n')
                    throw new LexError('Unterminated string', start);
                i++;
            }
            if (i >= n)
                throw new LexError('Unterminated string', start);
            i++;
            push('string', start, i);
            continue;
        }
        if (c === '`') {
            const start = i;
            const t = scanTemplate(i + 1);
            i = t.end;
            if (t.open)
                braces.push('template');
            push('template', start, i);
            continue;
        }
        if (c === '}' && braces[braces.length - 1] === 'template') {
            braces.pop();
            const start = i;
            const t = scanTemplate(i + 1);
            i = t.end;
            if (t.open)
                braces.push('template');
            push('template', start, i);
            continue;
        }
        if ((c >= '0' && c <= '9') || (c === '.' && src[i + 1] >= '0' && src[i + 1] <= '9')) {
            const start = i;
            const m = /^(?:0[xX][0-9a-fA-F_]+n?|0[oO][0-7_]+n?|0[bB][01_]+n?|(?:\d[\d_]*\.?[\d_]*|\.\d[\d_]*)(?:[eE][+-]?\d[\d_]*)?n?)/.exec(src.slice(i, i + 64));
            i += m[0].length;
            push('num', start, i);
            continue;
        }
        if (ID_START.test(c) || c === '\\' || c === '#' || (code >= 0xd800 && code <= 0xdbff && ID_START.test(src.slice(i, i + 2)))) {
            const start = i;
            i++;
            if (c === '\\')
                i += src[i] === 'u' && src[i + 1] === '{' ? src.indexOf('}', i) - i + 1 : 5;
            while (i < n) {
                const ch = src[i], cc = src.charCodeAt(i);
                if (cc >= 0xd800 && cc <= 0xdbff && ID_CONTINUE.test(src.slice(i, i + 2)))
                    i += 2;
                else if (ID_CONTINUE.test(ch))
                    i++;
                else if (ch === '\\')
                    i += src[i + 1] === 'u' && src[i + 2] === '{' ? src.indexOf('}', i) - i + 1 : 6;
                else
                    break;
            }
            push('name', start, i);
            continue;
        }
        if (c === '/' && regexAllowed(prev)) {
            const start = i;
            i++;
            let inClass = false;
            while (i < n) {
                const ch = src[i];
                if (ch === '\\') {
                    i += 2;
                    continue;
                }
                if (ch === '\n')
                    throw new LexError('Unterminated regex', start);
                if (inClass) {
                    if (ch === ']')
                        inClass = false;
                }
                else if (ch === '[')
                    inClass = true;
                else if (ch === '/')
                    break;
                i++;
            }
            i++;
            while (i < n && ID_CONTINUE.test(src[i]))
                i++;
            push('regex', start, i);
            continue;
        }
        let matched = null;
        for (const p of PUNCTUATORS) {
            if (src.startsWith(p, i)) {
                // `?.` followed by a digit is a conditional and a number (`a?.5:b`).
                if (p === '?.' && src[i + 2] >= '0' && src[i + 2] <= '9')
                    continue;
                matched = p;
                break;
            }
        }
        if (!matched)
            throw new LexError(`Unexpected character ${JSON.stringify(c)}`, i);
        const start = i;
        i += matched.length;
        if (matched === '{')
            braces.push('brace');
        else if (matched === '}')
            braces.pop();
        else if (matched === '(')
            parens.push(prev?.type === 'name' && ['if', 'while', 'for', 'with'].includes(prev.value));
        const tok = push('punct', start, i);
        if (matched === ')' && parens.pop())
            tok.controlClose = true;
    }
    return tokens;
}

/** For each `(`, `[`, `{` (and template `${`) token index, the index of its closing token, and the reverse. */
export function matchBrackets(tokens) {
    const pairs = new Map();
    const stack = [];
    for (let k = 0; k < tokens.length; k++) {
        const t = tokens[k];
        if (t.type === 'punct' && (t.value === '(' || t.value === '[' || t.value === '{'))
            stack.push(k);
        else if (t.type === 'template' && t.value.endsWith('${') && !t.value.startsWith('}'))
            stack.push(k);
        else if (t.type === 'punct' && (t.value === ')' || t.value === ']' || t.value === '}')) {
            const open = stack.pop();
            if (open !== undefined) {
                pairs.set(open, k);
                pairs.set(k, open);
            }
        }
        else if (t.type === 'template' && t.value.startsWith('}')) {
            const open = stack.pop();
            if (open !== undefined) {
                pairs.set(open, k);
                pairs.set(k, open);
            }
            if (t.value.endsWith('${'))
                stack.push(k);
        }
    }
    return pairs;
}
