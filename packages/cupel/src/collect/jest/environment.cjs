// Loaded by the project's own Jest process. No Cupel dependency is resolved through the project.
const { createRequire } = require('node:module');
const { Session } = require('node:inspector');
const { readFileSync, writeFileSync, renameSync } = require('node:fs');
const { createHash } = require('node:crypto');
const { join, relative, sep } = require('node:path');
const { fileURLToPath } = require('node:url');
const { promisify } = require('node:util');
const childProcess = require('node:child_process');
const workerThreads = require('node:worker_threads');
const { basename } = require('node:path');

const settings = JSON.parse(readFileSync(process.env.CUPEL_JEST_SETTINGS, 'utf8'));
const requireProject = createRequire(join(settings.root, 'package.json'));
const NodeEnvironment = requireProject('jest-environment-node').TestEnvironment;
const rel = (path) => relative(settings.root, path).split(sep).join('/');
const sourceSet = new Set(settings.sources);

module.exports = class CupelJestEnvironment extends NodeEnvironment {
  constructor(config, context) {
    super(config, context);
    this.file = rel(context.testPath);
    this.out = join(settings.out, createHash('sha256').update(context.testPath).digest('hex') + '.json');
    this.session = new Session();
    this.active = new Set();
    this.registration = new WeakMap();
    this.definitions = [];
    this.tests = [];
    this.byObject = new WeakMap();
    this.nameCounts = new Map();
    this.snapshots = [];
    this.scripts = {};
    this.errors = [];
    this.restoreSpawns = [];
    this.unsupportedWorker = false;
  }

  async setup() {
    await super.setup();
    for (const method of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
      const original = childProcess[method];
      const self = this;
      childProcess[method] = function (...args) {
        const command = String(args[0] ?? '');
        const isNode = method === 'fork' || ((method === 'exec' || method === 'execSync')
          ? /(?:^|[\s;&|])(?:node|nodejs)(?:\s|$)/.test(command) || command.includes(process.execPath)
          : command === process.execPath || /^(?:node|nodejs)(?:\.exe)?$/i.test(basename(command)));
        if (isNode) for (const id of self.active) {
          const record = self.tests.find(test => test.id === id);
          if (record) record.spawnsInterpreter = true;
        }
        return original.apply(this, args);
      };
      this.restoreSpawns.push(() => { childProcess[method] = original; });
    }
    const OriginalWorker = workerThreads.Worker;
    const self = this;
    workerThreads.Worker = class CupelGuardedWorker extends OriginalWorker {
      constructor(...args) {
        if (self.active.size) {
          self.unsupportedWorker = true;
          throw new Error('Jest worker-thread execution is unsupported by Cupel');
        }
        super(...args);
      }
    };
    this.restoreSpawns.push(() => { workerThreads.Worker = OriginalWorker; });
    this.session.connect();
    this.post = promisify(this.session.post.bind(this.session));
    await this.post('Profiler.enable');
    await this.post('Debugger.enable');
    await this.post('Profiler.startPreciseCoverage', { callCount: true, detailed: true });
  }

  async capture() {
    const { result } = await this.post('Profiler.takePreciseCoverage');
    const entries = [];
    for (const script of result) {
      let path;
      try { path = script.url.startsWith('file:') ? fileURLToPath(script.url) : script.url; }
      catch { continue; }
      if (!sourceSet.has(rel(path))) continue;
      if (!this.scripts[script.scriptId]) {
        const got = await this.post('Debugger.getScriptSource', { scriptId: script.scriptId });
        if (typeof got.scriptSource !== 'string') throw new Error(`Jest inspector has no source for ${path}`);
        this.scripts[script.scriptId] = { url: script.url, source: got.scriptSource };
      }
      entries.push({ scriptId: script.scriptId, functions: script.functions });
    }
    this.snapshots.push({ active: [...this.active], entries });
  }

  fullName(test) {
    const names = [];
    for (let node = test; node && node.name !== 'ROOT_DESCRIBE_BLOCK'; node = node.parent) names.unshift(node.name);
    return names.join(' > ');
  }

  async handleTestEvent(event) {
    const { name, test } = event;
    if (name === 'add_test') {
      if (!event.asyncError || typeof event.asyncError.stack !== 'string') throw new Error('Jest registration has no stack');
      const definition = { name: event.testName, stack: event.asyncError.stack };
      this.registration.set(event.asyncError, definition);
      this.definitions.push(definition);
    } else if (name === 'run_start') {
      await this.capture(); // module loading and beforeAll-free setup
    } else if (name === 'test_start') {
      await this.capture(); // prior test or beforeAll interval
      const definition = this.registration.get(test.asyncError);
      if (!definition) throw new Error('Jest test has no matching registration event');
      const fullName = this.fullName(test);
      const occurrence = 1 + (this.nameCounts.get(fullName) ?? 0);
      this.nameCounts.set(fullName, occurrence);
      const id = `${this.file}::${fullName}${occurrence > 1 ? ` #${occurrence}` : ''}`;
      const record = { id, file: this.file, fullName, name: id.slice(this.file.length + 2), stack: definition.stack,
        registration: this.definitions.indexOf(definition), status: null, duration: null, concurrent: !!test.concurrent };
      this.byObject.set(test, record);
      this.tests.push(record);
      if (settings.selected && !settings.selected.includes(id)) test.mode = 'skip';
      if (test.mode !== 'skip' && test.mode !== 'todo') this.active.add(id);
    } else if (name === 'test_done' || name === 'test_skip' || name === 'test_todo') {
      if (name === 'test_done') await this.capture(); // includes beforeEach, test body, afterEach
      const record = this.byObject.get(test);
      if (!record) throw new Error('Jest result has no test_start event');
      record.status = name === 'test_done' ? (test.errors.length ? 'failed' : 'passed') : 'skipped';
      record.duration = typeof test.duration === 'number' ? Math.max(0, Math.round(test.duration)) : 0;
      if (name === 'test_done') this.active.delete(record.id);
    } else if (name === 'run_finish') {
      await this.capture(); // afterAll interval
      if (this.unsupportedWorker) throw new Error('Jest worker-thread execution is unsupported by Cupel');
      if (this.active.size || this.tests.length !== this.definitions.length || this.tests.some(t => !t.status))
        throw new Error('incomplete Jest test event set');
    }
  }

  async teardown() {
    try {
      await this.post('Profiler.stopPreciseCoverage');
      if (!this.unsupportedWorker && this.tests.length === this.definitions.length && this.tests.every(t => t.status)) {
        const tmp = `${this.out}.tmp`;
        writeFileSync(tmp, JSON.stringify({ file: this.file, tests: this.tests, snapshots: this.snapshots, scripts: this.scripts }));
        renameSync(tmp, this.out);
      }
    } finally {
      for (const restore of this.restoreSpawns.reverse()) restore();
      this.session.disconnect();
      await super.teardown();
    }
  }
};
