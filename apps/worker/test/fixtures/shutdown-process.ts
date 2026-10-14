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
const main = await createDatabase({ url: `file:${path.join(root, "main.db")}` });
const vault = await createDatabase({ url: `file:${path.join(root, "vault.db")}` });
for (const { client } of [main, vault]) await client.execute("CREATE TABLE shutdown_probe (value TEXT)");
const logger: LoggerPort = {
  debug() {}, warn() {}, child() { return logger; },
  info(entry) {
    if (entry.event === "worker.shutdown.started") {
      record("shutdown");
      process.send?.("stopping");
    }
  },
  error(entry) { record(entry.message); },
};
const host = new WorkerHost({ workerId: "shutdown-fixture", logger, shutdownTimeoutMs: mode === "hung" ? 1000 : 5000 });
host.registerJob({
  name: "write",
  async run() {
    record("started");
    process.send?.("started");
    await new Promise<void>(resolve => process.on("message", message => { if (message === "release" && mode !== "hung") resolve(); }));
    await main.client.execute("INSERT INTO shutdown_probe VALUES ('finished')");
    await vault.client.execute("INSERT INTO shutdown_probe VALUES ('finished')");
    record("written");
    return 1;
  },
});
const healthServer = createServer((_request, response) => response.end("ready"));
await new Promise<void>(resolve => healthServer.listen(0, "127.0.0.1", resolve));
registerWorkerShutdown({
  host, healthServer, logger,
  clients: [main, vault].map(({ client }, index) => ({ close() { client.close(); record(`closed-${index}`); } })),
});
host.start();
