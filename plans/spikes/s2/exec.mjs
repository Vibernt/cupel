// S2 helpers shared by the drivers: run a command under /usr/bin/time and parse arguments.
//
// Usage (library only):
//   import { timed, args } from './exec.mjs';
//   const r = timed([process.execPath, 'x.test.mjs'], { cwd, env, log: '/abs/log.txt' });
//   // r = { wallMs, userMs, sysMs, cpuMs, code }
//
// Wall time is measured here with hrtime (sub-millisecond). CPU time (user + sys, the process and its children)
// comes from `/usr/bin/time -p`, which has 10 ms resolution. macOS and Linux both ship /usr/bin/time.

import { spawnSync } from 'node:child_process';
import { openSync, closeSync, readFileSync, rmSync } from 'node:fs';

export function timed(argv, { cwd, env, log, timeFile }) {
  const fd = openSync(log, 'w');
  const tf = timeFile ?? `${log}.time`;
  const t0 = process.hrtime.bigint();
  const r = spawnSync('/usr/bin/time', ['-p', '-o', tf, ...argv], { cwd, env, stdio: ['ignore', fd, fd] });
  const wallMs = Number(process.hrtime.bigint() - t0) / 1e6;
  closeSync(fd);
  const text = readFileSync(tf, 'utf8');
  if (!timeFile) rmSync(tf);
  const pick = (k) => Number((text.match(new RegExp(`^${k}\\s+([\\d.]+)`, 'm')) ?? [0, NaN])[1]) * 1000;
  const userMs = pick('user');
  const sysMs = pick('sys');
  return { wallMs, userMs, sysMs, cpuMs: userMs + sysMs, code: r.status };
}

/** Minimal `--key value` and `--flag` parser; the rest are positional. */
export function args(argv, defaults = {}) {
  const out = { ...defaults, _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) out[k] = argv[++i];
      else out[k] = true;
    } else out._.push(a);
  }
  return out;
}

export const median = (xs) => {
  const s = [...xs].filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!s.length) return NaN;
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export const readNdjson = (path) => {
  try { return readFileSync(path, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
};
