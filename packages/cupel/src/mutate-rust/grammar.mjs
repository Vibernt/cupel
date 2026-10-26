import { lexRust } from './lex.mjs';
import { refuse } from './errors.mjs';

const primitive = new Set(['i8','i16','i32','i64','isize','u8','u16','u32','u64','usize','bool','str','String']);
const prec = new Map([['||',1],['&&',2],['==',3],['!=',3],['<',4],['<=',4],['>',4],['>=',4],['+',5],['-',5],['*',6],['/',6],['%',6]]);
const flip = new Map([['==','!='],['!=','=='],['<','>'],['>','<'],['<=','>='],['>=','<='],['&&','||'],['||','&&'],['+','-'],['-','+']]);
const macros = new Set(['assert','assert_eq','assert_ne','debug_assert','debug_assert_eq','debug_assert_ne','panic','println','eprintln','concat','env','include_str','include_bytes','file','module_path','line','column']);
const standardPaths = new Set(['std::fs::read','std::fs::read_to_string','std::string::String::from','String::from']);

export function parseRust(text, file) {
  const ts = lexRust(text, file); let pos = 0, depth = 0, nodes = 0, tests = 0;
  const modules = [], functions = [], sites = [], sourceReads = [];
  const peek = () => ts[pos]?.value;
  const fail = (why) => refuse('unsupported-rust-syntax', `${file}:${ts[pos]?.line ?? 1}: ${why}; found ${peek() ?? 'EOF'}`);
  const take = (v) => { if (peek() !== v) fail(`expected ${v}`); return ts[pos++]; };
  const optional = (v) => peek() === v ? (pos++, true) : false;
  const ident = () => { const t = ts[pos]; if (t?.kind !== 'ident' || ['unsafe','extern','async','await','macro_rules','impl','trait','struct','enum','union','use','static','const','type','move','loop','while','for','match','dyn'].includes(t.value)) fail('unsupported identifier/construct'); pos++; return t; };
  const bounded = (fn) => { if (++depth > 64 || ++nodes > 20_000) fail('grammar bound exceeded'); try { return fn(); } finally { depth--; } };
  const type = () => bounded(() => {
    if (optional('&')) { optional("'static"); optional('mut'); type(); return; }
    if (optional('(')) { if (!optional(')')) { type(); while (optional(',')) { if (peek() === ')') break; type(); } take(')'); } return; }
    if (optional('[')) { type(); if (optional(';')) { if (ts[pos]?.kind !== 'number') fail('array length must be literal'); pos++; } take(']'); return; }
    if (!primitive.has(peek())) fail('type outside primitive/reference/tuple/array profile'); pos++;
  });
  const list = (end) => { if (!optional(end)) { expression(); while (optional(',')) { if (peek() === end) break; expression(); } take(end); } };
  const macro = (path) => {
    if (path.includes('::') || !macros.has(path)) fail(`macro ${path}! is outside explicit standard whitelist`);
    take('!'); take('('); const begin = pos;
    list(')');
    if (['file','module_path','line','column'].includes(path) && pos !== begin + 1) fail(`${path}! requires no arguments`);
    if (path === 'env') {
      const args = ts.slice(begin, pos - 1);
      if (args.length !== 1 || args[0].value !== '"CARGO_MANIFEST_DIR"') fail('only env!("CARGO_MANIFEST_DIR") is supported');
    }
    if (['include_str','include_bytes'].includes(path)) {
      const args = ts.slice(begin, pos - 1);
      if (args.length !== 1 || args[0].kind !== 'string' || !/^"[A-Za-z_][A-Za-z_0-9]*\.rs"$/.test(args[0].value)) fail('include macros require a local original Rust basename');
      includes.add(args[0].value.slice(1, -1));
    }
  };
  const includes = new Set();
  const block = () => bounded(() => {
    take('{'); while (peek() !== '}') {
      if (!peek()) fail('unclosed block');
      if (optional('let')) { optional('mut'); ident(); if (optional(':')) type(); take('='); expression(); take(';'); continue; }
      if (optional('return')) { if (peek() !== ';') expression(); take(';'); continue; }
      const start = pos; expression();
      if (!optional(';') && peek() !== '}' && ts[start]?.value !== 'if' && ts[start]?.value !== '{') fail('statement must end with semicolon');
    } take('}');
  });
  const atom = () => bounded(() => {
    const t = ts[pos]; let sourceReader = false;
    if (optional('if')) { expression(); block(); if (optional('else')) { if (peek() === 'if') atom(); else block(); } }
    else if (peek() === '{') block();
    else if (optional('(')) list(')');
    else if (optional('[')) list(']');
    else if (optional('!') || optional('-') || optional('&') || optional('*')) atom();
    else if (t?.kind === 'number' || t?.kind === 'string') pos++;
    else if (['true','false'].includes(peek())) pos++;
    else {
      let path = ident().value;
      while (optional('::')) path += `::${ident().value}`;
      if (peek() === '!') macro(path);
      else if ((path.startsWith('std::') || path.startsWith('String::')) && !standardPaths.has(path)) fail(`standard path ${path} is unsupported`);
      sourceReader = ['std::fs::read','std::fs::read_to_string'].includes(path);
      if (sourceReader && peek() !== '(') fail('source reader must be a direct call with a pinned literal target');
    }
    while (true) {
      if (optional('(')) {
        const begin=pos; list(')');
        if (sourceReader) {
          const argument=ts.slice(begin,pos-1).map((token)=>token.value).join('').replace(/,$/,'');
          const relative=/^"(src\/[A-Za-z_0-9/.-]+\.rs)"$/.exec(argument);
          const absolute=/^concat!\(env!\("CARGO_MANIFEST_DIR"\),"\/(src\/[A-Za-z_0-9/.-]+\.rs)"\)$/.exec(argument);
          const target=relative?.[1] ?? absolute?.[1];
          if (!target || target.split('/').some((part)=>part==='.'||part==='..'||part.startsWith('.'))) fail('native reads require a literal pinned src/*.rs target or manifest-dir concat');
          sourceReads.push(target); sourceReader=false;
        }
      }
      else if (optional('.')) { if (ts[pos]?.kind === 'number') pos++; else ident(); }
      else if (optional('[')) { expression(); take(']'); }
      else break;
    }
  });
  const expression = (min = 0) => bounded(() => {
    atom(); while (prec.has(peek()) && prec.get(peek()) >= min) {
      const token = ts[pos++]; expression(prec.get(token.value) + 1);
      if (!tests && flip.has(token.value)) sites.push({ ...token, original: token.value, replacement: flip.get(token.value), operator: ['+','-'].includes(token.value) ? 'arithmetic-replacement' : ['&&','||'].includes(token.value) ? 'logical-replacement' : 'comparison-replacement' });
    }
  });
  function items(prefix = []) {
    while (pos < ts.length && peek() !== '}') {
      const attributes = [];
      while (optional('#')) { take('['); const a = ident().value; if (!['test','ignore'].includes(a)) fail(`attribute ${a} unsupported`); take(']'); attributes.push(a); }
      optional('pub');
      if (optional('mod')) {
        if (attributes.length) fail('module attributes unsupported');
        const token = ident();
        if (optional(';')) {
          const first = ts[pos - 3]; const last = ts[pos - 1];
          const line = text.split('\n')[token.line - 1];
          if (first.line !== last.line || !/^\s*(?:pub\s+)?mod\s+[A-Za-z_][A-Za-z_0-9]*\s*;\s*$/.test(line)) fail('external module declaration must occupy its own isolated line');
          modules.push({ name: token.value, start: text.lastIndexOf('\n', first.start - 1) + 1, end: text.indexOf('\n', last.end) === -1 ? text.length : text.indexOf('\n', last.end), prefix });
        } else { take('{'); items([...prefix, token.value]); take('}'); }
        continue;
      }
      take('fn'); const name = ident().value; take('(');
      if (!optional(')')) { do { ident(); take(':'); type(); } while (optional(',') && peek() !== ')'); take(')'); }
      if (optional('->')) type();
      const isTest = attributes.includes('test');
      if (attributes.includes('ignore') && !isTest) fail('ignore requires test');
      if (functions.length >= 512) fail('function bound exceeded');
      functions.push({ name: [...prefix, name].join('::'), test: isTest, ignored: attributes.includes('ignore') });
      if (isTest) tests++;
      block();
      if (isTest) tests--;
    }
  }
  items(); if (pos !== ts.length) fail('trailing tokens');
  return { modules, functions, sites, includes: [...includes], sourceReads };
}
