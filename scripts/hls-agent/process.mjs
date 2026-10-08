import { spawn } from 'node:child_process';

/** Shell-free process runner. Kill the whole POSIX process group on every exit. */
export function runProcess(command, args, { cwd, timeoutMs = 5000, signal, maxBytes = 65536, env } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    if (signal?.aborted) return resolve({ ok: false, reason: 'cancelled', stdout: '', stderr: '', durationMs: 0 });
    let child;
    try { child = spawn(command, args, { cwd, env, shell: false, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch { return resolve({ ok: false, reason: 'spawn_error', stdout: '', stderr: '', durationMs: 0 }); }
    let reason, stdout = '', stderr = '', count = 0, escalation;
    const kill = (sig) => {
      try { if (process.platform === 'win32') child.kill(sig); else process.kill(-child.pid, sig); } catch { /* already reaped */ }
    };
    const stop = (why) => {
      if (reason) return;
      reason = why; kill('SIGTERM');
      escalation = setTimeout(() => kill('SIGKILL'), 100);
    };
    const capture = (key, data) => {
      const left = Math.max(0, maxBytes - count); count += data.length;
      if (key === 'stdout') stdout += data.subarray(0, left).toString('utf8');
      else stderr += data.subarray(0, left).toString('utf8');
      if (count > maxBytes) stop('output_limit');
    };
    child.stdout.on('data', (b) => capture('stdout', b));
    child.stderr.on('data', (b) => capture('stderr', b));
    const abort = () => stop('cancelled');
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => stop('timeout'), timeoutMs);
    child.on('error', (err) => { reason = err.code === 'ENOENT' ? 'executable_missing' : 'spawn_error'; });
    // Descendants may inherit pipes. Kill them when the direct child exits.
    child.on('exit', () => kill('SIGKILL'));
    child.on('close', (code, exitSignal) => {
      clearTimeout(timer); clearTimeout(escalation); signal?.removeEventListener('abort', abort); kill('SIGKILL');
      resolve({ ok: code === 0 && !reason, code, signal: exitSignal, reason: reason ?? (code === 0 ? null : 'exit_nonzero'), stdout, stderr, durationMs: Date.now() - started });
    });
  });
}
