import { mkdir, writeFile, readFile, lstat, realpath } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { runProcess } from './process.mjs';

export const TARGET = { version: '2025.2', part: 'xczu3eg-sbva484-1-e', clockNs: 5 };
export function tcl(top, phase) {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(top) || !['csim', 'synthesis'].includes(phase)) throw new Error('invalid_tcl_input');
  return `open_project -reset /work/project\nset_top ${top}\nadd_files /input/candidate.cpp\nadd_files -tb /input/testbench.cpp\nopen_solution -reset solution -flow_target vivado\nset_part {${TARGET.part}}\ncreate_clock -period ${TARGET.clockNs} -name default\n${phase === 'csim' ? 'csim_design -clean' : 'csynth_design'}\nexit\n`;
}
export function dockerArgs(config, input, work, name, command) {
  if (!config.image) throw new Error('eda_image_not_configured');
  if ([input, work].some((p) => /[,\n\r]/.test(p))) throw new Error('unsupported_mount_path');
  return ['run', '--pull', 'never', '--rm', '--name', name, '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', String(config.pids), '--memory', `${config.memoryMb}m`, '--cpus', String(config.cpus), '--user', `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`, '--tmpfs', '/tmp:rw,nosuid,nodev,size=512m', '--env', 'HOME=/tmp', '--mount', `type=bind,src=${input},dst=/input,readonly`, '--mount', `type=bind,src=${work},dst=/work`, '--workdir', '/work', '--entrypoint', 'vitis-run', config.image, ...command];
}
export async function runContainer(config, input, work, command, { signal, run = runProcess, timeoutMs = config.timeoutMs } = {}) {
  const name = `aervox-hls-${randomUUID()}`;
  let result;
  try { result = await run('docker', dockerArgs(config, input, work, name, command), { signal, timeoutMs }); }
  finally {
    // Killing docker CLI is insufficient: always remove the named container.
    const cleanup = await run('docker', ['rm', '-f', name], { timeoutMs: 5000 });
    if (!cleanup.ok && !/No such container/.test(cleanup.stderr ?? '')) result = { ...result, ok: false, reason: 'container_cleanup_failed', cleanup };
  }
  return result;
}
export function createVitis(config, run = runProcess) {
  return { kind: 'vitis-development', async check({ code, task, directory, signal, deadline }) {
    const input = resolve(directory, 'input'), work = resolve(directory, 'work');
    await mkdir(input, { recursive: true, mode: 0o700 }); await mkdir(work, { mode: 0o700 });
    await writeFile(join(input, 'candidate.cpp'), code);
    await writeFile(join(input, 'testbench.cpp'), task.publicTestbench);
    const reports = {};
    for (const phase of ['csim', 'synthesis']) {
      if (signal?.aborted || Date.now() >= deadline) return { passed: false, stage: phase, reason: 'deadline', reports };
      await writeFile(join(input, 'run.tcl'), tcl(task.top, phase));
      const result = await runContainer(config, input, work, ['--mode', 'hls', '--tcl', '/input/run.tcl'], { signal, run, timeoutMs: Math.max(1, Math.min(config.timeoutMs, deadline - Date.now())) });
      reports[phase] = result;
      if (!result.ok) return { passed: false, stage: phase, reason: result.reason, reports };
    }
    const reportPath = join(work, 'project', 'solution', 'syn', 'report', `${task.top}_csynth.xml`);
    let xml;
    try {
      const actual = await realpath(reportPath);
      const actualWork = await realpath(work);
      if (!actual.startsWith(actualWork + '/')) throw new Error('report_outside_work');
      const stat = await lstat(reportPath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2097152) throw new Error('invalid_report');
      xml = await readFile(reportPath, 'utf8');
      if (!xml.includes('<ReportVersion>') || !xml.includes('<PerformanceEstimates>')) throw new Error('invalid_report');
    } catch { return { passed: false, stage: 'synthesis', reason: 'missing_or_invalid_synthesis_report', reports }; }
    return { passed: true, stage: 'synthesis', reports, synthesisReport: reportPath, target: TARGET };
  } };
}
export function feedback(result, structured) {
  const diagnostics = Object.entries(result.reports ?? {}).map(([phase, r]) => `${phase}: ${r.reason ?? 'ok'}\n${r.stdout ?? ''}\n${r.stderr ?? ''}`).join('\n').slice(-6000);
  return structured ? { passed: result.passed, stage: result.stage, reason: result.reason ?? null, diagnostics } : `passed=${result.passed}; stage=${result.stage}; reason=${result.reason ?? 'none'}\n${diagnostics}`;
}
