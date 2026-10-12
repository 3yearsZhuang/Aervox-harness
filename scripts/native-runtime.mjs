import { NativeRuntimeClient, loadNativeArtifact } from "../packages/native-runtime/dist/index.js";
import { createHash, createPrivateKey, sign, randomBytes } from "node:crypto";
import { readFile, writeFile, mkdir, chmod } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [command = "info", ...args] = process.argv.slice(2);
const artifact = await loadNativeArtifact();
if (!artifact) throw new Error("Native artifact missing; run mise tasks run native-runtime-build");
const options = Object.fromEntries(args.filter(a=>a.startsWith("--")).map(a=>a.slice(2).split("=")));
if (command === "sign") {
  if (!options.key || !options.manifest) throw new Error("sign needs --key=PRIVATE_KEY_PATH and --manifest=ARTIFACT_JSON");
  const path = resolve(options.manifest), manifest = JSON.parse(await readFile(path,"utf8"));
  const binary = join(dirname(path),manifest.binary), digest = createHash("sha256").update(await readFile(binary)).digest();
  const key = createPrivateKey(await readFile(resolve(options.key)));
  if (key.asymmetricKeyType !== "ed25519") throw new Error("Release key must use Ed25519");
  manifest.sha256 = digest.toString("hex"); manifest.signature = sign(null,digest,key).toString("base64");
  await writeFile(path,JSON.stringify(manifest,null,2)+"\n");
  process.stdout.write("Artifact signed; embed its public key in the release build.\n");
} else if (command === "init-supervisor") {
  if (!options["data-dir"]) throw new Error("init-supervisor needs an explicitly selected --data-dir=PATH");
  const dataDir = resolve(options["data-dir"]), port = Number(options.port ?? 3000);
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65534) throw new Error("Invalid API port");
  await mkdir(dataDir,{recursive:true,mode:0o700});
  const tokenPath = join(dataDir,"api-access.token");
  try { await writeFile(tokenPath,randomBytes(32).toString("hex"),{flag:"wx",mode:0o600}); } catch(e) {if(e.code!=="EEXIST")throw e;}
  const token = (await readFile(tokenPath,"utf8")).trim();
  if (!/^[a-f0-9]{64}$/u.test(token)) throw new Error("Existing API token is invalid");
  const sha256 = createHash("sha256").update(await readFile(process.execPath)).digest("hex");
  const database = join(dataDir,"aervox.db");
  const env = { DATABASE_URL:`file:${database}`, AERVOX_AUTH_MODE:"token", AERVOX_AUTH_TOKEN:token, PORT:String(port), AERVOX_API_HOST:"127.0.0.1",
    AERVOX_NATIVE_DATA_DIR:dataDir,
    AERVOX_WORKER_IPC_SOCKET:process.platform === "win32" ? `\\\\.\\pipe\\aervox-${createHash("sha256").update(dataDir).digest("hex").slice(0,16)}` : join(dataDir,"worker.sock"),
    AERVOX_PROACTIVE_VAULT_URL:`file:${join(dataDir,"proactive-vault.db")}`,
    AERVOX_PROACTIVE_VAULT_KEY_PATH:join(dataDir,"proactive-vault.key"),
    AERVOX_PROACTIVE_ACCESS_TOKEN_PATH:join(dataDir,"proactive-access.token") };
  const manifest = {protocol:1,version:"0.1.0",dataDir,processes:[
    {role:"api",executable:process.execPath,sha256,cwd:root,args:[join(root,"apps/api/dist/index.js")],env,ready:{port,path:"/v1/native-ready",tokenEnv:"AERVOX_AUTH_TOKEN"},startupMs:30000},
    {role:"worker",executable:process.execPath,sha256,cwd:root,args:[join(root,"apps/worker/dist/index.js")],env:{...env,AERVOX_WORKER_HEALTH_PORT:String(port+1)},ready:{port:port+1,path:"/health"},startupMs:30000},
  ]};
  const path = resolve(options.out ?? join(dataDir,"native-supervisor.json"));
  // Never overwrite an existing deployment or alter its selected data range implicitly.
  await writeFile(path,JSON.stringify(manifest,null,2)+"\n",{flag:"wx",mode:0o600});
  if (process.platform !== "win32") await chmod(path,0o600);
  process.stdout.write(`Supervisor manifest: ${path}\n`);
} else if (command === "supervise") {
  const manifest = args.find(a=>!a.startsWith("--")); if(!manifest)throw new Error("supervise needs a manifest path");
  const runtime = new NativeRuntimeClient(artifact,{args:["supervise",resolve(manifest)],timeoutMs:120000,idleMs:30000});
  let closing = false;
  const close = async () => {if(closing)return;closing=true;clearInterval(timer);await runtime.close();};
  let timer;
  try {
    const started = await runtime.request("supervisor.start"); process.stdout.write(JSON.stringify(started)+"\n");
    timer=setInterval(()=>{void runtime.request("supervisor.status").then(status=>{if(Object.keys(status.failures).length){process.stderr.write(JSON.stringify(status)+"\n");void close();process.exitCode=1;}}).catch(()=>{void close();process.exitCode=1;});},1000);
    process.once("SIGTERM",()=>void close());process.once("SIGINT",()=>void close());
  } catch(error) {await close();throw error;}
} else {
  const runtime = new NativeRuntimeClient(artifact);
  try {process.stdout.write(JSON.stringify(await runtime.request(command === "probe" ? "activity.probe" : "hello"),null,2)+"\n");}
  finally {await runtime.close();}
}
