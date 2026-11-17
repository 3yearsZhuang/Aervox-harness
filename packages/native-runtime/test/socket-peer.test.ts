import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createConnection, createServer, Socket } from "node:net";
import { describe, expect, it } from "vitest";
// Exercise the packaged entry point and its actual bundled native artifact.
import { inspectUnixSocketPeer } from "../dist/index.js";

it("does not attest disconnected or destroyed handles", async () => {
  const socket = new Socket();
  expect(await inspectUnixSocketPeer(socket)).toBeUndefined();
  socket.destroy();
  expect(await inspectUnixSocketPeer(socket)).toBeUndefined();
});

describe.skipIf(!["linux", "darwin"].includes(process.platform))("native connected socket peer", () => {
  for (const transport of ["unix", "tcp"] as const) {
    it(`inspects ${transport} transport without breaking the parent connection`, async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "aervox-peer-"));
      const accepted = new Set<Socket>();
      const server = createServer(socket => {
        accepted.add(socket); socket.once("close", () => accepted.delete(socket));
        socket.on("error", () => {}); socket.pipe(socket);
      });
      let client: Socket | undefined;
      try {
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          if (transport === "unix") server.listen(path.join(root, "peer.sock"), resolve);
          else server.listen(0, "127.0.0.1", resolve);
        });
        const address = server.address()!;
        client = await new Promise<Socket>((resolve, reject) => {
          const socket = typeof address === "string" ? createConnection(address)
            : createConnection(address.port, "127.0.0.1");
          socket.once("error", reject); socket.once("connect", () => resolve(socket));
        });
        const peer = await inspectUnixSocketPeer(client);
        if (transport === "unix") expect(peer).toEqual({ pid: process.pid, parentPid: process.ppid, uid: process.getuid!(), executable: "node" });
        else expect(peer).toBeUndefined();
        const echoed = new Promise<Buffer>((resolve, reject) => { client!.once("data", resolve); client!.once("error", reject); });
        client.write("parent connection remains usable");
        expect((await echoed).toString()).toBe("parent connection remains usable");
      } finally {
        client?.destroy(); for (const socket of accepted) socket.destroy();
        await new Promise<void>(resolve => server.close(() => resolve()));
        await fs.rm(root, { recursive: true, force: true });
      }
    });
  }
});
