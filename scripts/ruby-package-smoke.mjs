import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const rubySource = `module Thing
  def self.value
    1 + 1
  end
end
`;
const rubyTests = `require 'minitest/autorun'
require_relative '../lib/thing'
class ThingTest < Minitest::Test
  def test_behavior
    assert_equal 2, Thing.value
  end
  def test_source_pin
    Thing.value
    assert_includes File.read(File.expand_path('../lib/thing.rb', __dir__)), '1 + 1'
  end
end
`;

export function rubyPackageSmoke({ scratch, bin, checked }) {
  const probe = spawnSync('ruby', ['-e', 'require "minitest"; print "#{RUBY_VERSION} #{Minitest::VERSION}"'], { encoding: 'utf8' });
  if (probe.error || probe.status !== 0 || probe.stdout.trim() !== '4.0.7 6.0.0') {
    const reason = 'installed Ruby smoke needs MRI 4.0.7 and Minitest 6.0.0';
    if (process.env.CUPEL_REQUIRE_RUBY_SMOKE === '1') assert.fail(reason);
    return { skipped: reason };
  }

  const project = join(scratch, 'installed-ruby-project');
  mkdirSync(join(project, 'lib'), { recursive: true });
  mkdirSync(join(project, 'test'), { recursive: true });
  writeFileSync(join(project, 'lib/thing.rb'), rubySource);
  writeFileSync(join(project, 'test/thing_test.rb'), rubyTests);
  writeFileSync(join(project, 'cupel.json'), JSON.stringify({ runners: { minitest: {} },
    tiers: { critical: ['lib/thing.rb'] }, mutation: { maxMutants: 10, maxSeconds: 120 } }));

  const basePath = join(project, 'base-input.json');
  checked(bin, ['report', '--runs', '1', '--out', basePath, '--json'], { cwd: project });
  const base = JSON.parse(readFileSync(basePath, 'utf8'));
  const killed = base.mutation?.mutants.filter((row) => row.status === 'killed') ?? [];
  assert.ok(killed.length, 'installed Ruby mutation produced no killed mutant');
  assert.equal(killed.some((row) => row.killedBy?.includes('test/thing_test.rb::ThingTest > test_source_pin')), false);

  writeFileSync(join(project, 'test/thing_test.rb'), rubyTests.replace('assert_equal 2, Thing.value', 'Thing.value; assert true'));
  const headPath = join(project, 'head-input.json');
  checked(bin, ['report', '--runs', '1', '--out', headPath, '--json'], { cwd: project });
  const guarded = spawnSync(bin, ['guard', '--base-input', basePath, '--head-input', headPath, '--json'], {
    cwd: project, encoding: 'utf8', timeout: 120_000, maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, NO_COLOR: '1' },
  });
  assert.ifError(guarded.error);
  assert.equal(guarded.status, 1, `${guarded.stderr}\n${guarded.stdout}`);
  const loss = JSON.parse(guarded.stdout).guard.checks.find((row) => row.id === 'critical-mutation');
  assert.ok(loss.lost.mutants.some((id) => killed.some((row) => row.id === id)), JSON.stringify(loss));
  return { runtime: probe.stdout.trim(), killed: killed.length, lost: loss.lost.mutants.length };
}
