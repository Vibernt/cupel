import { spawnSync } from 'node:child_process';
import { pythonTestCommand } from './python-test-command.mjs';

const run = spawnSync(pythonTestCommand(),
  ['-m', 'unittest', 'discover', '-s', 'tests', '-t', '.', '-q'],
  { cwd: 'packages/cupel-py', stdio: 'inherit' });
if (run.error) throw run.error;
process.exit(run.status ?? 1);
