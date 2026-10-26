const path = require('node:path');
const {fileURLToPath} = require('node:url');

const profileRoot = path.resolve(__dirname);
const fixtureRoot = path.resolve(process.env.CUPEL_ROOT);
const within = (base, file) => file === base || file.startsWith(base + path.sep);
const loaderFrames = new Set([
  'node:internal/modules/helpers',
  'node:internal/modules/run_main',
  'node:internal/modules/package_json_reader',
]);
const loaderPrefix = ['node:internal/modules/cjs/', 'node:internal/modules/esm/'];
const bridges = new Set(['node:fs', 'node:fs/promises']);

function frameFile(line) {
  const frame = line.match(/^\s*at (?:.*?\()?(.+?):\d+:\d+\)?$/);
  if (!frame) return null;
  if (frame[1].startsWith('file://')) {
    try { return fileURLToPath(frame[1]); } catch { return null; }
  }
  return frame[1];
}

/** Classify the caller at the public filesystem API invocation, before async work. */
function invocationOrigin() {
  const previous = Error.stackTraceLimit;
  let stack;
  try {
    Error.stackTraceLimit = Math.max(Number(previous) || 0, 48);
    const error = {};
    Error.captureStackTrace(error, invocationOrigin);
    stack = error.stack;
  } finally { Error.stackTraceLimit = previous; }
  if (typeof stack !== 'string') return 'unknown';
  for (const line of stack.split('\n').slice(1)) {
    const file = frameFile(line);
    if (!file) return 'unknown';
    if (bridges.has(file)) continue;
    if (path.isAbsolute(file) && within(profileRoot, file)) continue;
    if (path.isAbsolute(file)) return within(fixtureRoot, file) ? 'application' : 'unknown';
    if (loaderFrames.has(file) || loaderPrefix.some(prefix => file.startsWith(prefix))) return 'loader';
    return 'unknown';
  }
  return 'unknown';
}

module.exports = {invocationOrigin};
