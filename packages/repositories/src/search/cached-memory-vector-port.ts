import type { Client } from "@libsql/client";
import { Worker } from "node:worker_threads";
import { assertLocalContext, type LocalContext } from "../local-context.js";
import type { IVectorSearchPort, VectorItem, VectorSearchResult } from "./vector-port.js";

/** A persistent reader is essential: LibSQL pooled connections do not provide a global data_version. */
export class CachedMemoryVectorSearchAdapter implements IVectorSearchPort {
  private worker?: Worker;
  private pending?: { resolve(value: VectorSearchResult[]): void; reject(error: Error): void };
  private chain: Promise<unknown> = Promise.resolve();
  private queued = 0;
  private closed = false;
  constructor(private readonly fallback: IVectorSearchPort, private readonly options: { client: Client; modelId: string; databasePath?: string }) {}
  upsert(ctx: LocalContext, items: VectorItem[]): Promise<void> { return this.fallback.upsert(ctx, items); }
  delete(ctx: LocalContext, id: string): Promise<void> { return this.fallback.delete(ctx, id); }
  clearAll(ctx: LocalContext): Promise<void> { return this.fallback.clearAll(ctx); }
  private start(): Worker {
    if (this.worker) return this.worker;
    const program = `
      const {parentPort,workerData}=require('node:worker_threads');
      const {DatabaseSync}=require('node:sqlite'),{statSync}=require('node:fs');
      (async()=>{
        const {TopK}=await import(workerData.topK);let db,identity,cache;
        const open=()=>{const m=statSync(workerData.path,{bigint:true});const key=m.dev+':'+m.ino+':'+m.birthtimeNs;
          if(identity!==key){if(db)db.close();db=new DatabaseSync(workerData.path,{readOnly:true});db.exec('PRAGMA busy_timeout=0;PRAGMA query_only=ON');identity=key;cache=undefined;}}
        const version=()=>db.prepare('PRAGMA data_version').get().data_version;
        const load=(stamp)=>{
          const ids=[],vectors=[],norms=[],offsets=[0];let total=0;
          for(const row of db.prepare('SELECT memory_id,embedding_json FROM memory_embeddings WHERE model_id=?').iterate(workerData.modelId)){
            if(ids.length>=100000||Buffer.byteLength(row.embedding_json)>1048576)throw Error('vector_capacity_exceeded');
            const v=JSON.parse(row.embedding_json);
            if(!Array.isArray(v)||v.length>1024||v.some(x=>typeof x!=='number'||!Number.isFinite(x)))throw Error('vector_data_invalid');
            total+=v.length;if(total>32000000)throw Error('vector_capacity_exceeded');
            vectors.push(Float64Array.from(v));ids.push(String(row.memory_id));offsets.push(total);
            let sum=0;for(const x of v)sum+=x*x;norms.push(Math.sqrt(sum));
          }
          const values=new Float64Array(total);let offset=0;for(const v of vectors){values.set(v,offset);offset+=v.length;}
          cache={stamp,ids,offsets:Uint32Array.from(offsets),values,norms:Float64Array.from(norms)};
        };
        parentPort.on('message',({query,topK,minScore})=>{
          try{
            open();
            for(let attempt=0;attempt<3;attempt++){
              const stamp=version();if(cache?.stamp!==stamp)load(stamp);
              let sum=0;for(const x of query)sum+=x*x;const norm=Math.sqrt(sum),heap=new TopK(topK);
              for(let row=0;row<cache.ids.length;row++){
                const begin=cache.offsets[row],end=cache.offsets[row+1];let score=0;
                if(end-begin===query.length&&norm!==0&&cache.norms[row]!==0){let dot=0;for(let d=0;d<query.length;d++)dot+=query[d]*cache.values[begin+d];score=dot/(norm*cache.norms[row]);}
                if(score>=minScore)heap.add({id:cache.ids[row],score},score);
              }
              const priorIdentity=identity;open();
              if(identity===priorIdentity&&version()===stamp){parentPort.postMessage({hits:heap.values()});return;}cache=undefined;
            }
            throw Error('vector_snapshot_changed');
          }catch{cache=undefined;parentPort.postMessage({error:'vector_worker_failed'});}
        });
      })().catch(()=>process.exit(1));
    `;
    const worker = new Worker(program, { eval: true, resourceLimits: { maxOldGenerationSizeMb: 512 }, workerData: {
      path: this.options.databasePath, modelId: this.options.modelId, topK: new URL("../../dist/search/top-k.js", import.meta.url).href,
    } });
    this.worker = worker;
    const fail = () => { if (this.worker === worker) { this.worker = undefined; this.pending?.reject(new Error("vector_worker_failed")); this.pending = undefined; } };
    worker.on("error", fail); worker.on("exit", fail);
    worker.on("message", (message: { hits?: VectorSearchResult[]; error?: string }) => {
      if (this.worker !== worker) return;
      const pending = this.pending; this.pending = undefined;
      if (!pending) return;
      if (message.error || !Array.isArray(message.hits)) pending.reject(new Error("vector_worker_failed")); else pending.resolve(message.hits);
    });
    return worker;
  }
  async search(ctx: LocalContext, query: number[], topK: number, minScore = 0): Promise<VectorSearchResult[]> {
    assertLocalContext(ctx);
    if (this.closed) throw new Error("vector_port_closed");
    if (!Number.isSafeInteger(topK) || topK < 0 || topK > 200 || query.length > 1024 || query.some(v => !Number.isFinite(v)) || !Number.isFinite(minScore)) throw new Error("vector_query_invalid");
    if (topK === 0) return [];
    if (this.queued >= 16) throw new Error("vector_port_busy");
    this.queued++;
    const result = this.chain.then(async () => {
      if (this.closed) throw new Error("vector_port_closed");
      if (!this.options.databasePath) return this.fallback.search(ctx, query, topK, minScore);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const worker = this.start();
        return await new Promise<VectorSearchResult[]>((resolve, reject) => {
          this.pending = { resolve, reject }; timer = setTimeout(() => reject(new Error("vector_worker_timeout")), 10000);
          worker.postMessage({ query, topK, minScore });
        });
      } catch (error) {
        this.pending = undefined; const worker = this.worker; this.worker = undefined;
        if (worker) await worker.terminate();
        if (this.closed) throw error;
        return this.fallback.search(ctx, query, topK, minScore);
      } finally { clearTimeout(timer); }
    });
    this.chain = result.catch(() => undefined);
    try { return await result; } finally { this.queued--; }
  }
  async close(): Promise<void> {
    this.closed = true; this.pending?.reject(new Error("vector_port_closed")); this.pending = undefined;
    const worker = this.worker; this.worker = undefined;
    if (worker) await worker.terminate(); await this.chain;
  }
}
