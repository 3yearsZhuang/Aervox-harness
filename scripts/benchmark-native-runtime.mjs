import { DatabaseSync } from "node:sqlite";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir, cpus, platform, arch } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { createHash } from "node:crypto";
import { setTimeout as pause } from "node:timers/promises";
import { NativeRuntimeClient, NativeAudioPreprocessor } from "../packages/native-runtime/dist/index.js";
import { createDatabase, SqliteMemoryEmbeddingRepository, SqliteMemoryVectorSearchAdapter, CachedMemoryVectorSearchAdapter } from "../packages/repositories/dist/index.js";
import { TopK } from "../packages/repositories/dist/search/top-k.js";
import { cosineSimilarity } from "../packages/repositories/dist/search/vector-port.js";
import { executeArchive } from "../packages/host-runtime/dist/shared/archive-worker.js";
import { isSafeZipEntryPath, PLUGIN_ARCHIVE_LIMITS } from "../packages/host-runtime/dist/modules/ecosystem/plugins/package-bundle.js";
import { zipSync, unzipSync } from "fflate";
import * as sqliteVec from "sqlite-vec";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const options = Object.fromEntries(process.argv.slice(2).map(a => a.replace(/^--/, "").split("=")));
const sizes = (options.sizes ?? "1000,10000,100000").split(",").map(Number), dimensions = Number(options.dimensions ?? 256), samples = Number(options.samples ?? 7), warmup = 3;
if (sizes.some(n=>!Number.isSafeInteger(n)||n<1||n>100000)||!Number.isSafeInteger(dimensions)||dimensions<1||dimensions>1024||!Number.isSafeInteger(samples)||samples<3||samples>29) throw new Error("Invalid benchmark parameters");
const bin = join(root,"packages/native-runtime/dist/bin",`${process.platform}-${process.arch}`);
const manifest = JSON.parse(await readFile(join(bin,"artifact.json"),"utf8"));
const artifact = { binary: join(bin,manifest.binary), sha256:manifest.sha256 };
const work = await mkdtemp(join(tmpdir(),"aervox-runtime-bench-"));
const report = { schemaVersion: 1, measuredAt: new Date().toISOString(), environment: { node:process.version,platform:platform(),arch:arch(),cpu:cpus()[0]?.model }, artifact,
  fixture: { seed:42,sizes,dimensions,samples,warmup,topK:10,minScore:0 }, vector:[], audio:[], archive:[],
  limitations:["Synthetic file SQLite: production corpus quality, eligibility and deletion are verified in separate regressions.","Seven samples are exploratory; P95 and P99 can equal the maximum. No SLA or statistical confidence claim.","Rust cold timing includes executable validation, startup, SQLite loading and JSON parsing; warm timing includes process IPC and watermark checks.","SQLite-vec stores float32; cosine scores have a separate tolerance and zero-vector semantics are not assumed interchangeable.","RSS is the parent sample after each case, not a sampled process-tree peak; native and Worker allocations are not included.","OS page cache is not flushed; cold means a new Rust process and vector cache, not cold disk. Parent retains the reference cache in all modes, so RSS is not a per-mode memory comparison.","Native audio timing includes base64 and IPC; TS reference uses the same float32 mixing and linear resampling."] };
