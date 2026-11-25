// Exact Go mutant schemata. Accepted faults get a complete copy of their
// enclosing function body because Go has no type-independent if expression.
// Pure: no I/O and no node: imports.

const DEFAULT_BUDGET = 16 * 1024;
const DEFAULT_PER_FUNCTION = 8;
const IDENTIFIER = /^[_\p{L}][\p{L}\p{Nd}_]*$/u;
const KEYWORDS = new Set(('break default func interface select case defer go map struct chan else goto package switch ' +
  'const fallthrough if range type continue for import return var').split(' '));
const KEYWORD_SEMI = new Set(['break', 'continue', 'fallthrough', 'return']);
const OPEN = new Set(['(', '[', '{']);
const CLOSE = new Map([[')', '('], [']', '['], ['}', '{']]);
const PUNCTUATION = [
  '<<=', '>>=', '&^=', '...', '==', '!=', '<=', '>=', ':=', '++', '--', '&&', '||', '<-',
  '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<', '>>', '&^',
  '+', '-', '*', '/', '%', '&', '|', '^', '<', '>', '=', '!', '(', ')', '[', ']', '{', '}', ',', ';', ':', '.', '~',
];

const isIdentifierStart = (character) => character !== '' && /^[_\p{L}]$/u.test(character);
const isIdentifierContinue = (character) => character !== '' && /^[_\p{L}\p{Nd}]$/u.test(character);
const codePointAt = (text, at) => {
  const value = text.codePointAt(at);
  return value === undefined ? '' : String.fromCodePoint(value);
};
const isGoIdentifier = (value) => IDENTIFIER.test(value) && value !== '_' && !KEYWORDS.has(value);

function lineAt(text, at) {
  let line = 1;
  for (let index = 0; index < at; index++) if (text[index] === '\n') line++;
  return line;
}

function byteBoundaries(text) {
  const boundaries = new Map([[0, 0]]);
  let bytes = 0;
  for (let at = 0; at < text.length;) {
    const character = codePointAt(text, at);
    bytes += new TextEncoder().encode(character).length;
    at += character.length;
    boundaries.set(bytes, at);
  }
  return boundaries;
}

function validNumber(value) {
  const decimal = '(?:[0-9](?:_?[0-9])*)';
  const exponent = `(?:[eE][+-]?${decimal})`;
  const decimalFloat = `(?:${decimal}\\.${decimal}?${exponent}?|\\.${decimal}${exponent}?|${decimal}${exponent})`;
  const hex = '(?:[0-9a-fA-F](?:_?[0-9a-fA-F])*)';
  const hexFloat = `(?:0[xX]${hex}(?:\\.${hex}?)?[pP][+-]?${decimal}|0[xX]${hex}?\\.${hex}[pP][+-]?${decimal})`;
  const integer = `(?:0[xX]${hex}|0[bB][01](?:_?[01])*|0[oO][0-7](?:_?[0-7])*|${decimal})`;
  return new RegExp(`^(?:${integer}|${decimalFloat}|${hexFloat})i?$`).test(value);
}

/** A conservative lexer retaining comments so newline semicolons can be made explicit. */
function lexGo(text) {
  const tokens = [];
  let at = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const push = (kind, start, end, extra = {}) => tokens.push({ kind, start, end, value: text.slice(start, end), ...extra });
  while (at < text.length) {
    const start = at;
    const character = codePointAt(text, at);
    if (/\s/u.test(character)) { at += character.length; continue; }
    if (text.startsWith('//', at)) {
      let end = text.indexOf('\n', at + 2);
      if (end < 0) end = text.length;
      push('comment', at, end, { directive: /^\/\/(?:go:|line(?:\s|$))/.test(text.slice(at, end)) });
      at = end;
      continue;
    }
    if (text.startsWith('/*', at)) {
      const close = text.indexOf('*/', at + 2);
      if (close < 0) { push('bad', at, text.length); break; }
      at = close + 2;
      const value = text.slice(start, at);
      push('comment', start, at, { directive: /^\/\*(?:go:|line(?:\s|$))/.test(value), newline: /[\r\n]/.test(value) });
      continue;
    }
    if (isIdentifierStart(character)) {
      at += character.length;
      while (isIdentifierContinue(codePointAt(text, at))) at += codePointAt(text, at).length;
      push('identifier', start, at);
      continue;
    }
    if ((character >= '0' && character <= '9') || (character === '.' && /[0-9]/.test(text[at + 1] ?? ''))) {
      at++;
      while (at < text.length) {
        const next = text[at];
        if (/[0-9A-Za-z_.]/.test(next)) { at++; continue; }
        if ((next === '+' || next === '-') && /[eEpP]/.test(text[at - 1] ?? '')) { at++; continue; }
        break;
      }
      const value = text.slice(start, at);
      push(validNumber(value) ? 'number' : 'bad', start, at);
      continue;
    }
    if (character === '"' || character === "'") {
      const quote = character;
      at++;
      let closed = false;
      while (at < text.length) {
        if (text[at] === '\\') { at += 2; continue; }
        if (text[at] === quote) { at++; closed = true; break; }
        if (text[at] === '\n' || text[at] === '\r') break;
        at += codePointAt(text, at).length;
      }
      push(closed ? (quote === '"' ? 'string' : 'rune') : 'bad', start, at);
      continue;
    }
    if (character === '`') {
      const end = text.indexOf('`', at + 1);
      if (end < 0) { push('bad', at, text.length); break; }
      at = end + 1;
      push('raw', start, at, { newline: /[\r\n]/.test(text.slice(start, at)) });
      continue;
    }
    const punctuation = PUNCTUATION.find((value) => text.startsWith(value, at));
    if (punctuation) {
      at += punctuation.length;
      push('punctuation', start, at);
      continue;
    }
    at += character.length;
    push('bad', start, at);
  }
  return tokens;
}

