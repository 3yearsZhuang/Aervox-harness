import type { ServerPluginRegistration } from "@aervox/host-plugin-api";
import { registerFlowCampusApiContract } from "./api-contract.js";
import { createFlowCampusEndpoints } from "./routes.js";
import { createFlowCampusToolContributions } from "./tools.js";

export const flowCampusRegistration: ServerPluginRegistration = {
  pluginId: "flowcampus", registerApiContract: registerFlowCampusApiContract,
  httpEndpoints: createFlowCampusEndpoints(), toolContributions: createFlowCampusToolContributions,
};
export default flowCampusRegistration;
export * from "./api-contract.js";
export * from "./routes.js";
export * from "./state.js";
export * from "./tools.js";
