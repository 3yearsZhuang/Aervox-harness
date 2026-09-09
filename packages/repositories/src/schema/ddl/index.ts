/**
 * Aervox｜思隅 @aervox/repositories — 数据库 DDL 初始化（自 schema/init.ts 机械拆分）
 */
import type { Client } from "@libsql/client";
import { createConversationsTables } from "./conversations.js";
import { createMemoriesTables } from "./memories.js";
import { createMemoryCompactionTables } from "./memory-compaction.js";
import { createEmbeddingsTables } from "./embeddings.js";
import { createDiariesTables } from "./diaries.js";
import { createOutboxTables } from "./outbox.js";
import { createLearningTables } from "./learning.js";
import { createFeedbackTables } from "./feedback.js";
import { createProvenanceTables } from "./provenance.js";
import { createPlatformTables } from "./platform.js";
import { createAuditTables } from "./audit.js";
import { createSafetyTables } from "./safety.js";
import { createPrivacyTables } from "./privacy.js";
import { createAnalyticsTables } from "./analytics.js";
import { createContentTables } from "./content.js";
import { createEcosystemTables } from "./ecosystem.js";
import { createPersonaTables } from "./persona.js";
import { createWorkspaceSkillsTables } from "./workspace-skills.js";
import { createMcpToolsTables } from "./mcp-tools.js";
import { createFtsTables } from "./fts.js";
import { createToolRegistryTables } from "./tool-registry.js";
import { createMcpTables } from "./mcp.js";
import { createPluginConfigTables } from "./plugin-config.js";
import { createSkillsTables } from "./skills.js";
import { createPreferencesTables } from "./preferences.js";
import { createStudyMaterialsTables } from "./study-materials.js";
import { createVoiceTables } from "./voice.js";
import { createLlmTables } from "./llm.js";
import { createToolExecutionsTables } from "./tool-executions.js";
import { createToolApprovalsTables } from "./tool-approvals.js";
import { createSafeSegmentsTables } from "./safe-segments.js";
import { createAgentInboxTables } from "./agent-inbox.js";
import { createSubagentRunsTables } from "./subagent-runs.js";
import { createUserQuestionTables } from "./user-question.js";
import { createProactiveTables } from "./proactive.js";
import { createProactiveIntelligenceTables } from "./proactive-intelligence.js";
import { createLedgerTables } from "./ledger.js";

export async function initDatabaseSchema(client: Client): Promise<void> {
  await createConversationsTables(client);
  await createMemoriesTables(client);
  await createMemoryCompactionTables(client);
  await createEmbeddingsTables(client);
  await createDiariesTables(client);
  await createOutboxTables(client);
  await createLearningTables(client);
  await createFeedbackTables(client);
  await createProvenanceTables(client);
  await createPlatformTables(client);
  await createAuditTables(client);
  await createSafetyTables(client);
  await createPrivacyTables(client);
  await createAnalyticsTables(client);
  await createContentTables(client);
  await createEcosystemTables(client);
  await createPersonaTables(client);
  await createWorkspaceSkillsTables(client);
  await createMcpToolsTables(client);
  await createFtsTables(client);
  await createToolRegistryTables(client);
  await createMcpTables(client);
  await createPluginConfigTables(client);
  await createSkillsTables(client);
  await createPreferencesTables(client);
  await createStudyMaterialsTables(client);
  await createVoiceTables(client);
  await createLlmTables(client);
  await createToolExecutionsTables(client);
  await createToolApprovalsTables(client);
  await createSafeSegmentsTables(client);
  await createAgentInboxTables(client);
  await createSubagentRunsTables(client);
  await createUserQuestionTables(client);
  await createProactiveTables(client);
  await createProactiveIntelligenceTables(client);
}

export async function initLedgerSchema(client: Client): Promise<void> {
  await createLedgerTables(client);
}
