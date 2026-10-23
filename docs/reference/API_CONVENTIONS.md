# HTTP API 约定

HTTP 数据与操作的事实源是 `@aervox/contracts`；[流式协议](STREAMING_PROTOCOL.md)定义 Turn/SSE 状态、重连、幂等和取消；[插件规范](plugin-config-and-pages.md)定义扩展贡献。本文维护跨模块约定，不复制字段目录。生成文档通过 `/openapi.json` 读取。

## 请求身份与资源

- `/v1` 是当前 HTTP 主版本。本地数据库只有一位用户；不接受客户端提供的工作区、用户或审计身份请求头。`LocalContext` 由宿主创建。
- Token 模式只使用 `Authorization: Bearer …`。开发用 loopback open 模式不要求 Token；生产和非 loopback 访问遵守[认证实现](../../packages/host-runtime/src/shared/auth.ts)。OpenAPI 的 Bearer 声明描述受保护部署。
- 浏览器来源在认证和路由执行前校验：默认仅允许 HTTP(S) loopback Origin，拒绝 `null`、畸形来源和外部网页；open 模式同时要求 loopback Host，防止 DNS rebinding。无 Origin 的本地 CLI/桌面主进程请求沿用原认证方式。Token 部署可通过 `AERVOX_API_ALLOWED_ORIGINS` 配置精确的额外 Origin（逗号分隔，包括所需移动 WebView 来源）；禁止通配符、路径和 URL 凭据，open 模式不允许追加。合法 CORS 预检只协商访问，实际 JSON、SSE、资源和写请求仍校验 Bearer；不使用 Origin 代替身份认证。
- sandbox Page 的静态资源是唯一 opaque Origin 例外：仅 GET/HEAD 的 Page assets 与 Bridge SDK，且 Fetch Metadata 对应文档导航或脚本、样式、图片、字体加载。模块/字体的 `Origin: null` 只在这些只读资源响应中获得 CORS；`fetch` 的空 destination、JSON、SSE、写请求和预检不适用。该例外保留页面资源的启用状态、文件边界、CSP 及 Token 校验，不签发 Page 凭据，Token 资源通道继续由 [ITER-006](../../plan.md#iter-006) 协调。
- 凭据不得放入 URL、查询参数、日志或 Page 资源地址。Page 资源认证通道有独立边界，见插件规范。
- 路径参数由共享客户端编码为单个路径片段；请求体、路径参数和分页上限由对应 Schema 校验。日期使用明确的 ISO 日期/时间语义，不用本地显示格式作为传输值。
- 重试只在操作的幂等合同允许时进行。创建 Turn 使用稳定的 `Idempotency-Key`；普通 HTTP 失败不会授权客户端重新执行有副作用的操作。

## 操作声明与覆盖

新 JSON 端点优先使用 [ApiEndpoint](../../packages/contracts/src/http-api.ts) 定义方法、路径、稳定 `operationId`、输入、成功响应及错误响应；使用宿主 [registerContractRoute](../../packages/host-runtime/src/shared/contract-route.ts) 注册，并由 OpenAPI 与共享客户端消费同一声明。已有切片包括 [Model Runtime](../../packages/contracts/src/model-runtime-api.ts)、[隐私授权与删除请求](../../packages/contracts/src/privacy-api.ts)、[用户偏好](../../packages/contracts/src/preferences-api.ts)、[插件配置](../../packages/contracts/src/plugin-config-api.ts)、[基础技能管理](../../packages/contracts/src/skills-api.ts)、[会话分支](../../packages/contracts/src/branches-api.ts)和[质量反馈](../../packages/contracts/src/feedback-api.ts)。共享声明校验路径、查询参数、请求体和成功响应；SSE、文件和已有路由可以保留专用适配器，但仍须登记协议。

新声明中需要请求体的操作显式设置 `bodyRequired: true`，使 OpenAPI 的请求体存在性与运行时 Schema 校验一致；这与对象内部的必填字段不同。隐私授权、删除请求和偏好保存、更新缺少请求体时返回 400；撤销授权与重置偏好保留无请求体调用。

插件 Schema 注册和配置保存也要求请求体，分别以 `INVALID_CONFIG_SCHEMA`、`INVALID_CONFIG` 返回 400；配置保存的 revision 必须为非负整数。Schema 注册使用完整 DSL，读取和注册成功返回 `{schemaVersion, fields}`；共享校验先检查深度，再解析递归字段。声明中的 `openapi` 表示仅供生成器使用的简化递归表示，宿主和客户端仍使用完整运行时校验。重置保留无请求体调用；配置修订 CAS、Secret 脱敏、停用插件冲突和包声明不可变性见[插件规范](plugin-config-and-pages.md#2-配置存储与-api)。

认证由宿主统一执行，插件或业务 handler 不能通过自定义声明降低要求。共享契约不得导入具体插件实现或宿主应用。

`POST /v1/consent` 的审计操作者只取宿主认证上下文；兼容请求中的 `actorId` 被忽略，不能覆盖服务端身份。`GET /v1/consent` 缺少或留空 purpose/scope 时继续返回 `{ active: false }`，重复查询键等非字符串输入返回 400。未配置偏好时保留 `id: null`、`version: 0` 的中性默认响应，不创建持久化记录；保存、更新和重置返回持久化版本。`POST /v1/deletions` 返回 202 仅证明受理，保留显式目标去重与幂等重放，不表示清理或独立验证已经完成。

基础技能管理保留本地注册表的实际返回：列表为 `{ items }`，元数据的 `active/readonly` 为 0 或 1，内容读取包含 `name/description/content`；不转换为旧工作区 Skill 模型。安装以 JSON `zipBase64` 承载 ZIP，单技能包须提供目标名，名称空白仍由管理器归一化；`overwrite` 省略等同 false，只接受布尔值。安装与启停缺少请求体、错误字段类型或重复筛选键返回 400；列表仅在 `activeOnly=true` 时过滤启用项。删除成功返回无内容的 204，技能不存在、只读或目录所有权冲突返回 409。归档输入错误与内部文件系统、数据库、Worker 故障分别处理，内部故障交由统一错误处理隐藏诊断；取消和写入边界继续遵守[归档与所有权契约](plugin-config-and-pages.md#归档资源与-skill-所有权)。Neo 候选及发布生命周期仍为后续迁移范围。

会话分支的 8 个操作保留实际记录语义：列表和地图为 `{ items }`，根会话不存在时返回空列表；创建返回 201，合并和归档只更新分支状态，删除返回 200 的软删除记录，不删除会话或消息。布局更新要求 `layoutData` 字段，接受任意 JSON（包括 null），布局元数据不改变内容。地图读取保留多个父节点、循环及独立的重复边，每个可达会话只查询一次、每个分支 ID 只返回一次；顺序为直接兄弟先列，再按兄弟顺序读取后代。单次最多查询 1,000 个会话（包括根与无子分支的叶节点）、返回 10,000 条唯一分支；SQL 每次只物化剩余分支预算加一条哨兵，超过任一预算返回 422、固定 `branch_tree_limit_exceeded`，不返回部分成功。预算限制单次读取，不拒绝合法图写入或删除数据；客户端不得通过参数扩大预算。请求断开在每次查询前后终止后续遍历，已开始的单次 SQL 查询可以完成；行预算限制结果物化，不承诺数据库扫描、排序耗时或单条布局字节数有硬上限。来源归属与完整 CAP-014 验收继续按[需求边界](SRS.md#prd-cap-014-019)推进。

质量反馈的 POST 要求请求体和三个非空字符串 `subjectType/subjectId/type`，保留扩展类型和原有空白字符串行为；`note` 可以省略或为 null。操作者只取宿主认证上下文，旧请求体中的 `actorId` 被忽略。创建返回 201 的持久记录，列表返回 200 的 `{ items }`；响应保留历史字符串与 nullable note。GET 仅在两个筛选值都非空时筛选，缺参、单参或空值继续返回全量列表，重复查询键等非字符串输入返回 400。共享客户端校验输入和成功响应，旧 `submitFeedback` 继续返回 void。该切片保留全量读取，未增加分页或总量预算；回答版本关联及质量复核队列仍按 [BR-CONV-002](SRS.md#br-conv-002-讲解反馈与质量队列) 推进。

会话列表返回 `{ items }`，按最近更新时间排序，使用 `limit/offset` 单页读取，不提供总数或快照游标。CLI 的 `sessions list` 在客户端限制每页 1～100 条并校验非负安全整数 offset；这不是所有 HTTP 调用共有的新增 Schema 上限，也不表示 CLI 提供会话详情或历史读取。列表变动时 offset 分页可能重复或遗漏，不能作为完整导出，使用方式见[CLI](../../apps/cli/README.md)。

实际注册路由的覆盖测试以 Fastify `onRoute` 为依据，包括共享声明生成的路由。已有未描述路径以精确例外记录，新增缺口和已补齐却残留的例外都会失败。该棘轮约束增量，不表示全部历史端点已经完成迁移。

静态 `packages/contracts/openapi.json` 是内核基础合同；运行时文档还包含当前装配的插件贡献，随贡献 revision 失效重建。发行者验证插件 API 时必须先装配对应发行配置。

运行详情由 [Turn Diagnostics](../../packages/contracts/src/turn-diagnostics-api.ts) 共享声明定义，为只读 GET。省略 attemptId 读取最新尝试，明确指定时必须属于该 Turn；Turn 或 Attempt 不存在均返回 404。响应设置 `Cache-Control: no-store`，不支持 includeRaw 等扩展参数。返回的是有界的持久记录摘要，截断与未采集信息显式提供；不执行模型、工具、审批决定或新 Turn，也不返回对话正文和工具载荷。界面 JSON 导出复用相同响应校验和数据范围。

## 失败与客户端处理

JSON HTTP 失败使用 RFC 9457 `application/problem+json`，结构由 [ApiProblem](../../packages/contracts/src/http-api.ts) 定义。`type/title/status/detail` 描述失败，`code` 用于程序分支，`requestId` 用于定位；`details` 可携带字段错误。`error/message` 在 `/v1` 迁移期保留供旧客户端使用。

未经分类的服务端异常返回通用 500 描述，不把堆栈、SQL 或内部路径发给客户端。业务错误需明确安全的状态码和消息。SSE 建流后使用流协议终态，不把 Problem Details 写入已经开始的事件流。

共享客户端的 `AervoxHttpError` 保留状态、业务错误码、请求 ID 和错误体，并兼容旧 JSON 错误、空响应及非 JSON 错误。界面按业务码处理冲突、权限或输入问题，不把所有失败等同于网络错误。关键共享端点校验响应 Schema，不能仅以 TypeScript 类型断言证明远端数据正确。

## 版本兼容与门禁

区分 HTTP `/v1`、事件 `payloadVersion`、插件宿主 API、插件发行版本和配置 Schema 版本。新增可选字段通常可以兼容；删除端点、收窄输入、改变响应语义或身份要求必须明确兼容影响、迁移窗口和旧客户端处理方式。事件变更遵循流式协议的上一版本客户端兼容要求。

`mise tasks run check-standards` 执行作者工具回归、真实声明包校验与历史 OpenAPI 结构比较；全量代码门禁在构建后运行相同检查。结构比较涵盖端点、必填字段、类型、枚举、约束、媒体和认证要求，但不能替代 SSE/业务语义和旧客户端夹具。

历史基线保存在 `packages/contracts/compatibility/`。本次本地身份头、既有 Bearer 行为和 Problem Details 的纠偏使用精确指针、旧内容摘要与固定新内容记录；不允许通过宽泛忽略错误字符串绕过检查。

历史基线仍指向原提交 `05200288`；基线和修正文件中的 `restoration` 保存原始来源与摘要，不因重新生成而推进。规范化时，属性字典与常量内容中的 `title`、`description` 等键仍是契约数据，不能当作注解删除。

插件配置迁移以四个精确指针纠正既有文档偏差：Schema 读取与注册的成功响应，以及注册、保存请求体的必填标记。真实 HTTP 回归验证既有 `{schemaVersion, fields}` 响应和缺少请求体的 400 行为；历史基线源保持不变。

[Provider 扩展](https://github.com/3yearsZhuang/Aervox-harness/pull/282)保留六个既有 ID，并允许宿主注册的有界 ID。此次批准的响应枚举扩展以 16 个精确 Schema 指针、旧内容摘要和固定新内容登记，未重置历史基线。现有客户端继续使用旧 ID；消费新注册 Provider 的客户端须将 `providerType` 作为标识符处理，不能穷举六种取值或把未知 ID 静默切换为另一 Provider。后续字段、正则或其它兼容变化继续受检。

后续确有版本决定时可运行：

```sh
mise exec -- node scripts/openapi-compat.mjs --update --reason '说明批准的兼容决定与迁移窗口'
```

基线与修正文件的差异必须和契约一起评审，不将重新生成文档视为兼容性证明。普通功能更新不刷新基线。
