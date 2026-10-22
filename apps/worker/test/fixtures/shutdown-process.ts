import { appendFileSync } from "node:fs";
import path from "node:path";
import { createServer } from "node:http";
import { createDatabase } from "@aervox/repositories";
import type { LoggerPort } from "@aervox/observability";
import { WorkerHost } from "../../src/worker-host.js";
import { registerWorkerShutdown } from "../../src/shutdown.js";

const [root, mode] = process.argv.slice(2);
if (!root) throw new Error("Missing fixture directory");
const record = (event: string) => appendFileSync(path.join(root, "events"), event + "\n");
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const main = await createDatabase({ url: `file:${path.join(root, "main.db")}` });
const vault = await createDatabase({ url: `file:${path.join(root, "vault.db")}` });
for (const { client } of [main, vault]) await client.execute("CREATE TABLE shutdown_probe (value TEXT)");
const write = async (value: string) => {
  for (const { client } of [main, vault]) await client.execute({ sql: "INSERT INTO shutdown_probe VALUES (?)", args: [value] });
};
const logger: LoggerPort = {
  debug() {}, warn() {}, child() { return logger; },
  info(entry) {
    if (entry.event === "worker.shutdown.started") {
      record("shutdown"); process.send?.("stopping");
    }
  },
  error(entry) { record(JSON.stringify({ event: entry.event, message: entry.message, fields: entry.fields })); },
};
const host = new WorkerHost({ workerId: "shutdown-fixture", logger, shutdownTimeoutMs: mode === "hung" ? 1000 : 5000 });
const stageDelay = mode === "shared-budget" ? 350 : mode === "duplicate" ? 120 : 0;
host.registerJob({
  name: "write",
  async run() {
    record("started"); process.send?.("started");
    await new Promise<void>(resolve => process.on("message", message => {
      if (message === "release" && mode !== "hung") resolve();
    }));
    await delay(stageDelay);
    await write("finished"); record("written"); return 1;
  },
});
const healthServer = createServer((_request, response) => response.end("ready"));
await new Promise<void>(resolve => healthServer.listen(0, "127.0.0.1", resolve));
const closeHealth = healthServer.close.bind(healthServer);
healthServer.close = ((callback?: (error?: Error) => void) => {
  record("health-close");
  if (mode === "health-hung") return healthServer;
  if (mode === "health-reject") {
    queueMicrotask(() => callback?.(new Error("health_close_rejected"))); return healthServer;
  }
  void delay(stageDelay).then(() => closeHealth(error => { record("health-closed"); callback?.(error); }));
  return healthServer;
}) as typeof healthServer.close;
const closeConnections = healthServer.closeAllConnections.bind(healthServer);
healthServer.closeAllConnections = () => { record("health-connections-closed"); closeConnections(); };
const shutdownTimeoutMs = mode === "shared-budget" ? 800 : mode === "hung" ? 2500 : 700;
registerWorkerShutdown({
  shutdownTimeoutMs,
  host: { async stop() { record("stop"); await host.stop(); record("drained"); } },
  abortExecution() { record("abort"); },
  async disposeRuntime() {
    record("dispose-start");
    if (mode === "dispose-hung") await new Promise<void>(() => undefined);
    if (mode === "dispose-reject") throw new Error("runtime_dispose_rejected");
    await delay(stageDelay);
    if (mode === "dispose-write") { await write("disposed"); record("dispose-written"); }
    record("dispose-done");
  },
  healthServer, logger,
  clients: [main, vault].map(({ client }, index) => ({ close() { client.close(); record(`closed-${index}`); } })),
} as Parameters<typeof registerWorkerShutdown>[0] & { shutdownTimeoutMs: number });
host.start();