function realTokens(tokens) {
  return tokens.filter((token) => token.kind !== 'comment');
}

function matchDelimiters(tokens) {
  const stack = [];
  for (let index = 0; index < tokens.length; index++) {
    const value = tokens[index].value;
    if (OPEN.has(value)) stack.push(index);
    else if (CLOSE.has(value)) {
      const open = stack.pop();
      if (open === undefined || tokens[open].value !== CLOSE.get(value)) return false;
      tokens[open].match = index;
      tokens[index].match = open;
    }
  }
  return stack.length === 0;
}

function semicolonAfter(token) {
  return token && (token.kind === 'identifier' || token.kind === 'number' || token.kind === 'string'
    || token.kind === 'rune' || token.kind === 'raw' || KEYWORD_SEMI.has(token.value)
    || token.value === '++' || token.value === '--' || token.value === ')' || token.value === ']'
    || token.value === '}');
}

function renderBody(source) {
  const all = lexGo(source);
  if (all.some((token) => token.kind === 'bad')) throw new Error('unparsed');
  if (all.some((token) => token.kind === 'raw' && token.newline)) throw new Error('multiline-raw');
  const parts = [];
  let previous = null;
  let cursor = 0;
  let newline = false;
  for (const token of all) {
    if (/\r|\n/.test(source.slice(cursor, token.start))) newline = true;
    cursor = token.end;
    if (token.kind === 'comment') {
      if (token.newline) newline = true;
      continue;
    }
    if (previous && newline && semicolonAfter(previous) && previous.value !== ';') parts.push(';');
    parts.push(token.value);
    previous = token;
    newline = false;
  }
  if (/\r|\n/.test(source.slice(cursor))) newline = true;
  if (previous && semicolonAfter(previous) && previous.value !== ';') parts.push(';');
  return parts.join(' ');
}

function replacementOk(replacement) {
  if (typeof replacement !== 'string' || /[\r\n]/.test(replacement)) return false;
  const tokens = lexGo(replacement);
  if (!tokens.length || tokens.some((token) => token.kind === 'bad' || token.kind === 'comment'
    || (token.kind === 'raw' && token.newline))) return false;
  let cursor = 0;
  for (const token of tokens) {
    if (replacement.slice(cursor, token.start).trim() !== '') return false;
    cursor = token.end;
  }
  return replacement.slice(cursor).trim() === '' && matchDelimiters(realTokens(tokens));
}

function byteLength(text) {
  return new TextEncoder().encode(text).length;
}

function functionFact(boundaries, site) {
  const fact = site?.function;
  if (!fact || !Number.isInteger(fact.start) || !Number.isInteger(fact.bodyStart) || !Number.isInteger(fact.bodyEnd)
    || typeof fact.results !== 'boolean' || typeof fact.generic !== 'boolean' || typeof fact.redeclare !== 'boolean') return null;
  const start = boundaries.get(fact.start);
  const bodyStart = boundaries.get(fact.bodyStart + 1);
  const bodyEnd = boundaries.get(fact.bodyEnd);
  if (![start, bodyStart, bodyEnd].every(Number.isInteger) || bodyEnd < bodyStart) return null;
  return { ...fact, start, bodyStart, bodyEnd };
}

/**
 * Insert one-line, whole-body variants behind a CUPEL_FAULT switch.
 * Site offsets are UTF-8 bytes, matching mutate-go/sites.mjs.
 * @returns {{text: string, switched: number[], refused: {number: number, reason: string}[], insertions: {line: number, column: number, length: number}[]}}
 */
