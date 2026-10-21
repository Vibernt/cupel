/**
 * S1 spike library: turn raw V8 coverage (NODE_V8_COVERAGE output) into per-source-file line sets.
 * Not run directly; imported by collect.mjs, loadonly.mjs and analyze.mjs.
 *
 * The line rule (the one Cupel's spec will reuse):
 *   1. Classify every UTF-16 code unit of a source file as whitespace, comment or code, with a small JS lexer
 *      (line and block comments, '...', "...", `...${...}` templates, and regex literals, which start with '/'
 *      when the previous significant token cannot end an expression).
 *   2. A line is *coverable* when it holds at least one code character. Blank and comment-only lines are ignored.
 *   3. For one V8 script entry, every range of every function is painted onto a per-character count array, widest
 *      range first, so a character's count comes from the innermost (narrowest) range that contains it.
 *      Characters inside no range count 0.
 *   4. A coverable line is *covered* by that entry when any code character on it has count > 0.
 *   5. Entries for the same file (several processes, child processes, the same module loaded twice) are merged by
 *      union of their covered lines. URLs are file:// only; '?query' and '#hash' are stripped.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { relative, sep } from 'node:path';

const WS = 0, COMMENT = 1, CODE = 2;
const KEYWORDS_BEFORE_EXPR = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw',
    'case', 'do', 'else', 'yield', 'await']);

/** Per-character classes (Uint8Array of WS/COMMENT/CODE) for JS source text. */
export function classify(src) {
    const n = src.length, cls = new Uint8Array(n);
    let i = 0, lastSig = '', lastWord = '';
    const braceStack = []; // for template literals: 'T' marks a ${ opened inside a template
    const isWs = c => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\v' || c === ' ' || c === '﻿' || c === ' ' || c === ' ';
    const regexAllowed = () => {
        if (lastSig === '') return true;
        if (lastWord && KEYWORDS_BEFORE_EXPR.has(lastWord)) return true;
        return '(,=:[!&|?{};+-*%<>~^'.includes(lastSig);
    };
    const template = () => { // i is just after the opening backtick (or after a closing } of ${})
        while (i < n) {
            const c = src[i];
            if (c === '\\') { cls[i] = CODE; if (i + 1 < n) cls[i + 1] = CODE; i += 2; continue; }
            if (c === '`') { cls[i++] = CODE; return; }
            if (c === '$' && src[i + 1] === '{') { cls[i] = cls[i + 1] = CODE; i += 2; braceStack.push('T'); lastSig = '{'; lastWord = ''; return 'expr'; }
            cls[i] = isWs(c) ? WS : CODE; i++;
        }
    };
    while (i < n) {
        const c = src[i];
        if (isWs(c)) { cls[i++] = WS; continue; }
        if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') cls[i++] = COMMENT; continue; }
        if (c === '/' && src[i + 1] === '*') {
            const end = src.indexOf('*/', i + 2), stop = end < 0 ? n : end + 2;
            while (i < stop) { cls[i] = isWs(src[i]) ? WS : COMMENT; i++; }
            continue;
        }
        if (c === '#' && i === 0 && src[1] === '!') { while (i < n && src[i] !== '\n') cls[i++] = CODE; continue; }
        if (c === '\'' || c === '"') {
            cls[i++] = CODE;
            while (i < n && src[i] !== c && src[i] !== '\n') { if (src[i] === '\\') cls[i++] = CODE; if (i < n) cls[i++] = CODE; }
            if (i < n) cls[i++] = CODE;
            lastSig = c; lastWord = ''; continue;
        }
        if (c === '`') { cls[i++] = CODE; template(); lastSig = '`'; lastWord = ''; continue; }
        if (c === '}' && braceStack.length && braceStack[braceStack.length - 1] === 'T') {
            braceStack.pop(); cls[i++] = CODE; template(); lastSig = '`'; lastWord = ''; continue;
        }
        if (c === '/' && regexAllowed()) {
            cls[i++] = CODE; let inClass = false;
            while (i < n && src[i] !== '\n') {
                const d = src[i];
                if (d === '\\') { cls[i++] = CODE; if (i < n) cls[i++] = CODE; continue; }
                cls[i++] = CODE;
                if (d === '[') inClass = true; else if (d === ']') inClass = false; else if (d === '/' && !inClass) break;
            }
            while (i < n && /[a-z]/i.test(src[i])) cls[i++] = CODE;
            lastSig = ')'; lastWord = ''; continue;
        }
        if (/[A-Za-z_$0-9]/.test(c)) {
            const start = i; while (i < n && /[A-Za-z_$0-9]/.test(src[i])) cls[i++] = CODE;
            lastWord = src.slice(start, i); lastSig = 'a'; continue;
        }
        if (c === '{') braceStack.push('B');
        else if (c === '}') braceStack.pop();
        cls[i++] = CODE; lastSig = c; lastWord = '';
    }
    return cls;
}

