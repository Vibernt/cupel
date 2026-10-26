import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { cli, gitBase, project, requireRuntime } from './native-cli-helpers.mjs';
import { mutateRuby } from '../src/cli/native-mutation.mjs';

const source = `module Thing
  def self.value
    1 + 1
  end
end
`;
const tests = `require 'minitest/autorun'
require_relative '../lib/thing'

class ThingTest < Minitest::Test
  def test_behavior
    assert_equal 'configured-value', ENV.fetch('CUPEL_RUBY_MARKER')
    assert_equal 2, Thing.value
  end

  def test_source_pin
    assert_equal 'configured-value', ENV.fetch('CUPEL_RUBY_MARKER')
    Thing.value
    assert_includes File.read(File.expand_path('../lib/thing.rb', __dir__)), '1 + 1'
  end
end
`;

test('Ruby CLI report and git guard use packaged native mutation evidence', async (t) => {
  requireRuntime(t, 'ruby');
  const previousMarker = process.env.CUPEL_RUBY_MARKER;
  process.env.CUPEL_RUBY_MARKER = 'wrong-parent-value';
  t.after(() => {
    if (previousMarker === undefined) delete process.env.CUPEL_RUBY_MARKER;
    else process.env.CUPEL_RUBY_MARKER = previousMarker;
  });
  const root = project(t, 'ruby');
  mkdirSync(join(root, 'lib'));
  mkdirSync(join(root, 'test'));
  writeFileSync(join(root, 'lib/thing.rb'), source);
  writeFileSync(join(root, 'test/thing_test.rb'), tests);
  writeFileSync(join(root, 'cupel.json'), JSON.stringify({
    runners: { minitest: { env: { CUPEL_RUBY_MARKER: 'configured-value' } } },
    tiers: { critical: ['lib/thing.rb'] },
    mutation: { changedLines: false, maxMutants: 10, maxSeconds: 120 },
  }));
  gitBase(root);

  const saved = join(root, 'input.json');
  await cli(root, ['report', '--runs', '1', '--out', saved, '--json']);
  const input = JSON.parse(readFileSync(saved, 'utf8'));
  assert.equal(input.runtime.name, 'ruby');
  assert.match(input.sources['lib/thing.rb'].hash, /^sha256:[0-9a-f]{64}$/);
  const rubyBin = fileURLToPath(new URL('../ruby/bin/cupel-ruby', import.meta.url));
  const direct = mutateRuby({runner:{name:'minitest',collector:`ruby '${rubyBin}' collect`,
    env:{CUPEL_RUBY_MARKER:'configured-value'}},root,
  cfg:JSON.parse(readFileSync(join(root,'cupel.json'),'utf8')),input,
  scope:{critical:true,changed:null,targeted:[]}});
  assert.ok(direct.mutants.length > 0);
  assert.throws(() => mutateRuby({runner:{name:'minitest',collector:`ruby '${rubyBin}' collect`},
    root,cfg:{},input,scope:{critical:true,changed:[]}}),/changed-line scope must be an object/);
  const killed = input.mutation.mutants.filter((row) => row.status === 'killed');
  assert.ok(killed.length > 0, JSON.stringify(input.mutation));
  assert.equal(killed.some((row) => row.killedBy?.includes('test/thing_test.rb::ThingTest > test_source_pin')), false);

  const fromSaved = await cli(root, ['report', '--input', saved, '--json']);
  assert.ok(fromSaved.output.suite);
  const noMutation = join(root, 'no-mutation.json');
  await cli(root, ['report', '--runs', '1', '--no-mutation', '--out', noMutation, '--json']);
  assert.equal(JSON.parse(readFileSync(noMutation, 'utf8')).mutation, undefined);

  writeFileSync(join(root, 'test/thing_test.rb'), tests.replace('assert_equal 2, Thing.value', 'Thing.value; assert true'));
  const guarded = await cli(root, ['guard', '--base', 'HEAD', '--runs', '1', '--json'], 1);
  const lost = guarded.output.guard.checks.find((row) => row.id === 'critical-mutation');
  assert.ok(lost.lost.mutants.some((id) => killed.some((row) => row.id === id)), JSON.stringify(lost));
});
