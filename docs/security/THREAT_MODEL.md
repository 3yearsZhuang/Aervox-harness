# Aervox｜思隅 威胁模型

> 文档编号：AVX-SEC-001  
> 版本：v0.1（评审候选）  
> 更新日期：2026-08-24  
> Owner：待指定  
> 关联：[架构设计](../ARCHITECTURE.md) · [数据与隐私](../DATA_PRIVACY.md)

## 1. 范围与资产

范围包括 Web/API/Worker、PostgreSQL、Redis/BullMQ、S3、独立故障域 `RecoveryControlLedger`、模型/身份/通知供应商、Electron、P2 插件/外部同步和 P3 组织权限。关键资产：凭据、私人会话、作答、记忆、日记、附件、安全事件、同意、撤权/删除 deny 控制事件、模型上下文和组织角色。

不在当前生产范围：未成年人、设备屏幕/麦克风/摄像头捕获、社区私信、市场支付和任意第三方插件执行；这些能力启用前必须扩展本模型。

## 2. 信任边界

1. 用户客户端 ↔ CDN/WAF/API。
2. API/Worker ↔ PostgreSQL/Redis/S3；业务库 ↔ 独立 `RecoveryControlLedger` 是不能假定原子提交的跨故障域边界。
3. Aervox ↔ OIDC/AI/通知/分析供应商。
4. 用户工作区 ↔ 其他工作区/组织管理员。
5. 核心应用 ↔ 外部内容、OAuth 集成、插件/DSH/pi/MCP。
6. Electron renderer ↔ preload/主进程/操作系统。

## 3. 威胁登记（STRIDE）

| ID | 类别 | 威胁与影响 | 主要控制 | 验证/残余风险 |
|---|---|---|---|---|
| TM-001 | Spoofing | 会话劫持、伪造身份或重放写请求 | OIDC、Secure/HttpOnly/SameSite Cookie、PKCE、CSRF、nonce、幂等键 | `TC-SEC-AUTH-001`；身份供应商故障需降级为只读 |
| TM-002 | Tampering | 修改消息版本、记忆证据、日记来源或删除状态 | 不可变版本、外键、checksum、事务 Outbox、审计 | `TC-INTEG-SOURCE-001`；管理员权限仍需最小化 |
| TM-003 | Repudiation | 管理员/插件否认访问、用户删除无证据 | AuditRecord、ConsentGrant、DeletionTarget、模型/Prompt 版本 | `TC-SEC-AUDIT-001`；审计不能包含原文 |
| TM-004 | Information disclosure | 跨工作区、数据主体、组织或插件泄漏私人内容 | `(workspaceId,subjectUserId)` + RLS/复合外键、`actorId` 分离、字段级授权、默认无插件权限、脱敏日志 | `TC-SEC-TENANT-001`；配置错误为严重阻断 |
| TM-005 | Denial of service | 流式会话、OCR、日记或插件耗尽模型/队列/CPU | WAF/限流、配额、队列隔离、超时、熔断、预算门槛 | `TC-PERF-ABUSE-001`；供应商级故障用备用/只读降级 |
| TM-006 | Elevation | Prompt injection 或插件提升工具/文件/网络权限 | 信任层隔离、ToolPolicy、进程外沙箱、allowlist、kill switch | `TC-SEC-PROMPT-001`、`TC-SEC-PLUG-001` |
| TM-007 | Disclosure | 模型/监控供应商保留或训练私人内容 | Provider 审查、用途同意、最小 ContextManifest、关闭训练、合同删除 | `TC-PRIV-PROVIDER-001`；无合格供应商则不启用该用途 |
| TM-008 | Tampering/Disclosure | 删除后索引、缓存、备份或供应商副本复活，或恢复时漏掉撤权事件 | `RecoveryControlLedger` 先 durable append 作为 deny 控制事实源；业务状态按 sequence 幂等重放；序列缺口/账本不可用/水位未追平时 fail closed；零召回验证 | `TC-PRIV-DEL-001`、`TC-RES-LEDGER-001`；供应商 SLA 超时需告警和用户状态 |
| TM-009 | Elevation | Electron renderer 取得 Node/OS 权限 | contextIsolation、禁用 nodeIntegration、schema IPC、签名更新 | `TC-SEC-DESKTOP-001`；R3 前阻断 |
| TM-010 | Abuse | 情绪脆弱/危机内容被用于留存、推荐或日记 | purpose 隔离、安全事件受限、禁止商业定向/关系分数 | `TC-AIEVAL-SAFE-001`；政策误分类持续监控 |
| TM-011 | Supply chain | 依赖、参考代码或插件引入恶意代码/许可证风险 | lockfile、SBOM、签名、漏洞/许可证扫描、AGPL 隔离 | `TC-SEC-SUPPLY-001`；高危/许可未决阻断发布 |
| TM-012 | Data poisoning | 外部题库/附件污染掌握度、记忆或知识树 | 来源/许可/置信状态、人工纠正、候选机制、回滚 | `TC-AIEVAL-POISON-001`；低置信内容不入正式事实 |

## 4. 数据流安全规则

- 客户端不能直接调用模型或持久对象服务；签名 URL 短期有效且绑定工作区/对象用途。
- 模型收到的是经同意、权限和 token budget 过滤的 ContextManifest；Restricted 数据默认排除。
- 模型只能请求工具，服务端 ToolPolicy 作最终授权；插件/外部内容不能修改该策略。
- 输入先安全分类；输出在持久化/展示前做 schema、引用和安全验证。分类不可用时采用固定保守响应。
- 所有来源删除/撤权先向独立 `RecoveryControlLedger` 追加不可变 deny 事件并取得 durable ack，再提交业务状态和异步清理；账本事件使用幂等键和连续 sequence。账本已写而业务提交失败由 reconciler 重放；账本不可用、签名/序列校验失败或应用水位未追平时相关范围 fail closed。恢复环境在对外服务前校验最老备份覆盖、重放账本并完成零召回/零越权验证。

## 5. 发布门禁

- 所有 Critical/High 威胁有 Owner、自动化测试、告警和残余风险批准；
- OWASP ASVS L2 基线、依赖/Secret/SBOM/许可证扫描通过；
- 跨工作区、管理员、组织、插件、附件、Prompt injection 和 Electron IPC 测试通过；
- 删除、导出、备份恢复、Redis 重建和供应商故障演练通过；
- 未成年人、设备捕获、社区、市场、支付或机构能力的新增数据流已经加入本威胁模型。

本文件仍为评审候选，Owner 和目标部署/供应商确定后必须重新评分概率和影响。