const metrics = values => {const sorted=[...values].sort((a,b)=>a-b);return {p50Ms:sorted[Math.ceil(sorted.length*.5)-1],p95Ms:sorted[Math.ceil(sorted.length*.95)-1],p99Ms:sorted[Math.ceil(sorted.length*.99)-1],sampleMs:values,parentRssBytes:process.memoryUsage().rss};};
async function measure(operation) {
  const times=[],delays=[];let result;
  for(let i=0;i<samples+warmup;i++) {
    await pause(1);const start=performance.now();const tick=pause(0).then(()=>performance.now()-start);
    result=await operation();const elapsed=performance.now()-start;const delay=await tick;
    if(i>=warmup){times.push(elapsed);delays.push(delay);}
  }
  return {result,...metrics(times),timerDelayMs:delays};
}
function tsSearch(rows,query,mode) {
  const heap=new TopK(10), all=[];
  for(let i=0;i<rows.length;i++) {const row=rows[i];const score=cosineSimilarity(query,typeof row.vector==="string"?JSON.parse(row.vector):row.vector);if(score<0)continue;const hit={id:row.id,score};if(mode==="sort")all.push(hit);else heap.add(hit,score);}
  return mode==="sort"?all.sort((a,b)=>b.score-a.score).slice(0,10):heap.values();
}
function parity(actual,expected,tolerance=1e-12) {
  if(JSON.stringify(actual.map(h=>h.id))!==JSON.stringify(expected.map(h=>h.id)))throw new Error("Vector candidate mismatch");
  const delta=Math.max(0,...actual.map((h,i)=>Math.abs(h.score-expected[i].score)));if(delta>tolerance)throw new Error("Vector score mismatch");return {identicalIds:true,maxScoreDelta:delta};
}
try {
  for(const count of sizes) {
    const path=join(work,`vectors-${count}.db`);const db=new DatabaseSync(path,{allowExtension:true});
    const runtime=new NativeRuntimeClient(artifact);let reader,typed;let state=42,queries=[];
    try {
      db.exec("PRAGMA journal_mode=WAL; CREATE TABLE memory_embeddings (id TEXT PRIMARY KEY,memory_id TEXT,dimension INTEGER,model_id TEXT,embedding_json TEXT,source_created_at TEXT,index_version INTEGER,created_at TEXT,updated_at TEXT);CREATE INDEX models ON memory_embeddings(model_id)");
      sqliteVec.load(db);db.exec(`CREATE VIRTUAL TABLE vectors USING vec0(id INTEGER PRIMARY KEY,embedding float[${dimensions}] distance_metric=cosine)`);
      const insert=db.prepare("INSERT INTO memory_embeddings(id,memory_id,model_id,embedding_json) VALUES (?, ?,'fixed',?)"), vecInsert=db.prepare("INSERT INTO vectors(id,embedding) VALUES (?,?)");
      db.exec("BEGIN");
      for(let i=0;i<count;i++) {const vector=Array.from({length:dimensions},()=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return state/0xffffffff*2-1;});if(i<samples+warmup)queries.push(vector);insert.run(String(i),String(i),JSON.stringify(vector));vecInsert.run(BigInt(i),Buffer.from(new Float32Array(vector).buffer));}
      db.exec("COMMIT");
      const select=db.prepare("SELECT memory_id as id,embedding_json as vector FROM memory_embeddings WHERE model_id='fixed'");
      const cached=select.all().map(r=>({id:r.id,vector:Float64Array.from(JSON.parse(r.vector)),norm:Math.sqrt(JSON.parse(r.vector).reduce((sum,v)=>sum+v*v,0))}));
      reader=await createDatabase({url:`file:${path}`});const repository=new SqliteMemoryEmbeddingRepository(reader.db);
      typed=new CachedMemoryVectorSearchAdapter(new SqliteMemoryVectorSearchAdapter(repository,"fixed"),{client:reader.client,databasePath:path,modelId:"fixed"});
      const expectedQueries=queries.map(q=>tsSearch(cached,q,"sort"));
      const cases=[];let current=0;
      for(const mode of ["sqlite-json-sort","sqlite-json-topk","sqlite-typed-cache","rust-sqlite-warm","rust-sqlite-cold","sqlite-vec"]) {
        const reference=[];current=0;
        const result=await measure(async()=>{
          const query=queries[current%queries.length],expected=expectedQueries[current%queries.length];current++;
          let hits;
          if(mode==="sqlite-json-sort")hits=tsSearch((await reader.client.execute("SELECT * FROM memory_embeddings WHERE model_id='fixed'")).rows.map(r=>({id:r.memory_id,vector:r.embedding_json})),query,"sort");
          if(mode==="sqlite-json-topk")hits=(await repository.retrieve({workspaceId:"local",subjectUserId:"local"},query,10,0,"fixed")).map(h=>({id:h.memoryId,score:h.score}));
          if(mode==="sqlite-typed-cache"){
            // Each query checks the writer changes and external commit watermarks.
            hits=await typed.search({workspaceId:"local",subjectUserId:"local"},query,10,0);
          }
          if(mode.startsWith("rust")) {
            if(mode.endsWith("cold"))await runtime.reset();
            if(!runtime.running)await runtime.request("vector.open",{path});
            hits=(await runtime.request("vector.search",{modelId:"fixed",query,topK:10,minScore:0})).hits;
          }
          if(mode==="sqlite-vec")hits=db.prepare("SELECT id,distance FROM vectors WHERE embedding MATCH ? AND k=10 ORDER BY distance").all(Buffer.from(new Float32Array(query).buffer)).map(h=>({id:String(h.id),score:1-h.distance})).filter(h=>h.score>=0);
          reference.push(parity(hits,expected,mode==="sqlite-vec"?1e-6:1e-12));return hits;
        });
        const {result:_result,...measurements}=result;cases.push({mode,...measurements,parity:reference});
        process.stdout.write(`${count} ${mode}: P95 ${measurements.p95Ms.toFixed(2)} ms\n`);
      }
      report.vector.push({rows:count,cases});
    } finally {await runtime.close();await typed?.close();reader?.client.close();db.close();}
  }
  const audio=new NativeAudioPreprocessor(artifact);
  try {
    for(const seconds of [1,60]) {
      const frames=48000*seconds,b=Buffer.alloc(44+frames*4);b.write("RIFF");b.writeUInt32LE(b.length-8,4);b.write("WAVEfmt ",8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(2,22);b.writeUInt32LE(48000,24);b.writeUInt32LE(192000,28);b.writeUInt16LE(4,32);b.writeUInt16LE(16,34);b.write("data",36);b.writeUInt32LE(frames*4,40);
      for(let i=0;i<frames;i++){const sample=Math.round(Math.sin(i*.1)*32000);b.writeInt16LE(sample,44+i*4);b.writeInt16LE(sample,46+i*4);}
      const reference=()=>{const mono=new Float32Array(frames);for(let i=0;i<frames;i++)mono[i]=(b.readInt16LE(44+i*4)/32768+b.readInt16LE(46+i*4)/32768)/2;const out=new Float32Array(16000*seconds);for(let i=0;i<out.length;i++)out[i]=mono[i*3];return out;};
      const expected=reference();
      for(const mode of ["ts","rust-ipc"]) {const measured=await measure(async()=>mode==="ts"?reference():audio.preprocess(b));if(measured.result.length!==expected.length||measured.result.some((v,i)=>Math.abs(v-expected[i])>1e-6))throw new Error("Audio parity mismatch");const {result:_result,...m}=measured;report.audio.push({seconds,mode,...m,parity:true});}
    }
  } finally {await audio.close();}
  const files=Object.fromEntries(Array.from({length:100},(_,i)=>[`${i}.txt`,[Buffer.from("source data\n".repeat(20000)),{mtime:new Date("2026-01-01T00:00:00Z")}]]));
  const archive=zipSync(files,{level:6});
  for(const mode of ["sync","worker"]) {const measured=await measure(async()=>mode==="sync"?unzipSync(archive):executeArchive({kind:"unpack",input:archive,limits:PLUGIN_ARCHIVE_LIMITS,isSafePath:isSafeZipEntryPath}));if(Object.keys(measured.result).length!==100)throw new Error("Archive parity mismatch");const {result:_result,...m}=measured;report.archive.push({mode,...m,files:100,compressedBytes:archive.length,expandedBytes:22000000,parity:true});}
  const output=resolve(options.out??"artifacts/native-search/runtime-benchmark.json");await mkdir(dirname(output),{recursive:true});
  const digest=createHash("sha256");
  const sources = ["scripts/benchmark-native-runtime.mjs", "scripts/build-native-runtime.mjs", "scripts/generate-native-protocol.mjs", "native/Cargo.toml", "native/Cargo.lock", "native/crates/runtime/Cargo.toml", "packages/repositories/src/search/cached-memory-vector-port.ts", "packages/repositories/src/search/native-memory-vector-port.ts", "packages/host-runtime/src/shared/archive-worker.ts"];
  for (const directory of ["packages/native-runtime/src", "native/crates/runtime/src", "native/protocol"]) {
    for (const entry of await readdir(join(root, directory), { recursive: true })) {
      if (/\.(?:rs|ts|json)$/.test(entry)) sources.push(`${directory}/${entry.replaceAll("\\", "/")}`);
    }
  }
  for (const path of sources.sort()) digest.update(path).update(await readFile(join(root, path)));
  report.implementationSha256=digest.update(artifact.sha256).digest("hex");
  await writeFile(output,JSON.stringify(report,null,2)+"\n");process.stdout.write(`Report: ${output}\n`);
} finally {await rm(work,{recursive:true,force:true});}
