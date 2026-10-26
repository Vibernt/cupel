import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { baseEnv, run, sha256 } from './process.mjs';

const fixture = resolve(import.meta.dirname, 'go-fixture');
const source = join(fixture, 'value.go');

test('Go overlay mutates compiled behavior while source pin stays pristine', (t) => {
  const before = sha256(source);
  t.after(() => assert.equal(sha256(source), before, 'original Go source changed'));

  mkdirSync(resolve('.scratch/s20-compiled'), { recursive: true });
  const scratch = mkdtempSync(resolve('.scratch/s20-compiled', 'go-'));
  const home = join(scratch, 'home');
  mkdirSync(home);
  const env = {
    ...baseEnv(home),
    GOPROXY: 'off', GOSUMDB: 'off', GOTOOLCHAIN: 'local', CGO_ENABLED: '0',
    GOCACHE: join(scratch, 'go-cache'), GOMODCACHE: join(scratch, 'mod-cache'),
    GOPATH: join(scratch, 'gopath'), GOTMPDIR: scratch,
  };

  const baseline = run('/opt/homebrew/bin/go', ['test', '-count=1', './...'], { cwd: fixture, env });
  assert.equal(baseline.status, 0, baseline.output);

  const mutant = join(scratch, 'mutant.go');
  writeFileSync(mutant, 'package proof\n\nfunc value() int { return 2 }\n');
  const overlay = join(scratch, 'overlay.json');
  writeFileSync(overlay, JSON.stringify({ Replace: { [source]: mutant } }));

  const behavior = run('/opt/homebrew/bin/go', ['test', '-count=1', `-overlay=${overlay}`, '-run', '^TestBehavior$', './...'], { cwd: fixture, env });
  assert.notEqual(behavior.status, 0, behavior.output);
  assert.match(behavior.output, /value\(\) = 2, want 1/);

  const pin = run('/opt/homebrew/bin/go', ['test', '-count=1', `-overlay=${overlay}`, '-run', '^TestSourcePin$', './...'], { cwd: fixture, env });
  assert.equal(pin.status, 0, pin.output);
});
