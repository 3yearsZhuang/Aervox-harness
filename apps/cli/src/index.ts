import { runCli } from './cli.js';

const controller = new AbortController();
const onInterrupt = () => controller.abort('SIGINT');
const onTerminate = () => controller.abort('SIGTERM');
const onPipeError = () => controller.abort('SIGPIPE');
process.once('SIGINT', onInterrupt);
process.once('SIGTERM', onTerminate);
process.stdout.on('error', onPipeError);
process.stderr.on('error', onPipeError);
try {
  process.exitCode = await runCli(process.argv.slice(2), {
    input: process.stdin, output: process.stdout, error: process.stderr,
    env: process.env, signal: controller.signal,
  });
} catch {
  process.exitCode = 1;
} finally {
  process.removeListener('SIGINT', onInterrupt);
  process.removeListener('SIGTERM', onTerminate);
  // Keep the error handlers installed until pending pipe writes have settled.
  process.stdin.pause();
}
