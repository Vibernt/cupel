import { createReadStream } from 'node:fs';
import { mapExportFile } from './coverage.mjs';

// Read llvm-cov's large JSON document without retaining its functions,
// summaries, or every file's segments in the Node heap at once.
export async function exportLinesFromFile(path, root) {
  return exportLinesFromChunks(createReadStream(path, { encoding: 'utf8' }), root);
}

export async function exportLinesFromChunks(chunks, root) {
  const files = new Map();
  const parser = new ExportParser((file) => mapExportFile(files, file, root));
  for await (const chunk of chunks) parser.write(chunk);
  parser.end();
  return files;
}

class ExportParser {
  constructor(onFile) {
    this.onFile = onFile;
    this.frames = [];
    this.root = 'value';
    this.lex = 'normal';
    this.capture = null;
  }

  fail() { throw new Error('invalid LLVM coverage JSON'); }

  value() {
    const parent = this.frames.at(-1);
    if (!parent) {
      if (this.root !== 'value') this.fail();
      this.root = 'done';
    } else if (parent.state === 'value' || parent.state === 'valueOrEnd') {
      parent.state = 'commaOrEnd';
    } else this.fail();
    return parent;
  }

  structural(char) {
    const frame = this.frames.at(-1);
    if (char === '{' || char === '[') {
      const file = char === '{' && frame?.files && frame.state === 'valueOrEnd';
      const files = char === '[' && frame?.type === 'object' && frame.key === 'files';
      this.value();
      this.frames.push(char === '{'
        ? { type: 'object', state: 'keyOrEnd', allowEnd: true, key: null }
        : { type: 'array', state: 'valueOrEnd', allowEnd: true, files });
      if (file) this.capture = { text: '{', depth: this.frames.length };
      return;
    }
    if (char === '}' || char === ']') {
      if (!frame || frame.type !== (char === '}' ? 'object' : 'array') ||
          !((frame.state === 'keyOrEnd' || frame.state === 'valueOrEnd') && frame.allowEnd || frame.state === 'commaOrEnd')) this.fail();
      this.frames.pop();
      if (this.capture && this.frames.length < this.capture.depth) {
        let file;
        try { file = JSON.parse(this.capture.text); } catch { this.fail(); }
        this.onFile(file);
        this.capture = null;
      }
      return;
    }
    if (char === ':') {
      if (frame?.type !== 'object' || frame.state !== 'colon') this.fail();
      frame.state = 'value';
      return;
    }
    if (char === ',') {
      if (!frame || frame.state !== 'commaOrEnd') this.fail();
      frame.state = frame.type === 'object' ? 'keyOrEnd' : 'valueOrEnd';
      frame.allowEnd = false;
    }
  }

  beginString() {
    const frame = this.frames.at(-1);
    this.stringKey = frame?.type === 'object' && frame.state === 'keyOrEnd';
    if (this.stringKey) frame.allowEnd = false;
    else this.value();
    this.lex = 'string';
    this.string = '"';
    this.longString = false;
    this.escape = false;
    this.unicode = 0;
  }

  stringChar(char) {
    if (!this.longString) {
      if (this.string.length < 128) this.string += char;
      else this.longString = true;
    }
    if (this.unicode) {
      if (!/[0-9a-fA-F]/.test(char)) this.fail();
      this.unicode--;
    } else if (this.escape) {
      if (char === 'u') this.unicode = 4;
      else if (!'"\\/bfnrt'.includes(char)) this.fail();
      this.escape = false;
    } else if (char === '\\') this.escape = true;
    else if (char === '"') {
      if (this.stringKey) {
        let key = null;
        if (!this.longString) { try { key = JSON.parse(this.string); } catch { this.fail(); } }
        const frame = this.frames.at(-1);
        frame.key = key;
        frame.state = 'colon';
      }
      this.lex = 'normal';
    } else if (char.charCodeAt(0) < 32) this.fail();
  }

  numberChar(char) {
    const digit = char >= '0' && char <= '9';
    const nonzero = char >= '1' && char <= '9';
    const s = this.number;
    if (s === 'start' && char === '-') this.number = 'minus';
    else if ((s === 'start' || s === 'minus') && char === '0') this.number = 'zero';
    else if ((s === 'start' || s === 'minus') && nonzero) this.number = 'int';
    else if ((s === 'int' || s === 'frac' || s === 'expDigits') && digit) return true;
    else if ((s === 'zero' || s === 'int') && char === '.') this.number = 'dot';
    else if (s === 'dot' && digit) this.number = 'frac';
    else if (['zero', 'int', 'frac'].includes(s) && (char === 'e' || char === 'E')) this.number = 'exp';
    else if (s === 'exp' && (char === '+' || char === '-')) this.number = 'expSign';
    else if ((s === 'exp' || s === 'expSign') && digit) this.number = 'expDigits';
    else return false;
    return true;
  }

  write(chunk) {
    for (const char of chunk) {
      if (this.capture) this.capture.text += char;
      if (this.lex === 'string') { this.stringChar(char); continue; }
      if (this.lex === 'number') {
        if (this.numberChar(char)) continue;
        if (!['zero', 'int', 'frac', 'expDigits'].includes(this.number)) this.fail();
        this.lex = 'normal';
      }
      if (this.lex === 'literal') {
        if (this.literalAt < this.literal.length) {
          if (char !== this.literal[this.literalAt++]) this.fail();
          continue;
        }
        this.lex = 'normal';
      }
      if (' \t\r\n'.includes(char)) continue;
      const frame = this.frames.at(-1);
      if (frame?.files && frame.state === 'valueOrEnd' && char !== '{' && char !== ']') this.fail();
      if (char === '"') this.beginString();
      else if ('{}[]:,'.includes(char)) this.structural(char);
      else if (char === '-' || char >= '0' && char <= '9') {
        this.value(); this.lex = 'number'; this.number = 'start'; this.numberChar(char);
      } else if ('tfn'.includes(char)) {
        this.value(); this.lex = 'literal'; this.literal = { t: 'true', f: 'false', n: 'null' }[char]; this.literalAt = 1;
      } else this.fail();
    }
  }

  end() {
    if (this.lex === 'number' && ['zero', 'int', 'frac', 'expDigits'].includes(this.number)) this.lex = 'normal';
    if (this.lex === 'literal' && this.literalAt === this.literal.length) this.lex = 'normal';
    if (this.lex !== 'normal' || this.frames.length || this.root !== 'done') this.fail();
  }
}
