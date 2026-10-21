import { localApiBase } from './config.js';

// The development launcher uses the same URL policy as the CLI before probing
// with credentials. Do not include rejected URLs (which can contain secrets).
try {
  process.stdout.write(localApiBase(process.argv[2] ?? ''));
} catch {
  process.stderr.write('连接版仅支持本机 HTTP(S) 根地址，地址中不能包含凭据、查询或片段。\n');
  process.exitCode = 2;
}
