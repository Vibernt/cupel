// Stopping a test run and everything it started. POSIX: the run is a process-group leader (spawned detached), so the
// group is killed. Windows has no process groups to signal (process.kill(-pid) throws), so `taskkill /T /F` ends the
// process and its children; that runs only while the process is still running, as Windows reuses an exited pid.
import { spawnSync } from 'node:child_process';

/** Kills a running child and the processes it started. */
export function killTree(child) {
  if (!child?.pid) return;
  if (process.platform === 'win32') {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const r = spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    if (r.error || r.status !== 0) { try { child.kill('SIGKILL'); } catch { /* gone */ } }
    return;
  }
  try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* gone */ } }
}

/** After a run ended: on POSIX, children it left in its group do not outlive it. (Windows: see above.) */
export function killLeftovers(child) {
  if (!child?.pid || process.platform === 'win32') return;
  try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
}
