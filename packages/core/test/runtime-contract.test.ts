import { HostToolRuntime } from "../src/host-tool-runtime.js";
import { runtimeContract } from "./runtime-contract.js";
runtimeContract("memory runtime contract", () => new HostToolRuntime());
