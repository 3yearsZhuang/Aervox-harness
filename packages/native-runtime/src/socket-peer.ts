import { spawn } from "node:child_process";
import { Socket } from "node:net";
import { loadNativeArtifact, verifyNativeArtifact } from "./artifact.js";

export interface UnixSocketPeer { pid: number; parentPid: number; uid: number; executable: string }

/** Inspect the existing connected descriptor, rather than opening a second
 * connection to a path which might lead to a different peer. Unsupported Node
 * handles, platforms or unavailable native artifacts cannot confer a proof. */
export async function inspectUnixSocketPeer(socket: Socket): Promise<UnixSocketPeer | undefined> {
  try {
    if (!["linux", "darwin"].includes(process.platform) || !(socket instanceof Socket) || socket.destroyed || socket.connecting) return undefined;
    const handle: unknown = Reflect.get(socket, "_handle");
    const descriptor: unknown = handle && typeof handle === "object" ? Reflect.get(handle, "fd") : undefined;
    if (typeof descriptor !== "number" || !Number.isSafeInteger(descriptor) || descriptor < 0) return undefined;
    const artifact = await loadNativeArtifact();
    if (!artifact) return undefined;
    const binary = await verifyNativeArtifact(artifact);
    if (socket.destroyed || Reflect.get(socket, "_handle") !== handle || Reflect.get(handle as object, "fd") !== descriptor) return undefined;
    const result = await new Promise<UnixSocketPeer | undefined>(resolve => {
      const child = spawn(binary, ["socket-peer"], { shell: false, windowsHide: true,
        stdio: ["ignore", "pipe", "ignore", descriptor], timeout: 5_000, killSignal: "SIGKILL" });
      let bytes = 0;
      const chunks: Buffer[] = [];
      child.stdout!.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 4096) { child.kill("SIGKILL"); resolve(undefined); return; }
        chunks.push(chunk);
      });
      child.once("error", () => resolve(undefined));
      child.once("close", code => {
        if (code !== 0 || bytes > 4096) { resolve(undefined); return; }
        try {
          const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if (!value || typeof value !== "object") { resolve(undefined); return; }
          const pid: unknown = Reflect.get(value, "pid"), parentPid: unknown = Reflect.get(value, "parentPid"), uid: unknown = Reflect.get(value, "uid"), executable: unknown = Reflect.get(value, "executable");
          if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0
            || typeof parentPid !== "number" || !Number.isSafeInteger(parentPid) || parentPid < 0
            || typeof uid !== "number" || !Number.isSafeInteger(uid) || uid < 0
            || typeof executable !== "string" || !executable || executable.length > 255 || /[\0/\\]/.test(executable)) {
            resolve(undefined); return;
          }
          resolve({ pid, parentPid, uid, executable });
        } catch { resolve(undefined); }
      });
    });
    return socket.destroyed || Reflect.get(socket, "_handle") !== handle || Reflect.get(handle as object, "fd") !== descriptor ? undefined : result;
  } catch { return undefined; }
}
