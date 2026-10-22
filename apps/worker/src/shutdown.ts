import type { Server } from "node:http";
import type { LoggerPort } from "@aervox/observability";
import type { WorkerHost } from "./worker-host.js";

export const DEFAULT_WORKER_SHUTDOWN_TIMEOUT_MS = 20_000;
type ShutdownPhase = "cancel" | "drain" | "runtime" | "health" | "database";

/** One signal owner and one deadline; database handles outlive async teardown. */
export function registerWorkerShutdown(deps: {
  host: Pick<WorkerHost, "stop">;
  clients: Array<{ close(): void }>;
  healthServer?: Server;
  disposeRuntime?: () => Promise<void>;
  abortExecution?: () => void;
  logger: LoggerPort;
  shutdownTimeoutMs?: number;
}): void {
  const shutdownTimeoutMs = deps.shutdownTimeoutMs ?? DEFAULT_WORKER_SHUTDOWN_TIMEOUT_MS;
  if (!Number.isSafeInteger(shutdownTimeoutMs) || shutdownTimeoutMs <= 0 || shutdownTimeoutMs > 2_147_483_647) {
    throw new Error("invalid_worker_shutdown_deadline");
  }
  let shuttingDown = false;
  async function shutdown(signal: NodeJS.Signals): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    const startedAt = performance.now();
    const deadlineAt = startedAt + shutdownTimeoutMs;
    const deadlineError = new Error("worker_shutdown_deadline_exceeded");
    let phase: ShutdownPhase = "cancel";
    let finished = false;
    let timer: ReturnType<typeof setTimeout>;
    // Keep this timer referenced so even teardown with no other handles exits.
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(deadlineError), shutdownTimeoutMs);
    });
    const assertWithinDeadline = (): void => {
      if (finished || performance.now() >= deadlineAt) throw deadlineError;
    };
    const runStage = async (nextPhase: ShutdownPhase, operation: () => void | Promise<void>): Promise<void> => {
      phase = nextPhase;
      assertWithinDeadline();
      await Promise.race([Promise.resolve().then(() => { assertWithinDeadline(); return operation(); }), deadline]);
      // A resolved operation can beat the timer callback after event-loop delay.
      assertWithinDeadline();
    };
    let exitCode = 0;
    try {
      deps.logger.info({
        event: "worker.shutdown.started",
        message: `Worker received ${signal}; stopping scheduler and closing connections`,
        fields: { signal, shutdownTimeoutMs },
      });
      await runStage("cancel", () => deps.abortExecution?.());
      await runStage("drain", () => deps.host.stop());
      await runStage("runtime", () => deps.disposeRuntime?.());
      const healthServer = deps.healthServer;
      if (healthServer) {
        await runStage("health", () => {
          const closed = new Promise<void>((resolve, reject) => healthServer.close(error => error ? reject(error) : resolve()));
          healthServer.closeAllConnections();
          return closed;
        });
      }
      phase = "database";
      for (const client of deps.clients) {
        assertWithinDeadline();
        client.close();
        assertWithinDeadline();
      }
    } catch (err) {
      exitCode = 1;
      deps.logger.error({
        event: "worker.shutdown.failed",
        message: `Worker shutdown encountered an error: ${err instanceof Error ? err.message : String(err)}`,
        fields: { phase, shutdownTimeoutMs, elapsedMs: Math.round(performance.now() - startedAt) },
      });
    } finally {
      finished = true;
      clearTimeout(timer!);
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
