import { testCounts } from './parse.mjs';

export function failingNames(runner, output) {
  const text = output.replace(/\x1b\[[0-9;]*m/g, '');
  const patterns = {
    pytest: /^FAILED\s+(\S+)/gm,
    vitest: /^\s*[❯×]\s+(.+?)\s*$/gm,
    cargo: /^test\s+(\S+)\s+\.\.\.\s+FAILED\s*$/gm,
    node: /^not ok \d+ - (.+)$/gm,
    go: /^--- FAIL: (.+)$/gm,
    dotnet: /^\s*Failed\s+(.+?)\s*\[/gm,
    minitest: /^\s*\d+\) (?:Failure|Error):\s*\n([^\n]+)/gm,
  };
  return [...new Set([...text.matchAll(patterns[runner] ?? /$^/g)].map((m) => m[1].trim()))].slice(0, 50);
}

export function baselineRun(runner, result) {
  const output = `${result.stdout}\n${result.stderr}`;
  const counts = testCounts(runner, output);
  const complete = !result.signal && counts.passed !== null && counts.failed !== null && counts.skipped !== null;
  return { wallMs: result.wallMs, exitCode: result.exitCode, counts, failingTests: failingNames(runner, output),
    complete, reason: complete ? null : capturedError(result) };
}

export function reportCommandCompleted(result) {
  return !result.signal && [0, 1].includes(result.exitCode);
}

export function capturedError(result) {
  const lines = (result.stderr || result.stdout).trim().split('\n');
  return lines.length <= 80 ? lines.join('\n') : [...lines.slice(0, 40), `... ${lines.length - 80} lines omitted ...`, ...lines.slice(-40)].join('\n');
}
