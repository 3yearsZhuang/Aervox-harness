import { expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStdioAdapterDriver } from '../src/stdio-adapter.js';

it('terminates an admitted Adapter after malformed protocol even when SIGTERM is ignored', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'aervox-hygiene-protocol-'));
  const pidFile = join(dir, 'pid');
  const code = `require('node:fs').writeFileSync(process.env.PID_FILE, String(process.pid));
    process.stdout.write(JSON.stringify({kind:'hello',manifest:{adapterId:'dsh',version:'1',sha256:'sim-sha',license:'MIT',terminationPolicy:'any'}})+'\\n');
    require('node:readline').createInterface({input:process.stdin}).on('line',()=>process.stdout.write('invalid-json\\n'));
    process.on('SIGTERM',()=>{}); setInterval(()=>{},1000);`;
  const handle = await createStdioAdapterDriver({ command: process.execPath, args: ['-e', code], env: { PID_FILE: pidFile }, expected: { adapterId: 'dsh', sha256: 'sim-sha' }, requestTimeoutMs: 100 });
  try {
    await expect(async () => { for await (const event of handle.driver.run({turnId:'turn', sessionId:'session',attemptId:'attempt',userMessage:'hello'})) void event; }).rejects.toThrow('adapter_unavailable');
    const pid = Number(await readFile(pidFile, 'utf8'));
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), { timeout: 3000 });
    await expect(async () => { for await (const event of handle.driver.run({turnId:'next',sessionId:'session',attemptId:'next',userMessage:'hello'})) void event; }).rejects.toThrow('adapter_unavailable');
  } finally { await handle.close(); await rm(dir, {recursive:true,force:true}); }
});
