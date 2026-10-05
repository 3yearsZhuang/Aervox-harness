#!/usr/bin/env node
import { resolve, join } from 'node:path';
import { readJson, writeJson, validateConfig, validateTask } from './config.mjs';
import { doctor } from './doctor.mjs';
import { createVitis } from './vitis.mjs';
import { runSample, GROUPS } from './runner.mjs';
import { runBatch, loadReport } from './evaluation.mjs';

const [command, ...args] = process.argv.slice(2);
const usage = 'Usage (through mise): node scripts/hls-agent/cli.mjs doctor CONFIG | run CONFIG TASK GROUP OUT | batch CONFIG TASKS OUT | report OUT';
const controller = new AbortController();
const stop = () => controller.abort(new Error('user_cancelled'));
process.on('SIGINT', stop); process.on('SIGTERM', stop);
try {
  if (command === 'report' && args.length === 1) console.log(JSON.stringify(await loadReport(resolve(args[0])), null, 2));
  else {
    if (!['doctor', 'run', 'batch'].includes(command) || args.length !== ({ doctor: 1, run: 4, batch: 3 })[command]) throw new Error(usage);
    const config = validateConfig(await readJson(args[0]));
    const inventory = await doctor(config);
    if (command === 'doctor') { console.log(JSON.stringify(inventory, null, 2)); if (!inventory.ready) process.exitCode = 2; }
    else {
      if (!inventory.ready) { console.log(JSON.stringify(inventory, null, 2)); throw new Error('environment_not_ready; run doctor after configuration'); }
      // Freeze mutable tags to the locally inspected content-addressed image.
      config.eda.image = inventory.checks.vitis.imageId;
      const eda = createVitis(config.eda);
      let result;
      if (command === 'run') {
        if (!GROUPS.includes(args[2])) throw new Error('group_must_be_B0_A1_A2_C1');
        const directory = resolve(args[3]);
        result = await runSample({ config, task: validateTask(await readJson(args[1])), group: args[2], directory, eda, signal: controller.signal });
        await writeJson(join(directory, 'inventory.json'), inventory);
      } else {
        const tasks = await readJson(args[1]);
        if (!Array.isArray(tasks)) throw new Error('tasks_must_be_array');
        result = await runBatch({ config, tasks: tasks.map(validateTask), directory: resolve(args[2]), eda, inventory, signal: controller.signal });
      }
      console.log(JSON.stringify(result, null, 2));
    }
  }
} catch (err) { console.error(err.message); process.exitCode = 1; }
finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