export function goBodyVariants(text, sites, {
  helper = '_cupelFaultActive', budget = DEFAULT_BUDGET, perFunction = DEFAULT_PER_FUNCTION,
} = {}) {
  if (typeof text !== 'string') throw new TypeError('goBodyVariants: text must be a string');
  if (!isGoIdentifier(helper)) throw new TypeError(`goBodyVariants: not a Go identifier: ${helper}`);
  if (!Number.isInteger(budget) || budget < 1) throw new TypeError('goBodyVariants: budget must be a positive integer');
  if (!Number.isInteger(perFunction) || perFunction < 1) throw new TypeError('goBodyVariants: perFunction must be a positive integer');

  const refused = [];
  const refuse = (number, reason) => refused.push({ number, reason });
  const boundaries = byteBoundaries(text);
  const seen = new Set();
  const candidates = new Map();
  const ordered = [...(sites ?? [])].sort((left, right) => (left?.number ?? 0) - (right?.number ?? 0));

  for (const site of ordered) {
    const number = site?.number;
    if (!Number.isInteger(number) || number < 1 || number > 0xffffffff || seen.has(number)) { refuse(number, 'number'); continue; }
    seen.add(number);
    if (site?.fileReason) { refuse(number, site.fileReason); continue; }
    if (!replacementOk(site?.replacement)) { refuse(number, 'replacement'); continue; }
    const start = boundaries.get(site?.start);
    const end = boundaries.get(site?.end);
    if (!Number.isInteger(start) || !Number.isInteger(end) || end <= start
      || typeof site.original !== 'string' || text.slice(start, end) !== site.original) { refuse(number, 'span'); continue; }
    const fn = functionFact(boundaries, site);
    if (!fn || start < fn.bodyStart || end > fn.bodyEnd) { refuse(number, 'function'); continue; }
    if (site.functionLiteral) {
      refuse(number, 'function-literal');
      continue;
    }
    const key = `${fn.bodyStart}\0${fn.bodyEnd}`;
    const entry = candidates.get(key) ?? { fn, list: [] };
    const list = entry.list;
    list.push({ number, start, end, replacement: site.replacement });
    candidates.set(key, entry);
  }

  const accepted = new Map();
  for (const [key, { fn, list }] of candidates) {
    const reason = fn.reason || (fn.redeclare ? 'redeclare' : null);
    if (reason) { for (const site of list) refuse(site.number, reason); continue; }
    const bodyStart = fn.bodyStart;
    const bodyEnd = fn.bodyEnd;
    const body = text.slice(bodyStart, bodyEnd);
    let original;
    try { original = renderBody(body); }
    catch (error) { for (const site of list) refuse(site.number, error.message); continue; }
    const multiplier = fn.generic ? 2 : 1;
    if (byteLength(original) * multiplier > budget) { for (const site of list) refuse(site.number, 'budget'); continue; }
    const variants = [];
    for (const site of list) {
      if (variants.length >= perFunction) { refuse(site.number, 'bound'); continue; }
      let rendered;
      try {
        rendered = renderBody(body.slice(0, site.start - bodyStart) + site.replacement + body.slice(site.end - bodyStart));
      } catch (error) {
        refuse(site.number, error.message === 'multiline-raw' ? 'multiline-raw' : 'replacement');
        continue;
      }
      if (byteLength(rendered) * multiplier > budget) { refuse(site.number, 'budget'); continue; }
      variants.push({ number: site.number, rendered });
    }
    if (variants.length) accepted.set(key, { fn, variants });
  }

  let renderedText = text;
  const additions = [...accepted.values()].sort((left, right) => right.fn.bodyStart - left.fn.bodyStart);
  const insertions = [];
  for (const { fn, variants } of additions) {
    const cases = variants.map(({ number, rendered }) => `case ${number}: ${rendered}${fn.results ? '' : ' return;'}`).join(' ');
    // The original first statement remains on this same physical line. Go's
    // lexer therefore cannot insert its usual newline semicolon after `}`.
    const insertion = `switch ${helper}() { ${cases} };`;
    const at = fn.bodyStart;
    renderedText = renderedText.slice(0, at) + insertion + renderedText.slice(at);
    const line = lineAt(text, at);
    const lineStart = text.lastIndexOf('\n', at - 1) + 1;
    insertions.push({ line, column: [...text.slice(lineStart, at)].length + 1, length: [...insertion].length });
  }
  insertions.reverse();
  refused.sort((left, right) => (left.number ?? 0) - (right.number ?? 0));
  const switched = [...accepted.values()].flatMap(({ variants }) => variants).map((site) => site.number).sort((left, right) => left - right);
  return { text: renderedText, switched, refused, insertions };
}

/** Return the extra Go source file that owns the process-wide fault switch. */
export function goFaultHelper(packageName, helper = '_cupelFaultActive') {
  if (!isGoIdentifier(packageName)) throw new TypeError(`goFaultHelper: not a Go package identifier: ${packageName}`);
  if (!isGoIdentifier(helper)) throw new TypeError(`goFaultHelper: not a Go identifier: ${helper}`);
  const active = `${helper}Value`;
  // Package initialization precedes test code, so a test cannot erase the
  // runner-selected fault with os.Unsetenv before the first mutated call.
  return `package ${packageName}\n\nimport (\n\t"os"\n\t"strconv"\n)\n\nvar ${active} = func() uint32 {\n\tvalue, err := strconv.ParseUint(os.Getenv("CUPEL_FAULT"), 10, 32)\n\tif err != nil {\n\t\treturn 0\n\t}\n\treturn uint32(value)\n}()\n\nfunc ${helper}() uint32 {\n\treturn ${active}\n}\n`;
}
