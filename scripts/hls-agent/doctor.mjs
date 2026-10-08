import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir, platform, arch } from 'node:os';
import { join } from 'node:path';
import { runProcess } from './process.mjs';
import { runContainer, TARGET } from './vitis.mjs';

export async function doctor(config) {
  const inventory = { platform: platform(), arch: arch(), checkedAt: new Date().toISOString(), ready: false, target: TARGET, checks: {}, unverified: ['GPU model/VRAM', 'model revision/quantization/context limit', 'offline image provenance', 'official scoring interface'] };
  try {
    const response = await fetch(`${config.model.baseUrl}/models`, { signal: AbortSignal.timeout(5000), redirect: 'error' });
    if (!response.ok) throw new Error(`http_${response.status}`);
    let body = '', size = 0;
    for await (const chunk of response.body) { size += chunk.length; if (size > 1048576) throw new Error('model_inventory_too_large'); body += Buffer.from(chunk).toString('utf8'); }
    const ids = JSON.parse(body).data?.map((m) => m.id) ?? [];
    inventory.checks.model = { ok: ids.includes(config.model.modelId), availableModels: ids };
  } catch { inventory.checks.model = { ok: false, reason: 'loopback_model_unavailable', action: 'Start a local compatible service, or configure your own SSH local port forwarding; verify /v1/models.' }; }
  const docker = await runProcess('docker', ['version', '--format', '{{.Server.Version}}']);
  inventory.checks.docker = { ok: docker.ok, version: docker.stdout.trim(), reason: docker.reason };
  if (!config.eda.image) inventory.checks.vitis = { ok: false, reason: 'eda_image_not_configured', action: 'Load the authorized Vitis 2025.2 image locally and set eda.image; no image is pulled automatically.' };
  else if (docker.ok) {
    const inspect = await runProcess('docker', ['image', 'inspect', '--format', '{{.Id}}', config.eda.image]);
    if (!inspect.ok || !/^sha256:[0-9a-f]{64}$/.test(inspect.stdout.trim())) inventory.checks.vitis = { ok: false, reason: 'local_image_missing' };
    else {
      const dir = await mkdtemp(join(tmpdir(), 'aervox-hls-doctor-'));
      try {
        await mkdir(join(dir, 'input')); await mkdir(join(dir, 'work'));
        const version = await runContainer({ ...config.eda, image: inspect.stdout.trim() }, join(dir, 'input'), join(dir, 'work'), ['--version'], { timeoutMs: 30000 });
        inventory.checks.vitis = { ok: version.ok && /2025\.2/.test(version.stdout + version.stderr), imageId: inspect.stdout.trim(), version: (version.stdout + version.stderr).slice(0, 4000), reason: version.reason };
      } finally { await rm(dir, { recursive: true, force: true }); }
    }
  } else inventory.checks.vitis = { ok: false, reason: 'docker_unavailable' };
  inventory.ready = Object.values(inventory.checks).every((c) => c.ok);
  return inventory;
}
