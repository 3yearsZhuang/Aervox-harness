import fs from "node:fs/promises";
import path from "node:path";
import { createConnection, createServer, type Socket } from "node:net";
import { Pool } from "pg";
import { inspectUnixSocketPeer } from "@aervox/native-runtime";
import { describe, expect, it } from "vitest";
import { proveLocalPostgresqlStorage } from "../src/driver/postgresql-locality.js";

const connectionString = process.env.AERVOX_PG_TEST_URL ?? process.env.AERVOX_TEST_POSTGRES_URL;

describe.skipIf(!connectionString)("PostgreSQL current UNIX socket peer admission", () => {
  it("refuses a real Node forwarding peer even when PostgreSQL reports the same private data directory", async () => {
    const url = new URL(connectionString!);
    const upstreamDirectory = url.searchParams.get("host");
    expect(upstreamDirectory?.startsWith("/")).toBe(true);
    const port = (url.searchParams.get("port") ?? url.port) || "5432";
    // Keep below macOS's UNIX socket path limit, including the PostgreSQL suffix.
    const directory = await fs.mkdtemp("/tmp/avx-pg-peer-");
    await fs.chmod(directory, 0o700);
    const sockets = new Set<Socket>();
    const proxy = createServer(downstream => {
      const upstream = createConnection(path.join(upstreamDirectory!, `.s.PGSQL.${port}`));
      for (const socket of [downstream, upstream]) {
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
      }
      downstream.on("error", () => upstream.destroy());
      upstream.on("error", () => downstream.destroy());
      downstream.on("close", () => upstream.destroy());
      upstream.on("close", () => downstream.destroy());
      downstream.pipe(upstream); upstream.pipe(downstream);
    });
    const directPool = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 5_000, query_timeout: 5_000 });
    const forwardedUrl = new URL(url);
    forwardedUrl.searchParams.set("host", directory);
    const forwardedPool = new Pool({ connectionString: forwardedUrl.toString(), max: 1, connectionTimeoutMillis: 5_000, query_timeout: 5_000 });
    try {
      await new Promise<void>((resolve, reject) => {
        proxy.once("error", reject);
        proxy.listen(path.join(directory, `.s.PGSQL.${port}`), () => { proxy.off("error", reject); resolve(); });
      });
      const direct = await directPool.connect();
      try {
        const forwarded = await forwardedPool.connect();
        try {
          const settings = "SELECT inet_server_addr() AS address, current_setting('data_directory') AS directory";
          const actual = (await direct.query(settings)).rows;
          expect(actual[0]?.address).toBeNull();
          expect((await forwarded.query(settings)).rows).toEqual(actual);
          expect(await proveLocalPostgresqlStorage(direct, connectionString!)).toBe(true);
          const stream = Reflect.get(Reflect.get(forwarded, "connection"), "stream") as Socket;
          const peer = await inspectUnixSocketPeer(stream);
          expect(peer).toMatchObject({ pid: process.pid, uid: process.getuid?.() });
          expect(path.basename(peer!.executable)).toBe(path.basename(process.execPath));
          expect(await proveLocalPostgresqlStorage(forwarded, forwardedUrl.toString())).toBe(false);
        } finally { forwarded.release(); }
      } finally { direct.release(); }
    } finally {
      await Promise.allSettled([directPool.end(), forwardedPool.end()]);
      for (const socket of sockets) socket.destroy();
      if (proxy.listening) await new Promise<void>(resolve => proxy.close(() => resolve()));
      await fs.rm(directory, { recursive: true, force: true });
    }
  }, 30_000);
});
