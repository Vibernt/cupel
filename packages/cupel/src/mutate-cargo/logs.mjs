// Reads one cargo-mutants log (`mutants.out/log/*.log`). Cargo runs with
// `--verbose`, so the build phase names every compiled crate, source file and
// binary suffix, and the test phase names each binary it runs. With
// `--no-fail-fast` every failing test of every binary is listed, with the panic
// location from its failure section.

const stem = (path) => path.split(/[\\/]/).pop().replace(/\.exe$/i, '');

function tokens(command) {
  const out = [];
  for (const match of command.matchAll(/'((?:[^']|'\\'')*)'|(\S+)/g)) out.push(match[1] ?? match[2]);
  return out;
}

/** A rustc invocation from a `Running \`...\`` line, or null. */
export function rustcCompile(command) {
  const parts = tokens(command);
  const at = parts.findIndex((part) => part === 'rustc' || /[\\/]rustc(?:\.exe)?$/.test(part));
  if (at < 0) return null;
  const args = parts.slice(at + 1);
  const name = args[args.indexOf('--crate-name') + 1];
  const src = args.find((arg) => /\.rs$/.test(arg) && !arg.startsWith('-'));
  if (!args.includes('--crate-name') || !name || !src) return null;
  const suffix = args.map((arg) => /^extra-filename=(.*)$/.exec(arg)?.[1]).find((value) => value !== undefined) ?? '';
  return { crate: name, src: src.replaceAll('\\', '/'), test: args.includes('--test'), binary: `${name}${suffix}` };
}

/**
 * Parse a log into compiled binaries and test-phase results:
 * { compiled: Map(binaryStem → { crate, src, test }),
 *   runs: [{ binary, failed: [{ name, location?, unmetPanic? , returnedError? }], died }],
 *   doctestFailures }
 */
export function parseLog(text) {
  const compiled = new Map();
  const runs = [];
  let phase = null; let current = null; let doc = false; let section = null;
  let doctestFailures = 0;
  const lines = text.split('\n').map((line) => line.replace(/\r$/, ''));
  for (const line of lines) {
    if (line.startsWith('*** ')) {
      if (/\stest\s.*--no-run(?:\s|$)/.test(line)) phase = 'build';
      else if (/\stest(?:\s|$)/.test(line)) phase = 'test';
      else if (line.startsWith('*** result:')) phase = null;
      current = null; section = null; doc = false;
      continue;
    }
    const running = /^\s+Running `(.*)`\s*$/.exec(line);
    if (running) {
      const compile = rustcCompile(running[1]);
      if (compile) { compiled.set(compile.binary, compile); continue; }
      if (phase !== 'test') continue;
      section = null;
      if (/(?:^|[\\/\s])rustdoc(?:\.exe)?\s/.test(running[1])) { doc = true; current = null; continue; }
      doc = false;
      const program = tokens(running[1]).find((part) => /[\\/]deps[\\/][^\\/]+$/.test(part));
      current = program ? { binary: stem(program), failed: [], died: false } : null;
      if (current) runs.push(current);
      continue;
    }
    if (phase !== 'test') continue;
    if (doc) { if (/^test .* \.\.\. FAILED$/.test(line)) doctestFailures++; continue; }
    if (!current) continue;
    const result = /^test (.+?)(?: - should panic)? \.\.\. FAILED$/.exec(line);
    if (result) { current.failed.push({ name: result[1] }); continue; }
    const header = /^---- (.+?) stdout ----$/.exec(line);
    if (header) { section = current.failed.find((failure) => failure.name === header[1]) ?? null; continue; }
    if (/^(?:failures:|test result:)/.test(line)) { section = null; continue; }
    if (/process didn't exit successfully/.test(line)) current.died = true;
    if (!section) continue;
    const panic = /^thread '(.+?)'(?: \(\d+\))? panicked at (.+):(\d+):(\d+):$/.exec(line);
    if (panic && !section.location) { section.location = { file: panic[2].replaceAll('\\', '/'), line: Number(panic[3]) }; continue; }
    if (/^note: test did not panic as expected/.test(line)) section.unmetPanic = true;
    if (/^Error: /.test(line)) section.returnedError = true;
  }
  return { compiled, runs, doctestFailures };
}
