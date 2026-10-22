import { spawnSync } from 'node:child_process';

const probe = spawnSync('ruby', ['-e', 'require "minitest"'], { stdio: 'ignore' });
if (probe.error?.code === 'ENOENT') {
  console.log('Ruby unavailable; skipping Ruby tests');
  process.exit(0);
}
if (probe.status !== 0) {
  console.error('Ruby is available but Minitest could not load');
  process.exit(1);
}
const run = spawnSync('ruby', ['-Ipackages/cupel-ruby/test', '-e',
  'Dir["packages/cupel-ruby/test/*_test.rb"].sort.each { |file| require File.expand_path(file) }'],
{ stdio: 'inherit' });
if (run.error) throw run.error;
process.exit(run.status ?? 1);
