import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { scanRust, shape } from './lex.mjs';

function rustFiles(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || ['target', 'vendor'].includes(entry.name)) continue;
    const file = join(dir, entry.name);
    if (entry.isDirectory()) rustFiles(file, out);
    else if (entry.isFile() && entry.name.endsWith('.rs')) out.push(file);
  }
  return out;
}

export function definitions(root) {
  const found = [];
  for (const file of rustFiles(root)) {
    const source = readFileSync(file, 'utf8'); const lines = source.split('\n');
    const tokens = scanRust(source).tokens;
    const scopes = []; let depth = 0;
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      if (token.value === 'mod' && tokens[i + 1]?.value && tokens[i + 2]?.value === '{') scopes.push({ name: tokens[i + 1].value, depth: depth + 1 });
      if (token.value === '#') {
        let j = i + 1; let attr = '';
        if (tokens[j]?.value === '[') { while (j < tokens.length && tokens[j].value !== ']') attr += tokens[j++].value; j++; }
        if (attr === '[test' && tokens[j]?.value === 'fn' && tokens[j + 2]?.value === '(') {
          const name = tokens[j + 1].value;
          let open = j + 3; while (open < tokens.length && tokens[open].value !== '{') open++;
          if (open === tokens.length) throw new Error(`missing Rust test body: ${file}:${name}`);
          let nesting = 1; let end = open + 1;
          while (end < tokens.length && nesting) { if (tokens[end].value === '{') nesting++; if (tokens[end].value === '}') nesting--; end++; }
          if (nesting) throw new Error(`unclosed Rust test body: ${file}:${name}`);
          const modulePath = scopes.map((scope) => scope.name);
          const fullName = [...modulePath, name].join('::');
          const path = relative(root, file).split(sep).join('/');
          const id = `${path}::${[...modulePath, name].join(' > ')}`;
          const body = tokens.slice(open + 1, end - 1);
          const rawBody = source.slice(tokens[open].end, tokens[end - 1].start);
          const tag = /^\s*\/\/\s*cupel:(critical|minor|standard)\s*$/.exec(lines[token.line - 2] ?? '')?.[1];
          const reads = /(?:include_str!|std\s*::\s*fs\s*::\s*read_to_string)\s*\(\s*[^)]*\.(?:rs|md|txt|rst)["#]/s.test(rawBody);
          const asserts = /\b(?:assert(?:_eq|_ne)?!|debug_assert!|panic!|expect\s*\()/s.test(rawBody);
          found.push({ fullName, id, file: path, name: fullName, ...(tag ? { tags: [tag] } : {}), shape: shape(body),
            brittleness: reads && asserts ? [{ test: id, kind: /\.(?:md|txt|rst)["#]/.test(rawBody) ? 'doc-wording' : 'source-text', line: token.line }] : [] });
          i = end - 1;
          continue;
        }
      }
      if (token.value === '{') depth++;
      if (token.value === '}') { depth--; while (scopes.at(-1)?.depth > depth) scopes.pop(); }
    }
  }
  return found;
}

// A `mod tests;` file contributes its filename to the harness path, while the
// crate root itself contributes no module component.
export function harnessName(def, root, crateRoot) {
  if (!crateRoot || join(root, def.file) === crateRoot) return def.fullName;
  const path = relative(dirname(crateRoot), join(root, def.file)).split(sep);
  if (path[0] === '..') return def.fullName;
  const leaf = path.pop();
  if (!leaf?.endsWith('.rs')) return def.fullName;
  const stem = leaf.slice(0, -3);
  if (stem !== 'mod') path.push(stem);
  return [...path, def.fullName].join('::');
}
