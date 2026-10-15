import { Worker } from "node:worker_threads";
import { createRequire } from "node:module";

import { boundedUnpack } from "./archive-codec.js";

export const ARCHIVE_LIMITS = {
  compressedBytes: 20 * 1024 * 1024, expandedBytes: 50 * 1024 * 1024,
  entryBytes: 5 * 1024 * 1024, entries: 2048,
} as const;

/** Strict policy used for plugin and Persona archives and exports. */
export function isSafeArchivePath(name: string): boolean {
  if (!name || name.length > 512 || name.includes("\0") || name.includes("\\") || name.includes("//")) return false;
  if (name.startsWith("/") || /^[A-Za-z]:/.test(name)) return false;
  return !name.split("/").some(part => ["..", ".", "__proto__"].includes(part));
}

/** Skill ZIP compatibility; reject absolute paths before removing empty/dot segments. */
export function normalizeSkillArchivePath(raw: string): string | null {
  const slash = raw.replace(/\\/g, "/");
  if (slash.startsWith("/") || /^[A-Za-z]:/.test(slash) || slash.includes("\0")) throw new Error("Unsafe entry path in archive: " + raw);
  const parts = slash.split("/").filter(part => part && part !== ".");
  if (parts.some(part => part === ".." || part === "__proto__")) throw new Error("Unsafe entry path in archive: " + raw);
  if (!parts.length || parts[0] === "__MACOSX") return null;
  return parts.join("/") + (slash.endsWith("/") ? "/" : "");
}

let active = 0;
/** Keep the existing compression implementation and quotas, moving CPU work off the API loop. */
export async function executeArchive<T>(request: {
  kind: "pack" | "unpack";
  input: unknown;
  limits: { compressedBytes: number; expandedBytes: number; entryBytes: number; entries: number };
  isSafePath?: (name: string) => boolean;
  normalizePath?: (name: string) => string | null;
  signal?: AbortSignal;
}): Promise<T> {
  request.signal?.throwIfAborted();
  if (request.kind === "unpack" && request.input instanceof Uint8Array && request.input.byteLength > request.limits.compressedBytes) throw new Error("Archive exceeds compressed size limit");
  if (active >= 2) throw new Error("Archive processing is busy; retry later");
  active++;
  let worker: Worker | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    // This is fixed application code. Paths and archive data are structured
    // workerData, never evaluated as source. The sole path predicate is shared
    // with the public preflight API, rather than copied into a second rule set.
    const program = `
      const {parentPort,workerData}=require('node:worker_threads');
      const {zipSync}=require(workerData.fflate);
      const codec=require('node:zlib');
      const unpack=(${boundedUnpack.toString()});
      const safe=(${(request.isSafePath ?? isSafeArchivePath).toString()});
      const normalize=${request.normalizePath ? `(${request.normalizePath.toString()})` : `(name)=>{if(!safe(name)) throw Error('Unsafe entry path in archive: '+name);return name;}`};
      const {kind,input,limits}=workerData;
      try {
        let result;
        if(kind==='unpack') {
          if(input.byteLength>limits.compressedBytes) throw Error('Archive exceeds compressed size limit');
          result=unpack(input,limits,normalize,codec);
        } else {
          let expanded=0;const entries=Object.entries(input);
          if(entries.length>limits.entries) throw Error('Archive exceeds entry limit');
          for(const [name,entry] of entries){
            if(!safe(name)) throw Error('Unsafe entry path in archive: '+name);
            const bytes=Array.isArray(entry)?entry[0]:entry;
            expanded+=bytes.byteLength;
            if(bytes.byteLength>limits.entryBytes || expanded>limits.expandedBytes) throw Error('Archive exceeds expansion limits');
          }
          result=zipSync(input,{level:6});
          if(result.byteLength>limits.compressedBytes) throw Error('Archive exceeds compressed size limit');
        }
        parentPort.postMessage({result});
      } catch(error) {parentPort.postMessage({error:error.message});}
      parentPort.close();
    `;
    worker = new Worker(program, { eval: true, resourceLimits: { maxOldGenerationSizeMb: 128 },
      workerData: { kind: request.kind, input: request.input, limits: request.limits, fflate: createRequire(import.meta.url).resolve("fflate") } });
    const current = worker;
    return await new Promise<T>((resolve, reject) => {
      let settled = false;
      const fail = (error: Error) => { if (!settled) { settled = true; reject(error); } };
      abort = () => fail(new Error("Archive processing cancelled"));
      request.signal?.addEventListener("abort", abort, { once: true });
      if (request.signal?.aborted) abort();
      timer = setTimeout(() => fail(new Error("Archive processing timed out")), 10_000);
      current.once("error", fail);
      current.once("exit", () => { if (!settled) fail(new Error("Archive worker exited without a result")); });
      current.once("message", (message: { result?: T; error?: string }) => {
        if (settled) return;
        if (message.error) return fail(new Error(message.error));
        settled = true; resolve(message.result!);
      });
    });
  } finally {
    clearTimeout(timer);
    if (abort) request.signal?.removeEventListener("abort", abort);
    if (worker) await worker.terminate();
    active--;
  }
}
