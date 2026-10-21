// A small, strict XML parser for JUnit reports. Standard library only, no network, no entity expansion
// beyond the five predefined entities and character references. A DOCTYPE is skipped; any entity it
// declares is refused rather than expanded (so no entity-expansion attacks).
//
// parseXml(text) -> { name, attrs, children, text } for the root element. `children` holds child
// elements only; `text` is the concatenated character data (CDATA included) directly inside the element.

export class XmlError extends Error {}

const PREDEFINED = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
const NAME = /[A-Za-z_:][-A-Za-z0-9_:.]*/y;

function decode(text, at) {
  return text.replace(/&([^;&\s]*);?/g, (whole, ref, offset) => {
    if (!whole.endsWith(';')) throw new XmlError(`unterminated entity reference at offset ${at + offset}`);
    if (Object.hasOwn(PREDEFINED, ref)) return PREDEFINED[ref];
    const m = /^#(?:x([0-9A-Fa-f]+)|([0-9]+))$/.exec(ref);
    if (m) {
      const code = m[1] !== undefined ? parseInt(m[1], 16) : parseInt(m[2], 10);
      if (code > 0x10ffff || code === 0) throw new XmlError(`invalid character reference &${ref}; at offset ${at + offset}`);
      return String.fromCodePoint(code);
    }
    throw new XmlError(`unknown entity &${ref}; at offset ${at + offset}`);
  });
}

export function parseXml(input) {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  let i = 0;
  let root = null;
  const stack = [];

  const fail = (msg) => {
    throw new XmlError(`${msg} at offset ${i}`);
  };
  const expect = (s) => {
    if (!text.startsWith(s, i)) fail(`expected "${s}"`);
    i += s.length;
  };
  const skipSpace = () => {
    while (i < text.length && /\s/.test(text[i])) i++;
  };
  const readName = () => {
    NAME.lastIndex = i;
    const m = NAME.exec(text);
    if (!m) fail('expected a name');
    i += m[0].length;
    return m[0];
  };
  const skipPast = (end, what) => {
    const j = text.indexOf(end, i);
    if (j < 0) fail(`unterminated ${what}`);
    i = j + end.length;
  };

  while (i < text.length) {
    if (text.startsWith('<!--', i)) {
      skipPast('-->', 'comment');
    } else if (text.startsWith('<![CDATA[', i)) {
      if (!stack.length) fail('character data outside the root element');
      const start = i + 9;
      skipPast(']]>', 'CDATA section');
      stack[stack.length - 1].text += text.slice(start, i - 3);
    } else if (text.startsWith('<?', i)) {
      skipPast('?>', 'processing instruction');
    } else if (text.startsWith('<!DOCTYPE', i)) {
      if (root || stack.length) fail('DOCTYPE after the root element');
      // Skip the declaration, refusing internal entity declarations.
      let depth = 0;
      const start = i;
      for (; i < text.length; i++) {
        if (text[i] === '[') depth++;
        else if (text[i] === ']') depth--;
        else if (text[i] === '>' && depth <= 0) break;
      }
      if (i >= text.length) fail('unterminated DOCTYPE');
      if (/<!ENTITY/.test(text.slice(start, i))) throw new XmlError('entity declarations are not supported');
      i++;
    } else if (text.startsWith('</', i)) {
      i += 2;
      const name = readName();
      skipSpace();
      expect('>');
      const open = stack.pop();
      if (!open) fail(`unexpected closing tag </${name}>`);
      if (open.name !== name) fail(`closing tag </${name}> does not match <${open.name}>`);
    } else if (text[i] === '<') {
      i++;
      const el = { name: readName(), attrs: {}, children: [], text: '' };
      for (;;) {
        const before = i;
        skipSpace();
        if (text.startsWith('/>', i)) {
          i += 2;
          el.selfClosing = true;
          break;
        }
        if (text[i] === '>') {
          i++;
          break;
        }
        if (i === before) fail(`expected whitespace, "/>" or ">" in <${el.name}>`);
        const attr = readName();
        skipSpace();
        expect('=');
        skipSpace();
        const q = text[i];
        if (q !== '"' && q !== "'") fail(`attribute ${attr} needs a quoted value`);
        const end = text.indexOf(q, i + 1);
        if (end < 0) fail(`unterminated value of attribute ${attr}`);
        const raw = text.slice(i + 1, end);
        if (raw.includes('<')) fail(`"<" in the value of attribute ${attr}`);
        if (Object.hasOwn(el.attrs, attr)) fail(`duplicate attribute ${attr}`);
        el.attrs[attr] = decode(raw, i + 1).replace(/[\t\n\r]/g, ' ');
        i = end + 1;
      }
      if (stack.length) stack[stack.length - 1].children.push(el);
      else if (root) fail('more than one root element');
      else root = el;
      if (!el.selfClosing) stack.push(el);
      delete el.selfClosing;
    } else {
      const j = text.indexOf('<', i);
      const end = j < 0 ? text.length : j;
      const chunk = text.slice(i, end);
      if (stack.length) stack[stack.length - 1].text += decode(chunk, i);
      else if (/\S/.test(chunk)) fail('text outside the root element');
      i = end;
    }
  }
  if (stack.length) throw new XmlError(`unclosed element <${stack[stack.length - 1].name}>`);
  if (!root) throw new XmlError('no root element');
  return root;
}
