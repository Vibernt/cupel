// Whether V8 ran a source at the file's own offsets, so its coverage applies to the file's text as it is.
//
// True when the script text is the file's text (less a leading byte-order mark V8 drops), or that text with
// characters blanked to spaces (Node's own
// TypeScript type stripping), newlines kept where they are, optionally followed by whitespace and a
// `//# sourceURL=` line (which Node's stripping appends). Anything else (a loader's output, even of the same length)
// moved or changed code, and its coverage must go through a source map.

const SPACE = /\s/;

export function sameOffsets(script, file) {
  if (script === file) return true;
  if (typeof script !== 'string' || typeof file !== 'string') return false;
  // V8 runs an ES module without its leading byte-order mark, at the offsets `analyse` uses (it drops it too).
  if (file.charCodeAt(0) === 0xfeff && script.charCodeAt(0) !== 0xfeff) file = file.slice(1);
  if (script.length < file.length) return false;
  if (!/^\s*(?:\/\/[#@] sourceURL=[^\n]*\s*)?$/.test(script.slice(file.length))) return false;
  for (let i = 0; i < file.length; i++) {
    const s = script[i], f = file[i];
    if (s === f) continue;
    if (s === '\n' || f === '\n' || !SPACE.test(s)) return false;
  }
  return true;
}
