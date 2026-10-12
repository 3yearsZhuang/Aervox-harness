import { Worker } from "node:worker_threads";
import { createRequire } from "node:module";

let active = 0;
/** Keep the existing compression implementation and quotas, moving CPU work off the API loop. */
export async function executeArchive<T>(request: {
  kind: "pack" | "unpack";
  input: unknown;
  limits: { compressedBytes: number; expandedBytes: number; entryBytes: number; entries: number };
  isSafePath: (name: string) => boolean;
  signal?: AbortSignal;
}): Promise<T> {
  request.signal?.throwIfAborted();
  if (request.kind === "unpack" && request.input instanceof Uint8Array && request.input.byteLength > request.limits.compressedBytes) throw new Error("Plugin archive exceeds compressed size limit");
  if (active >= 2) throw new Error("Plugin archive processing is busy; retry later");
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
      const {unzipSync,zipSync}=require(workerData.fflate);
      const safe=(${request.isSafePath.toString()});
      const {kind,input,limits}=workerData;
      try {
        let result;
        if(kind==='unpack') {
          if(input.byteLength>limits.compressedBytes) throw Error('Plugin archive exceeds compressed size limit');
          let expanded=0;const names=new Set();
          result=unzipSync(input,{filter(entry){
            if(!safe(entry.name)) throw Error('Unsafe entry path in archive: '+entry.name);
            if(names.has(entry.name)) throw Error('Duplicate archive entry: '+entry.name);
            names.add(entry.name);expanded+=Math.max(entry.originalSize,entry.size);
            if(names.size>limits.entries || entry.originalSize>limits.entryBytes || entry.size>limits.entryBytes || expanded>limits.expandedBytes) throw Error('Plugin archive exceeds expansion limits');
            return true;
          }});
          let actual=0;
          for(const value of Object.values(result)){actual+=value.byteLength;if(value.byteLength>limits.entryBytes || actual>limits.expandedBytes) throw Error('Plugin archive exceeds actual expansion limits');}
        } else {
          let expanded=0;const entries=Object.entries(input);
          if(entries.length>limits.entries) throw Error('Plugin archive exceeds entry limit');
          for(const [name,entry] of entries){
            if(!safe(name)) throw Error('Unsafe entry path in archive: '+name);
            const bytes=Array.isArray(entry)?entry[0]:entry;
            expanded+=bytes.byteLength;
            if(bytes.byteLength>limits.entryBytes || expanded>limits.expandedBytes) throw Error('Plugin archive exceeds expansion limits');
          }
          result=zipSync(input,{level:6});
          if(result.byteLength>limits.compressedBytes) throw Error('Plugin archive exceeds compressed size limit');
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
      abort = () => fail(new Error("Plugin archive processing cancelled"));
      request.signal?.addEventListener("abort", abort, { once: true });
      if (request.signal?.aborted) abort();
      timer = setTimeout(() => fail(new Error("Plugin archive processing timed out")), 10_000);
      current.once("error", fail);
      current.once("exit", () => { if (!settled) fail(new Error("Plugin archive worker exited without a result")); });
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
