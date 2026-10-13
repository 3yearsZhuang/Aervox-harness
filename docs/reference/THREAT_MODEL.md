---
id: AVX-SEC-001
---

# Aervox｜思隅 威胁模型

关联：[架构设计](ARCHITECTURE.md) · [数据与隐私](DATA_PRIVACY.md) · `CR-023`（已归档） · `CR-024`（已归档） · `CR-030`（已归档）

## 1. 范围与资产

范围包括本机 Web/API/Worker、SQLite、独立故障域 `RecoveryControlLedger`、模型/通知供应商、Electron、插件/外部连接、CAP-033 主动智能模式本地 Host，以及 CAP-034/035 的 Home Assistant 和小米健康连接。关键资产包括本地数据库与备份、迁移状态清单、HA Token、实体/服务白名单、小米 OAuth 凭据、睡眠与心率样本。

部署与生产启用状态统一见[追踪矩阵](REQUIREMENTS_TRACEABILITY.md#4-cap-001cap-035-覆盖矩阵全部能力状态唯一速览)；新增来源、跨设备访问或外部处理者必须扩展本模型。

## 2. 信任边界

1. 当前操作系统用户/桌面 renderer ↔ 本机 API；loopback ↔ 非 loopback 监听是显式安全边界。
2. API/Worker ↔ SQLite/本地对象目录；业务库 ↔ 独立 `RecoveryControlLedger` 是不能假定原子提交的跨故障域边界。
3. Aervox ↔ AI/通知/分析供应商。
4. 当前操作系统用户的数据目录 ↔ 其他本机用户和未认证局域网客户端。
5. 核心应用 ↔ 外部内容、OAuth 集成、插件/DSH/pi/MCP。
6. Electron renderer ↔ preload/主进程/操作系统。
7. CAP-033 受信观察 Host/后台 helper ↔ 操作系统权限、文件系统、浏览器/通信连接器和设备传感器。
8. CAP-033 本地私密存储/处理器 ↔ 普通业务数据库、远程模型/Embedding、日志/分析/备份和用户导出目标。
9. CAP-033 主动动作 Host ↔ 本地文件、浏览器/家居、外部消息和特权系统 API。
10. CAP-033 loopback 控制面 ↔ owner-only `proactive-access.token`（私密目录 `0600`）、HTTP 传输和 redirect/代理路径。
11. CAP-034 本地连接网关 ↔ 私网 Home Assistant REST/WebSocket、实体目录和 service 调用。
12. CAP-035 本地连接网关 ↔ 用户获准的小米开放平台 HTTPS/OAuth 与每日健康汇总。
13. API/model-runtime ↔ 本地 llama.cpp 侧车（仅 loopback HTTP 健康检查与补全端点）。

## 3. 威胁登记（STRIDE）

| ID | 类别 | 威胁与影响 | 主要控制 | 验证/残余风险 |
|---|---|---|---|---|
| TM-001 | Spoofing | 非本机客户端伪造会话、窃取本地 token 或重放写请求 | 默认 loopback、非 loopback 强制 token、CSRF/nonce、幂等键、token 不入日志 | `TC-SEC-LOCAL-API-001`、`TC-SEC-AUTH-001`；远程开关配置错误为阻断 |
| TM-002 | Tampering | 修改消息版本、记忆证据、日记来源或删除状态 | 不可变版本、外键、checksum、事务 Outbox、审计 | `TC-INTEG-SOURCE-001`；管理员权限仍需最小化 |
| TM-003 | Repudiation | 管理员/插件否认访问、用户删除无证据 | AuditRecord、ConsentGrant、DeletionTarget、模型/Prompt 版本 | `TC-SEC-AUDIT-001`；审计不能包含原文 |
| TM-004 | Information disclosure | API 监听所有网卡、数据目录权限过宽或插件越权导致私人内容泄漏 | loopback 默认、open auth 禁止非 loopback、用户目录 ACL、`actorId`/Grant 分离、默认无插件权限、脱敏日志 | `TC-SEC-LOCAL-API-001`、`TC-SEC-LOCAL-FS-001`；配置错误为严重阻断 |
| TM-005 | Denial of service | 流式会话、OCR、日记或插件耗尽模型/队列/CPU | 限流、配额、队列隔离、超时、熔断、预算门槛 | `TC-PERF-ABUSE-001`；供应商级故障用备用/只读降级 |
| TM-006 | Elevation | Prompt injection 或插件提升工具/文件/网络权限 | 信任层隔离、ToolPolicy、进程外沙箱、allowlist、kill switch | `TC-SEC-PROMPT-001`、`TC-SEC-PLUG-001` |
| TM-007 | Disclosure | 模型/监控供应商保留或训练私人内容 | Provider 审查、用途同意、最小 ContextManifest、关闭训练、合同删除 | `TC-PRIV-PROVIDER-001`；无合格供应商则不启用该用途 |
| TM-008 | Tampering/Disclosure | 删除后索引、缓存、备份或供应商副本复活，或恢复时漏掉撤权事件 | `RecoveryControlLedger` 先 durable append 作为 deny 控制事实源；业务状态按 sequence 幂等重放；序列缺口/账本不可用/水位未追平时 fail closed；零召回验证 | `TC-PRIV-DEL-001`、`TC-RES-LEDGER-001`；供应商 SLA 超时需告警和用户状态 |
| TM-009 | Elevation | Electron renderer 取得 Node/OS 权限 | contextIsolation、禁用 nodeIntegration、schema IPC、签名更新 | `TC-SEC-DESKTOP-001`；R3 前阻断 |
| TM-010 | Abuse | 情绪脆弱/危机内容被用于留存、推荐或日记 | purpose 隔离、安全事件受限、禁止商业定向/关系分数 | `TC-AIEVAL-SAFE-001`；政策误分类持续监控 |
| TM-011 | Supply chain | 依赖、参考代码或插件引入恶意代码/许可证风险 | lockfile、SBOM、签名、漏洞/许可证扫描、AGPL 隔离 | `TC-SEC-SUPPLY-001`；高危/许可未决阻断发布 |
| TM-012 | Data poisoning | 外部题库/附件污染掌握度、记忆或知识树 | 来源/许可/置信状态、人工纠正、候选机制、回滚 | `TC-AIEVAL-POISON-001`；低置信内容不入正式事实 |
| TM-013 | Elevation/Disclosure | 插件 Page 越权读取配置、secret 泄露或静态资源逃逸 | 受限 iframe sandbox、Host Bridge 能力白名单、Bundle 路径安全与 checksum、secret 不回显、AuditRecord | `TC-SEC-PLUG-001`、`TC-SEC-PLUG-CFG-001`；本地默认 secret 存储必须替换为加密 Store 后上线 |
| TM-014 | Disclosure/Tampering | CAP-033 原始屏幕、音频、输入、剪贴板或文件副本被写入远程存储/模型/日志，或七天提炼前被错误清理 | 独立本地加密存储、`local_only` provenance、Provider/出网准入、七天+distillation gate、零外传/零召回测试 | `TC-SEC-PRO-LOCAL-001`、`TC-PRIV-PRO-RETENTION-001`；本地证明失效时 fail closed |
| TM-015 | Elevation/Disclosure | CAP-033 观察内容或 Prompt injection 扩大 `FullProfileActionGrant`，跨用户操作、外发或不可逆修改 | 用户确认的版本化 action grant、目标 scope/OS/身份校验、沙箱、幂等、deny ledger 和动作审计 | `TC-SEC-PRO-ACTION-001`、`TC-SEC-PROMPT-001`；模型/插件不能自授 |
| TM-016 | Spoofing/Repudiation | 伪造设备/Host/activation epoch 或重放后台恢复，绕过用户通知和撤权 | 签名 Host、设备绑定、heartbeat/expiry、版本和 grant hash、审计回执、恢复竞争 CAS | `TC-SEC-PRO-HOST-001`、`TC-RES-PRO-LIFECYCLE-001` |
| TM-017 | Disclosure | 全量画像导出、云同步目录或备份误带密钥、凭据、Secure Input 或已删除内容 | 导出 manifest/checksum、字段过滤、目标提示、密钥隔离、删除 tombstone 不可恢复 | `TC-PRIV-PRO-EXPORT-001`、`TC-SEC-PRO-LOCAL-001` |
| TM-018 | Spoofing/Disclosure | 非本机进程伪造 CAP-033 控制请求，或 token 经日志/代理/重定向泄露 | owner-only token、`0600` 文件权限、字面 loopback 校验、禁止 redirect、请求不写入日志/导出 | `TC-SEC-PRO-AUTH-001`、`TC-SEC-PRO-LOCAL-001` |
| TM-019 | Spoofing/Elevation | 恶意 HA 地址通过 DNS/redirect 访问公网或本机敏感服务，未授权实体/服务被模型控制 | 仅私网/回环/`.local`、DNS 全地址校验、redirect 拒绝、实体默认禁用、service 白名单、`action.external` 动作授权 | `TC-SEC-HA-SSRF-001`、`TC-SEC-HA-ACTION-001`；HA 侧 LLAT 仍需用户撤销 |
| TM-020 | Disclosure/Supply chain | 小米 Token、Client Secret、睡眠/心率或完整供应商响应进入日志、模型、导出，或使用未获准的私有接口 | Vault 加密、凭据零回显、只存规范化每日指标、HTTPS、官方开放平台配置声明、连接级删除 | `TC-PRIV-EXT-CREDENTIAL-001`、`TC-PRIV-HEALTH-001`；厂商政策与账号资格仍是外部风险 |
| TM-021 | Tampering/Disclosure | CR-030 迁移中断、选错数据范围、静默去重或原地删列导致数据不可恢复 | 停写锁、一致性备份、显式范围选择、staging 新库、冲突 fail closed、完整性/行数校验、原子换库和 rollback 包 | `TC-MIG-CR030-*`；新库产生写入后回滚需用户确认且可能丢失新数据 |

## 4. 数据流安全规则

来源、控制水位与删除/恢复顺序见[数据隐私](DATA_PRIVACY.md#8-删除传播)和 [BR-CTRL-001](SRS.md#srs-br-ctrl)；输入/输出检查与失败响应见[AI 质量](AI_QUALITY_SAFETY.md#3-编排流水线)。客户端不能直接持有模型/持久对象服务凭据，附件经受限本机 API 访问且凭据不进入 URL。威胁控制必须覆盖普通历史、SSE、工具结果和派生内容，不能只检查直接捕获接口。

## 5. 发布门禁

安全、供应链、删除恢复与 CAP-033～035 的发布条件集中在[追踪基线](REQUIREMENTS_TRACEABILITY.md#91-专项发布门禁)。本文件维护攻击面、控制和残余威胁；目标部署或供应商改变时重新评估，不能把测试路径当作生产许可。
