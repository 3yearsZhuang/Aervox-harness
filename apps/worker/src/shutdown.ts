import type { Server } from "node:http";
import type { LoggerPort } from "@aervox/observability";
import type { WorkerHost } from "./worker-host.js";

/** Signal shutdown has one owner: drain work, close connections, then exit. */
export function registerWorkerShutdown(deps: {
  host: Pick<WorkerHost, "stop">;
  clients: Array<{ close(): void }>;
  healthServer?: Server;
  logger: LoggerPort;
}): void {
  let shuttingDown = false;
  async function shutdown(signal: NodeJS.Signals): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    deps.logger.info({
      event: "worker.shutdown.started",
      message: `Worker received ${signal}; stopping scheduler and closing connections`,
      fields: { signal },
    });
    let exitCode = 0;
    try {
      await deps.host.stop();
      const healthServer = deps.healthServer;
      if (healthServer) {
        const closed = new Promise<void>((resolve, reject) => healthServer.close(error => error ? reject(error) : resolve()));
        healthServer.closeAllConnections();
        await closed;
      }
      for (const client of deps.clients) client.close();
    } catch (err) {
      exitCode = 1;
      deps.logger.error({
        event: "worker.shutdown.failed",
        message: `Worker shutdown encountered an error: ${err instanceof Error ? err.message : String(err)}`,
      });
    } finally {
      process.exit(exitCode);
    }
  }

  process.on("SIGINT", (signal) => {
    void shutdown(signal);
  });
  process.on("SIGTERM", (signal) => {
    void shutdown(signal);
  });

}