/** Line table for a source file: line start offsets, which lines are coverable, which are punctuation-only. */
export function lineTable(src) {
    const cls = classify(src), starts = [0];
    for (let i = 0; i < src.length; i++) if (src[i] === '\n') starts.push(i + 1);
    const coverable = new Uint8Array(starts.length + 1), punct = new Uint8Array(starts.length + 1); // 1-based lines
    for (let l = 0; l < starts.length; l++) {
        const a = starts[l], b = l + 1 < starts.length ? starts[l + 1] : src.length;
        let code = false, onlyPunct = true;
        for (let i = a; i < b; i++) if (cls[i] === CODE) { code = true; if (!'{}()[];,'.includes(src[i])) onlyPunct = false; }
        if (code) { coverable[l + 1] = 1; if (onlyPunct) punct[l + 1] = 1; }
    }
    return { src, cls, starts, coverable, punct, lines: starts.length };
}

const tableCache = new Map();
/** Cached line table for an absolute path (null when the file cannot be read). */
export function tableFor(abs) {
    if (!tableCache.has(abs)) {
        let t = null;
        try { t = lineTable(readFileSync(abs, 'utf8')); } catch { }
        tableCache.set(abs, t);
    }
    return tableCache.get(abs);
}

/**
 * Repo-relative path for a V8 script URL, or null when it is not a counted source file. Scope 'src-public' (the
 * default, as Assay's test:coverage counts): src/** and public/**. Scope 'repo': any JS file in the repository
 * except tests/**, node_modules and dot-directories (.build and the like).
 */
export function repoPath(url, root, scope = 'src-public') {
    if (!url.startsWith('file://')) return null;
    let abs;
    try { abs = fileURLToPath(url.replace(/[?#].*$/, '')); } catch { return null; }
    const rel = relative(root, abs).split(sep).join('/');
    if (rel.startsWith('..') || rel.includes('node_modules/') || rel.startsWith('tests/')) return null;
    if (scope === 'repo') { if (rel.startsWith('.') || rel.includes('/.')) return null; }
    else if (!rel.startsWith('src/') && !rel.startsWith('public/')) return null;
    if (!/\.(mjs|cjs|js)$/.test(rel)) return null;
    return rel;
}

/** Covered lines (sorted array of 1-based line numbers) of one V8 script entry, by the rule above. */
export function coveredLines(entry, table) {
    const n = table.src.length, counts = new Int32Array(n);
    const ranges = [];
    for (const fn of entry.functions) for (const r of fn.ranges) ranges.push(r);
    ranges.sort((a, b) => (b.endOffset - b.startOffset) - (a.endOffset - a.startOffset)); // widest first; stable
    for (const r of ranges) counts.fill(r.count, Math.max(0, r.startOffset), Math.min(n, r.endOffset));
    const out = [];
    for (let l = 1; l <= table.lines; l++) {
        if (!table.coverable[l]) continue;
        const a = table.starts[l - 1], b = l < table.lines ? table.starts[l] : n;
        for (let i = a; i < b; i++) if (table.cls[i] === CODE && counts[i] > 0) { out.push(l); break; }
    }
    return out;
}

/**
 * Merge the parsed V8 coverage files of one run into { path: Set(lines) }. `docs` is an array of parsed
 * coverage-*.json objects. Returns { lines, scripts } where scripts counts the matched script entries.
 */
export function linesFromCoverage(docs, root, scope = 'src-public') {
    const lines = new Map(); let scripts = 0;
    for (const doc of docs) for (const entry of doc.result ?? []) {
        const rel = repoPath(entry.url, root, scope); if (!rel) continue;
        const table = tableFor(`${root}/${rel}`); if (!table) continue;
        scripts++;
        let set = lines.get(rel); if (!set) lines.set(rel, set = new Set());
        for (const l of coveredLines(entry, table)) set.add(l);
    }
    return { lines, scripts };
}

/** Serialize { path: Set } to a plain sorted object { path: [lines] }, dropping empty sets. */
export function toPlain(lines) {
    const out = {};
    for (const p of [...lines.keys()].sort()) { const a = [...lines.get(p)].sort((x, y) => x - y); if (a.length) out[p] = a; }
    return out;
}
