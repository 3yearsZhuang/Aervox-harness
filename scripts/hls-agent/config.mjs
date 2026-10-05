import { readFile, writeFile, rename } from 'node:fs/promises';
import { createHash } from 'node:crypto';

export const hash = (value) => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
export const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));
export async function writeJson(path, value) {
  await writeFile(`${path}.tmp`, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(`${path}.tmp`, path);
}
const integer = (value, min, max, name) => {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`invalid_${name}`);
  return value;
};
const string = (value, name, max = 256) => {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > max) throw new Error(`invalid_${name}`);
  return value;
};
function keys(value, allowed, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((k) => !allowed.includes(k))) throw new Error(`invalid_${name}_fields`);
}
export function validateConfig(input) {
  keys(input, ['model', 'eda', 'budget', 'seed', 'samples', 'timing'], 'config');
  const { model: m, eda: e, budget: b } = input;
  keys(m, ['baseUrl', 'modelId', 'revision', 'quantization', 'contextTokens', 'temperature', 'maxTokens'], 'model');
  const url = new URL(m.baseUrl);
  if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) || url.username || url.password || url.search || url.hash) throw new Error('model_requires_loopback_url');
  // Avoid DNS resolution of localhost, including hosts-file overrides.
  if (url.hostname === 'localhost') url.hostname = '127.0.0.1';
  const model = { ...m, baseUrl: url.href.replace(/\/+$/, '') };
  for (const k of ['modelId', 'revision', 'quantization']) string(m[k], k);
  integer(m.contextTokens, 1024, 1048576, 'contextTokens');
  integer(m.maxTokens, 1, m.contextTokens - 1, 'maxTokens');
  if (!Number.isFinite(m.temperature) || m.temperature < 0 || m.temperature > 2) throw new Error('invalid_temperature');
  keys(e, ['image', 'cpus', 'memoryMb', 'pids', 'timeoutMs'], 'eda');
  if (e.image !== null && !/^[-a-zA-Z0-9._/:@]+$/.test(string(e.image, 'image'))) throw new Error('invalid_image');
  integer(e.cpus, 1, 64, 'cpus'); integer(e.memoryMb, 512, 262144, 'memoryMb');
  integer(e.pids, 32, 4096, 'pids'); integer(e.timeoutMs, 100, 3600000, 'eda_timeout');
  keys(b, ['runMs', 'judgeMs', 'maxCalls', 'maxChecks', 'maxInputBytes', 'maxResponseBytes', 'maxCodeBytes'], 'budget');
  integer(b.runMs, 100, 14400000, 'runMs'); integer(b.judgeMs, 100, 7200000, 'judgeMs');
  integer(b.maxCalls, 1, 64, 'maxCalls'); integer(b.maxChecks, 1, 64, 'maxChecks');
  // UTF-8 bytes plus per-message overhead are a conservative window guard,
  // not a tokenizer measurement. Keep output reserve identical in all groups.
  integer(b.maxInputBytes, 256, m.contextTokens - m.maxTokens, 'maxInputBytes');
  integer(b.maxResponseBytes, 1024, 4194304, 'maxResponseBytes');
  integer(b.maxCodeBytes, 128, 65536, 'maxCodeBytes');
  integer(input.seed, 0, 2147483000, 'seed'); integer(input.samples, 1, 100, 'samples');
  if (!['cold-unverified', 'warm-unverified', 'mixed-unverified'].includes(input.timing)) throw new Error('invalid_timing');
  return { ...input, model };
}
export function validateTask(task) {
  keys(task, ['id', 'family', 'split', 'prompt', 'top', 'publicTestbench'], 'task');
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(task.id)) throw new Error('invalid_task_id');
  if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/.test(task.top)) throw new Error('invalid_top');
  string(task.family, 'family'); string(task.prompt, 'prompt', 65536);
  string(task.publicTestbench, 'publicTestbench', 131072);
  if (!['development', 'holdout-public'].includes(task.split)) throw new Error('only_public_fixtures_supported');
  return task;
}
export function extractCode(text, maxBytes) {
  const blocks = [...text.matchAll(/```(?:cpp|c\+\+|c)?\s*\n([\s\S]*?)```/g)];
  const code = blocks.length === 1 ? blocks[0][1].trim() : text.trim();
  if (blocks.length > 1 || !code || Buffer.byteLength(code) > maxBytes) throw new Error('invalid_candidate');
  return code;
}
