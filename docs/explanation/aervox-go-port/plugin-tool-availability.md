# 第 13 批：插件工具贡献的可用性边界

**结论：插件工具已正确注册到工具目录，其处理器按「对话回合」构造，不能通过 REST 直接调用。这是设计行为，不是缺陷。**

本批纠正上一批的遗留判断。

## 上一批的遗留问题

第 12 批修好插件目录层级后，我在文档里写：

> 插件虽已 `available`，但其**运行时工具贡献**是否真正可用未验证。

本批验证，结论是**已正确注册，但调用方式受限**。

## 验证过程

### 工具已进入目录

`GET /v1/tools` 返回 24 个工具，其中至少 9 个来自插件：

| 工具 | 来源插件 |
|---|---|
| `anki_import_deck`、`anki_list_providers` | `ap-tool-anki-sync` |
| `homeassistant_call_service`、`homeassistant_get_state` | `ap-tool-home-assistant` |
| `ocr_parse_attachment` | `ap-tool-multimodal-ocr` |
| `diary_generate_styled`、`diary_list_styles` | `ap-workflow-diary-distillers` |
| `xiaomi_health_sync_daily` | `ap-sync-xiaomi-health` |

### REST 直接调用失败

```text
POST /v1/tools/anki_list_providers/call {}
→ 400 {"message":"tool handler not registered: anki_list_providers"}
```

授权后重试仍然失败：

```text
POST /v1/plugins/ap-workflow-diary-distillers/grants {"permission":"diary.read","scope":"*"}
→ 201

POST /v1/tools/diary_list_styles/call {}
→ 400 {"message":"tool handler not registered: diary_list_styles"}
```

### 逐项排除

| 假设 | 验证 | 结论 |
|---|---|---|
| 插件模块加载失败 | 在 PRoot 内 `import("@aervox/plugin-diary-distillers/server")` → `ok, has default: true, contributions: function` | 排除 |
| 包路径缺失 | `@aervox/plugin-*` 全部存在于 `node_modules` | 排除 |
| 装配条件不满足 | `/v1/plugins` 返回 10 个插件，`plugin_runtime_identity_unavailable` 为 0 条 | 排除 |
| 仓储记录不完整 | `SELECT id, version, availability, lifecycle_generation` 全部 `available` + `gen=yes` | 排除 |
| 授权不足 | 显式 grant 后仍失败 | 排除 |

## 真正的原因

工具目录（`/v1/tools`）与工具**处理器**是两个东西：

- **目录**来自 manifest 的 `spec.tools` 声明，随插件安装写入仓储，`/v1/tools` 读它。
- **处理器**由 `createRuntimeToolSink` 在**回合上下文**中通过 `preparePluginToolContributions` 构造，只在 Turn 执行期间存在于 `ToolRuntime` 的 `handlers` 表。

`host-tool-runtime.ts:416` 的判定：

```ts
const entry = this.handlers.get(toolId);
if (!entry) throw new HostToolForbiddenError(`tool handler not registered: ${toolId}`);
```

`/v1/tools/:id/call` 这条 REST 路径不处于任何回合，`handlers` 里自然没有插件工具。

代码注释也写明了这个设计：

> 工具贡献按回合上下文构造，故只把注册单元交给宿主；是否合入模型工具面由启用门控决定

以及 `plugin-tool-catalog.ts`：

> Context-bound handler objects differ between Turns. Their trusted implementation identity is the plugin generation.

## 与主仓测试的对照

主仓 `packages/host-runtime/test/plugin-runtime-catalogs.test.ts:79-80` 明确断言：

```ts
await expect(runtime.callTool(local, `${anki.pluginId}.anki_import_deck`, { content: "front\tback" }, { approval: true }))
  .rejects.toThrow("handler not registered");
```

测试正是**期望**这个报错。我在真机上复现的行为与主仓预期完全一致。

## 结论

| 问题 | 答案 |
|---|---|
| 插件工具是否注册成功 | ✅ 是，10 个插件、24 个工具在目录中 |
| 能否 REST 直调 | ❌ 不能，设计如此 |
| 能否在对话中被模型调用 | **未验证**（需配置模型） |
| 第 12 批的遗留判断 | 表述不准确，「不可用」应改为「调用路径受限」 |

## 仍需模型才能验证的部分

要真正验证插件工具可用，需要：

1. 配置一个支持工具调用的模型
2. 在对话中触发（例如「列出我的 Anki 题库」）
3. 观察模型是否正确调用 `anki_list_providers` 并拿到结果

这一步无法在没有模型密钥的情况下完成。
