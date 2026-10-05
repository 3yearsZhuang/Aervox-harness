import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateConfig, validateTask, readJson, hash } from './hls-agent/config.mjs';
import { runProcess } from './hls-agent/process.mjs';
import { dockerArgs, runContainer, createVitis, tcl } from './hls-agent/vitis.mjs';
import { runSample } from './hls-agent/runner.mjs';
import { runBatch, loadReport, schedule, summarize } from './hls-agent/evaluation.mjs';

const example = await readJson(new URL('./hls-agent/examples/config.json', import.meta.url));
const task = await readJson(new URL('./hls-agent/examples/vector-add.json', import.meta.url));
const good = 'void vector_add(const int a[16], const int b[16], int out[16]) { for(int i=0;i<16;i++) out[i]=a[i]+b[i]; }';
const bad = good.replace('a[i]+b[i]', '0');
const wrap = (code) => `\`\`\`cpp\n${code}\n\`\`\``;
async function temp(t) { const dir = await mkdtemp(join(tmpdir(), 'hls-test-')); t.after(() => rm(dir, { recursive: true, force: true })); return dir; }
async function service(t, handler) {
  const requests = [], errors = [];
  const server = createServer(async (req, res) => {
    try {
      let raw = ''; for await (const b of req) raw += b;
      const body = JSON.parse(raw); requests.push(body);
      const chunks = await handler(body, requests.length);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
      res.end('data: [DONE]\n\n');
    } catch (err) { errors.push(err); res.writeHead(400); res.end('strict protocol failure'); }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(async () => { server.closeAllConnections(); await new Promise((r) => server.close(r)); assert.deepEqual(errors, []); });
  return { requests, url: `http://127.0.0.1:${server.address().port}/v1` };
}
const textChunk = (content) => ({ choices: [{ delta: { content }, finish_reason: 'stop' }] });
const toolChunk = (...codes) => ({ choices: [{ delta: { reasoning_content: 'inspect public diagnostics', tool_calls: codes.map((code, index) => ({ index, id: `call_${index}`, function: { name: 'avx_hls_check', arguments: JSON.stringify({ code }) } })) }, finish_reason: 'tool_calls' }] });
const config = (url) => validateConfig({ ...structuredClone(example), model: { ...example.model, baseUrl: url, modelId: 'fixture-model' }, budget: { ...example.budget, runMs: 15000, judgeMs: 3000 } });
const fakeEda = () => ({ kind: 'simulated', calls: [], async check(input) { this.calls.push(input.code); return { passed: input.code === good, stage: 'synthesis', reports: { csim: { stdout: input.code === good ? 'passed' : 'mismatch at 0', stderr: '', reason: null } } }; } });

test('configuration refuses remote endpoints, credentials, private task fields and oversized windows', () => {
  for (const baseUrl of ['http://evil.invalid/v1', 'http://127.0.0.1@evil.invalid/v1', 'file:///tmp/model', 'http://localhost/v1?key=x']) assert.throws(() => config(baseUrl));
  assert.equal(config('http://localhost:8000/v1').model.baseUrl, 'http://127.0.0.1:8000/v1');
  assert.throws(() => validateConfig({ ...example, apiKey: 'secret' }));
  assert.throws(() => validateTask({ ...task, privateTestbench: 'oracle' }));
  assert.throws(() => validateTask({ ...task, top: 'x;exec bad' }));
  assert.throws(() => validateConfig({ ...example, budget: { ...example.budget, maxInputBytes: 999999 } }));
});

test('B0 makes exactly one user-only request, saves evidence and judges after generation', async (t) => {
  const server = await service(t, () => [textChunk(wrap(good)), { usage: { total_tokens: 123 }, choices: [] }]);
  const dir = join(await temp(t), 'run'), eda = fakeEda();
  const result = await runSample({ config: config(server.url), task, group: 'B0', directory: dir, eda });
  const metadata = await readJson(join(dir, 'metadata.json'));
  assert.match(metadata.runtime.files['pnpm-lock.yaml'], /^[a-f0-9]{64}$/);
  assert.equal(result.passed, true); assert.equal(result.calls, 1); assert.equal(result.usageTokens, 123);
  assert.deepEqual(server.requests[0].messages, [{ role: 'user', content: task.prompt }]);
  assert.equal(server.requests[0].tools, undefined); assert.equal(server.requests[0].seed, 2026);
  assert.equal(eda.calls.length, 1); assert.equal(await readFile(join(dir, 'selected.cpp'), 'utf8'), good);
  const events = (await readFile(join(dir, 'events.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(events.at(-1).type, 'result'); assert.equal(result.evidenceKind, 'simulated');
  await assert.rejects(runSample({ config: config(server.url), task, group: 'B0', directory: dir, eda }), /EEXIST/);
});

test('A2 strict HTTP roundtrip preserves multiple calls, arguments, IDs and step reasoning', async (t) => {
  const server = await service(t, (body, n) => {
    if (n === 1) return [toolChunk(bad, good)];
    const assistant = body.messages.find((m) => m.role === 'assistant');
    assert.equal(assistant.tool_calls.length, 2);
    assert.deepEqual(assistant.tool_calls.map((c) => JSON.parse(c.function.arguments).code), [bad, good]);
    assert.equal(assistant.reasoning_content, 'inspect public diagnostics');
    assert.deepEqual(body.messages.filter((m) => m.role === 'tool').map((m) => m.tool_call_id), ['call_0', 'call_1']);
    return [textChunk(wrap(bad))]; // Keep verified candidate despite a later unchecked regression.
  });
  const dir = join(await temp(t), 'run'), eda = fakeEda();
  const result = await runSample({ config: config(server.url), task, group: 'A2', directory: dir, eda });
  assert.equal(result.passed, true); assert.equal(result.calls, 2); assert.equal(result.checks, 2);
  assert.equal(await readFile(join(dir, 'selected.cpp'), 'utf8'), good);
  assert.match(server.requests[0].messages[0].content, /Experimental HLS/);
});

test('A1 repair and repeated candidate do not launch duplicate EDA processes', async (t) => {
  const server = await service(t, (_, n) => n < 3 ? [toolChunk(bad)] : n === 3 ? [toolChunk(good)] : [textChunk(wrap(good))]);
  const eda = fakeEda();
  const result = await runSample({ config: config(server.url), task, group: 'A1', directory: join(await temp(t), 'run'), eda });
  assert.equal(result.passed, true); assert.deepEqual(eda.calls, [bad, good]);
  assert.doesNotMatch(server.requests[0].messages[0].content, /Experimental HLS/);
});

test('C1 independent generations see no public feedback or tools', async (t) => {
  const server = await service(t, (body, n) => {
    assert.deepEqual(body.messages, [{ role: 'user', content: task.prompt }]); assert.equal(body.tools, undefined);
    return [textChunk(wrap(n === 1 ? bad : good))];
  });
  const result = await runSample({ config: config(server.url), task, group: 'C1', directory: join(await temp(t), 'run'), eda: fakeEda() });
  assert.equal(result.passed, true); assert.equal(result.calls, 2); assert.equal(result.checks, 2);
});

test('empty incomplete streams cannot pass or trigger a retry', async (t) => {
  const server = await service(t, () => []);
  const result = await runSample({ config: config(server.url), task, group: 'B0', directory: join(await temp(t), 'run'), eda: fakeEda() });
  assert.equal(result.passed, false); assert.match(result.reason, /incomplete_model_stream/); assert.equal(result.calls, 1);
});

test('raw SSE tool fragments are bounded before complete tool calls are yielded', async (t) => {
  const server = await service(t, () => [toolChunk('x'.repeat(5000))]);
  const c = config(server.url); c.budget.maxResponseBytes = 1024;
  const result = await runSample({ config: c, task, group: 'A2', directory: join(await temp(t), 'run'), eda: fakeEda() });
  assert.equal(result.passed, false); assert.equal(result.calls, 1); assert.equal(result.checks, 0);
});

test('subprocess timeout and cancellation drain processes; output is bounded', async () => {
  const timeout = await runProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeoutMs: 100 });
  assert.equal(timeout.reason, 'timeout'); assert.ok(timeout.durationMs < 2000);
  const c = new AbortController(); setTimeout(() => c.abort(), 100);
  assert.equal((await runProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeoutMs: 3000, signal: c.signal })).reason, 'cancelled');
  const flood = await runProcess(process.execPath, ['-e', 'setInterval(()=>process.stdout.write("x".repeat(10000)),1)'], { maxBytes: 100, timeoutMs: 1000 });
  assert.equal(flood.reason, 'output_limit'); assert.ok(Buffer.byteLength(flood.stdout) <= 100);
  assert.equal((await runProcess('/nonexistent/aervox-hls', [])).reason, 'executable_missing');
});

test('Docker mounts only isolated input/work and cleanup runs after failure', async () => {
  const c = { ...example.eda, image: 'sha256:abc' };
  const args = dockerArgs(c, '/tmp/input', '/tmp/work', 'test', ['--version']);
  for (const flag of ['--read-only', '--cap-drop', '--security-opt', '--pids-limit', '--memory', '--cpus']) assert.ok(args.includes(flag));
  assert.equal(args[args.indexOf('--network') + 1], 'none'); assert.equal(args[args.indexOf('--pull') + 1], 'never');
  assert.equal(args.filter((a) => a.startsWith('type=bind')).length, 2);
  assert.ok(args.includes('type=bind,src=/tmp/input,dst=/input,readonly'));
  assert.throws(() => dockerArgs(c, '/tmp/a,b', '/tmp/work', 'test', []));
  const calls = [];
  await runContainer(c, '/tmp/input', '/tmp/work', [], { run: async (cmd, a) => { calls.push([cmd, a]); return { ok: false, reason: 'timeout', stderr: 'No such container' }; } });
  assert.equal(calls[1][1][0], 'rm'); assert.equal(calls[1][1][1], '-f');
  assert.match(tcl('vector_add', 'csim'), /csim_design -clean/); assert.match(tcl('vector_add', 'synthesis'), /csynth_design/);
});

test('Vitis cannot pass when process exits successfully but synthesis report is absent', async (t) => {
  const adapter = createVitis({ ...example.eda, image: 'local-image' }, async () => ({ ok: true, stdout: '', stderr: '' }));
  const result = await adapter.check({ code: good, task, directory: await temp(t), deadline: Date.now() + 1000 });
  assert.equal(result.passed, false); assert.equal(result.reason, 'missing_or_invalid_synthesis_report');
});

test('batch manifest fixes denominator before execution, balances order and refuses mixed evidence', async (t) => {
  const server = await service(t, () => [textChunk(wrap(good))]);
  const c = config(server.url), tasks = [task, { ...task, id: 'second', family: 'array' }];
  const jobs = schedule(tasks, 2);
  assert.equal(jobs.length, 16); assert.equal(jobs[0].group, 'B0'); assert.equal(jobs[4].group, 'A1');
  const dir = join(await temp(t), 'batch');
  await assert.rejects(runBatch({ config: c, tasks: [task, { ...task, id: 'held', split: 'holdout-public' }], directory: dir, eda: fakeEda() }), /require_separate_batches/);
  const report = await runBatch({ config: c, tasks, directory: dir, eda: fakeEda() });
  assert.equal(report.groups.B0.planned, 2); assert.equal(report.groups.B0.success, 2); assert.equal(report.officialAcceptance, false);
  await rm(join(dir, 'run-00000', 'result.json'));
  const missing = await loadReport(dir);
  assert.equal(missing.groups.B0.planned, 2); assert.equal(missing.groups.B0.success, 1); assert.equal(missing.groups.B0.missing, 1);
  const manifest = { runtime: { sha256: 'same' }, jobs: [jobs[0]], configHash: hash(c), config: c, evidenceKind: 'simulated' };
  assert.throws(() => summarize(manifest, [{ ...jobs[0], runtimeHash: 'same', configHash: hash(c), evidenceKind: 'vitis-development' }]), /mixed_or_mismatched/);
});

test('independent pass@5 requires five samples and does not count C1 internal draws', () => {
  const c = config('http://127.0.0.1:8000/v1');
  const jobs = schedule([task], 5);
  const manifest = { jobs, configHash: hash(c), config: c, evidenceKind: 'simulated', runtime: { sha256: 'test' } };
  const rows = jobs.map((job) => ({ ...job, configHash: hash(c), runtimeHash: 'test', evidenceKind: 'simulated', status: 'completed', passed: job.sample === 0, calls: 4 }));
  const report = summarize(manifest, rows);
  assert.ok(Math.abs(report.groups.A2.independentPassAt1 - 0.2) < 1e-12);
  assert.equal(report.groups.A2.independentPassAt5, 1);
  assert.equal(report.groups.C1.independentPassAt5, null);
  assert.equal(report.pairs.A2.taskClusterBootstrap95, null);
  assert.throws(() => summarize(manifest, rows.map((r, i) => i ? r : { ...r, runtimeHash: 'other' })), /mixed_or_mismatched/);
});

test('cancellation drains an active EDA tool before result is returned', async (t) => {
  const server = await service(t, () => [toolChunk(good)]);
  let finished = false, enter;
  const entered = new Promise((r) => { enter = r; });
  const eda = { kind: 'simulated', async check({ signal }) {
    enter();
    await new Promise((r) => signal.aborted ? r() : signal.addEventListener('abort', r, { once: true }));
    await new Promise((r) => setTimeout(r, 30)); finished = true;
    return { passed: false, stage: 'csim', reason: 'cancelled' };
  } };
  const controller = new AbortController();
  const pending = runSample({ config: config(server.url), task, group: 'A2', directory: join(await temp(t), 'run'), eda, signal: controller.signal });
  await entered; controller.abort();
  const result = await pending;
  assert.equal(finished, true); assert.equal(result.passed, false); assert.equal(result.calls, 1);
});

test('cancellation kills descendants after startup handshake', async (t) => {
  const file = join(await temp(t), 'pid');
  const program = 'const {spawn}=require("node:child_process"); const p=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:["ignore","inherit","inherit"]}); require("node:fs").writeFileSync(process.argv[1],String(p.pid)); setInterval(()=>{},1000);';
  const controller = new AbortController();
  const pending = runProcess(process.execPath, ['-e', program, file], { timeoutMs: 10000, signal: controller.signal });
  let pid;
  try {
    for (let i = 0; i < 200; i++) {
      try { pid = Number(await readFile(file, 'utf8')); if (pid > 0) break; } catch { /* waiting for startup */ }
      await new Promise((r) => setTimeout(r, 25));
    }
  } finally { controller.abort(); }
  const result = await pending;
  assert.equal(result.reason, 'cancelled'); assert.ok(pid > 0);
  let alive = true;
  for (let i = 0; i < 20; i++) {
    try { process.kill(pid, 0); } catch { alive = false; break; }
    await new Promise((r) => setTimeout(r, 10));
  }
  if (alive) {
    const state = await runProcess('ps', ['-p', String(pid), '-o', 'stat=']);
    alive = state.ok && !state.stdout.trim().startsWith('Z');
  }
  assert.equal(alive, false);
});
