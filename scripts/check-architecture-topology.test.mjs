import test from "node:test";
import assert from "node:assert/strict";
import { parseArchitecturePackages, inspectTopology } from "./check-architecture-topology.mjs";

test("check-architecture-topology: parses declared packages from section", () => {
  const sample = `
## 3. 仓库与领域边界

\`\`\`text
apps/
  api/          # Fastify
  worker/       # Worker
packages/
  contracts/    # Contracts
  schema/       # Schema
\`\`\`
  `;
  const pkgs = parseArchitecturePackages(sample);
  assert.deepEqual(pkgs, ["apps/api", "apps/worker", "packages/contracts", "packages/schema"]);
});

test("check-architecture-topology: detects missing packages in doc", () => {
  const sample = `
## 3. 仓库与领域边界

\`\`\`text
apps/
  api/
packages/
  contracts/
\`\`\`
  `;
  const disk = ["apps/api", "apps/worker", "packages/contracts"];
  const result = inspectTopology(sample, disk);
  assert.deepEqual(result.missingInDoc, ["apps/worker"]);
  assert.deepEqual(result.missingOnDisk, []);
});

test("check-architecture-topology: detects non-existent packages declared in doc", () => {
  const sample = `
## 3. 仓库与领域边界

\`\`\`text
apps/
  api/
  ghost/
packages/
  contracts/
\`\`\`
  `;
  const disk = ["apps/api", "packages/contracts"];
  const result = inspectTopology(sample, disk);
  assert.deepEqual(result.missingInDoc, []);
  assert.deepEqual(result.missingOnDisk, ["apps/ghost"]);
});
