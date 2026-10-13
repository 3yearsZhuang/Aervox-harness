import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { NativeRuntimeClient, loadNativeArtifact } from "../packages/native-runtime/dist/index.js";
const exec = promisify(execFile);
async function portPair() {
  for(let attempt=0;attempt<10;attempt++){
    const a=createServer(),b=createServer();
    await new Promise(resolve=>a.listen(0,"127.0.0.1",resolve));const port=a.address().port;
    try {await new Promise((resolve,reject)=>{b.once("error",reject);b.listen(port+1,"127.0.0.1",resolve);});return port;}
    catch {continue;}finally {await new Promise(resolve=>a.close(resolve));if(b.listening)await new Promise(resolve=>b.close(resolve));}
  }throw new Error("No free port pair");
}
test("real API/Worker share selected SQLite topology and stop without deleting data",{timeout:120000},async()=>{
  const data=await mkdtemp(join(tmpdir(),"aervox-supervisor-smoke-")),port=await portPair();let runtime;
  try {
    await exec(process.execPath,["scripts/native-runtime.mjs","init-supervisor",`--data-dir=${data}`,`--port=${port}`],{timeout:10000});
    const manifestPath=join(data,"native-supervisor.json"),manifest=JSON.parse(await readFile(manifestPath,"utf8"));
    const artifact=await loadNativeArtifact();assert.ok(artifact);
    runtime=new NativeRuntimeClient(artifact,{args:["supervise",manifestPath],timeoutMs:90000,idleMs:90000});
    const started=await runtime.request("supervisor.start");assert.equal(started.processes.length,2);
    const headers={Authorization:`Bearer ${manifest.processes[0].env.AERVOX_AUTH_TOKEN}`};
    assert.equal((await fetch(`http://127.0.0.1:${port}/v1/native-ready`,{headers,signal:AbortSignal.timeout(3000)})).status,200);
    assert.equal((await fetch(`http://127.0.0.1:${port}/v1/native-ready`,{signal:AbortSignal.timeout(3000)})).status,401);
    assert.equal((await fetch(`http://127.0.0.1:${port+1}/health`,{signal:AbortSignal.timeout(3000)})).status,200);
    assert.equal((await runtime.request("supervisor.stop")).processes.length,0);
    assert.ok((await readFile(join(data,"aervox.db"))).length>0);
    assert.ok((await readFile(join(data,"proactive-vault.db"))).length>0);
    assert.ok((await readFile(join(data,"proactive-vault.key"))).length>0);
    await assert.rejects(exec(process.execPath,["scripts/native-runtime.mjs","init-supervisor",`--data-dir=${data}`,`--port=${port}`],{timeout:10000}));
  } finally {await runtime?.close();await rm(data,{recursive:true,force:true});}
});
