# HTTP API 约定

HTTP 数据与操作的事实源是 `@aervox/contracts`；[流式协议](STREAMING_PROTOCOL.md)定义 Turn/SSE 状态、重连、幂等和取消；[插件规范](plugin-config-and-pages.md)定义扩展贡献。本文维护跨模块约定，不复制字段目录。生成文档通过 `/openapi.json` 读取。

## 请求身份与资源

- `/v1` 是当前 HTTP 主版本。本地数据库只有一位用户；不接受客户端提供的工作区、用户或审计身份请求头。`LocalContext` 由宿主创建。
- Token 模式只使用 `Authorization: Bearer …`。开发用 loopback open 模式不要求 Token；生产和非 loopback 访问遵守[认证实现](../../apps/api/src/shared/auth.ts)。OpenAPI 的 Bearer 声明描述受保护部署。
- 凭据不得放入 URL、查询参数、日志或 Page 资源地址。Page 资源认证通道有独立边界，见插件规范。
- 路径参数由共享客户端编码为单个路径片段；请求体、路径参数和分页上限由对应 Schema 校验。日期使用明确的 ISO 日期/时间语义，不用本地显示格式作为传输值。
- 重试只在操作的幂等合同允许时进行。创建 Turn 使用稳定的 `Idempotency-Key`；普通 HTTP 失败不会授权客户端重新执行有副作用的操作。

## 操作声明与覆盖

新 JSON 端点优先使用 [ApiEndpoint](../../packages/contracts/src/http-api.ts) 定义方法、路径、稳定 `operationId`、输入、成功响应及错误响应；使用宿主 [registerContractRoute](../../apps/api/src/shared/contract-route.ts) 注册，并由 OpenAPI 与共享客户端消费同一声明。当前试点是 [Model Runtime](../../packages/contracts/src/model-runtime-api.ts)；SSE、文件和已有路由可以保留专用适配器，但仍须登记协议。

认证由宿主统一执行，插件或业务 handler 不能通过自定义声明降低要求。共享契约不得导入具体插件实现或宿主应用。

实际注册路由的覆盖测试以 Fastify `onRoute` 为依据，包括共享声明生成的路由。已有未描述路径以精确例外记录，新增缺口和已补齐却残留的例外都会失败。该棘轮约束增量，不表示全部历史端点已经完成迁移。

静态 `packages/contracts/openapi.json` 是内核基础合同；运行时文档还包含当前装配的插件贡献，随贡献 revision 失效重建。发行者验证插件 API 时必须先装配对应发行配置。

## 失败与客户端处理

JSON HTTP 失败使用 RFC 9457 `application/problem+json`，结构由 [ApiProblem](../../packages/contracts/src/http-api.ts) 定义。`type/title/status/detail` 描述失败，`code` 用于程序分支，`requestId` 用于定位；`details` 可携带字段错误。`error/message` 在 `/v1` 迁移期保留供旧客户端使用。

未经分类的服务端异常返回通用 500 描述，不把堆栈、SQL 或内部路径发给客户端。业务错误需明确安全的状态码和消息。SSE 建流后使用流协议终态，不把 Problem Details 写入已经开始的事件流。

共享客户端的 `AervoxHttpError` 保留状态、业务错误码、请求 ID 和错误体，并兼容旧 JSON 错误、空响应及非 JSON 错误。界面按业务码处理冲突、权限或输入问题，不把所有失败等同于网络错误。关键共享端点校验响应 Schema，不能仅以 TypeScript 类型断言证明远端数据正确。

## 版本兼容与门禁

区分 HTTP `/v1`、事件 `payloadVersion`、插件宿主 API、插件发行版本和配置 Schema 版本。新增可选字段通常可以兼容；删除端点、收窄输入、改变响应语义或身份要求必须明确兼容影响、迁移窗口和旧客户端处理方式。事件变更遵循流式协议的上一版本客户端兼容要求。

`mise tasks run check-standards` 执行作者工具回归、真实声明包校验与历史 OpenAPI 结构比较；全量代码门禁在构建后运行相同检查。结构比较涵盖端点、必填字段、类型、枚举、约束、媒体和认证要求，但不能替代 SSE/业务语义和旧客户端夹具。

历史基线保存在 `packages/contracts/compatibility/`。本次本地身份头、既有 Bearer 行为和 Problem Details 的纠偏使用精确指针、旧内容摘要与固定新内容记录；不允许通过宽泛忽略错误字符串绕过检查。后续确有版本决定时可运行：

```sh
mise exec -- node scripts/openapi-compat.mjs --update --reason '说明批准的兼容决定与迁移窗口'
```

基线与修正文件的差异必须和契约一起评审，不将重新生成文档视为兼容性证明。普通功能更新不刷新基线。
