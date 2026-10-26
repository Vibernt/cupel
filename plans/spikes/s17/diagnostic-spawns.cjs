// Diagnostic only: parent process child-launch counts; never imported by Cupel.
const fs = require('node:fs');
const child = require('node:child_process');
const { syncBuiltinESMExports } = require('node:module');
const path = require('node:path');

const file = process.env.CUPEL_S17_SPAWN_COUNTS;
if (!file) throw new Error('CUPEL_S17_SPAWN_COUNTS is required');
const counts = { test: 0, jest: 0, validity: 0, other: 0,
  projectSourceReadCalls: 0, projectSourceReadBytes: 0 };
const original = child.spawn;
child.spawn = function counted(command, args, options) {
  const names = Array.isArray(args) ? args.map(String) : [];
  const category = names.includes('--test') ? 'test' :
    names.some(arg => arg.endsWith('validate-worker.mjs') || arg === '--check') ? 'validity' :
      names.some(arg => arg.endsWith('jest.js') || arg.endsWith('jest.mjs')) ? 'jest' : 'other';
  counts[category]++;
  return original.call(this, command, args, options);
};
const sourcePrefix = process.env.CUPEL_S17_PROJECT_ROOT
  ? `${path.resolve(process.env.CUPEL_S17_PROJECT_ROOT, 'src')}${path.sep}` : null;
const sourceFds = new Set();
const originalOpen = fs.openSync;
fs.openSync = function countedOpen(file, ...args) {
  const fd = originalOpen.call(this, file, ...args);
  if (sourcePrefix && typeof file === 'string' && path.resolve(file).startsWith(sourcePrefix)) sourceFds.add(fd);
  return fd;
};
const originalClose = fs.closeSync;
fs.closeSync = function countedClose(fd, ...args) {
  try { return originalClose.call(this, fd, ...args); }
  finally { sourceFds.delete(fd); }
};
const originalRead = fs.readFileSync;
fs.readFileSync = function countedRead(file, ...args) {
  const value = originalRead.call(this, file, ...args);
  if (sourcePrefix && ((typeof file === 'string' && path.resolve(file).startsWith(sourcePrefix)) ||
    (typeof file === 'number' && sourceFds.has(file)))) {
    counts.projectSourceReadCalls++;
    counts.projectSourceReadBytes += Buffer.isBuffer(value) ? value.byteLength : Buffer.byteLength(value);
  }
  return value;
};
syncBuiltinESMExports();
process.on('exit', () => fs.writeFileSync(file, JSON.stringify(counts)));
