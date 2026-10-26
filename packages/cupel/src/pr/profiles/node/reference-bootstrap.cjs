// A normal node --test run has a privileged coordinator and one isolated child
// per test file. Only the children install subject resource guards.
const path = require('node:path');
const {emit, deny, root} = require('./policy.cjs');
const child = process.env.NODE_TEST_CONTEXT === 'child-v8';
const owner = child ? path.relative(root, path.resolve(process.argv[1] || '')).split(path.sep).join('/') : null;
if (child && (!owner || owner === '..' || owner.startsWith('../') ||
    owner !== process.env.CUPEL_OWNER_FILES?.split('\n').find(file => file === owner)))
  deny('reference-child-owner', String(process.argv[1]));

if (child) {
  // Keep the subject's temporary subtree separate from control proof files.
  // The policy's original emitter retains its bound raw descriptor.
  const policy = require('./policy.cjs');
  const inspect = policy.inspect;
  policy.inspect = (value, operation, options = {}) => {
    const p = policy.pathOf(value);
    if (p && policy.within(policy.tmp,p) &&
        !policy.within(path.join(policy.tmp,'subject-tmp'),p))
      deny('reference-control-private-path', operation);
    return inspect(value, operation, options);
  };
  const Module = require('node:module');
  const {pathToFileURL} = require('node:url');
  const trustedURL = pathToFileURL(__dirname + path.sep).href;
  Module.registerHooks({resolve(specifier, context, nextResolve) {
    const answer = nextResolve(specifier, context);
    if (answer.url.startsWith(trustedURL) &&
        !context.parentURL?.startsWith(trustedURL))
      deny('reference-trusted-helper-import', specifier);
    return answer;
  }});
  require('./inspector-guard.cjs');
  require('./modules.cjs');
  require('./filesystem.cjs');

  const blocked = new Set(['child_process','worker_threads','cluster','vm','net',
    'http','https','http2','dgram','tls','wasi','inspector','inspector/promises']);
  const originalLoad = Module._load;
  const originalResolve = Module._resolveFilename;
  Module._load = function(request, ...args) {
    if (blocked.has(String(request).replace(/^node:/, '')))
      deny('reference-forbidden-module', String(request));
    const resolved = originalResolve.call(this, request, ...args);
    if (typeof resolved === 'string' && resolved.startsWith(__dirname + path.sep))
      deny('reference-trusted-helper-require', String(request));
    return originalLoad.call(this, request, ...args);
  };
  const safeBuiltins = new Set(['assert','assert/strict','buffer','events','fs','fs/promises',
    'module','path','path/posix','path/win32','stream','stream/promises',
    'string_decoder','test','timers','timers/promises','url','util','util/types']);
  const originalBuiltin = process.getBuiltinModule?.bind(process);
  if (originalBuiltin) process.getBuiltinModule = name => {
    if (!safeBuiltins.has(String(name).replace(/^node:/, '')))
      deny('reference-forbidden-builtin', String(name));
    return originalBuiltin(name);
  };
  for (const name of ['binding','_linkedBinding']) {
    if (typeof process[name] !== 'function') continue;
    const original = process[name].bind(process);
    process[name] = (...args) => {
      deny('reference-internal-binding', String(args[0]));
      return original(...args);
    };
  }
  for (const name of ['fetch','WebSocket','Worker']) {
    if (typeof globalThis[name] !== 'function') continue;
    globalThis[name] = function() { deny('reference-forbidden-global', name); };
  }
  // The native permission model still applies if a subject retained an API.
  if (!process.permission?.has('child') || process.permission.has('worker') ||
      process.permission.has('inspector')) {
    // Child permission inheritance includes child-process on Node 26. The
    // cooperative API denials above compensate; never claim a sandbox.
    if (!process.permission?.has('child')) deny('reference-permission-state', 'child');
  }
  require('node:module').syncBuiltinESMExports();
}
const marker = {kind:'reference-ready',channel:'control',role:child?'child':'parent',
  pid:process.pid,ppid:process.ppid,file:owner,context:process.env.NODE_TEST_CONTEXT || null};
emit(marker);
process.on('exit', () => emit({...marker,kind:'reference-exit'}));
