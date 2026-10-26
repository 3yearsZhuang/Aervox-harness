# 思隅 CLI

连接本机思隅 API 的终端入口，需要 Node.js 24+ 和已启动的兼容服务。当前交付范围见 [ITER-029](../../plan.md#iter-029)，验收边界见[追踪基线](../../docs/reference/REQUIREMENTS_TRACEABILITY.md#cli-attached-20260930)。

`./aervox dev cli` 会优先复用本机 API；`PORT` 决定默认地址，`SIYU_API_URL` 可指定其它本机 HTTP(S) 根地址。地址先校验再携带 Token 探测，服务未就绪时不会进入聊天；仅自动启动默认本机端口的 API，并在客户端退出时回收该服务及其子进程。

从仓库根目录构建：

```bash
mise exec -- pnpm exec turbo run build --filter=@aervox/cli
mise exec -- node apps/cli/dist/index.js --help
mise exec -- node apps/cli/dist/index.js doctor --json
mise exec -- node apps/cli/dist/index.js ask '解释 JavaScript 闭包' --json
printf '解释这段报错' | mise exec -- node apps/cli/dist/index.js ask --jsonl
mise exec -- node apps/cli/dist/index.js chat --session my_learning
```

在仓库根目录可为当前终端设置简写，再运行常用命令：

```bash
alias siyu='mise exec -- node apps/cli/dist/index.js'
siyu chat --session my_learning
siyu ask '用一个例子解释闭包' --session my_learning
siyu ask --file ./question.txt --json
siyu sessions list
siyu sessions list --limit 20 --offset 20
siyu sessions history my_learning --limit 10
```

进入 `chat` 后会显示思隅欢迎区、当前会话和本机服务地址。在 `❯` 后输入问题并按回车，回答结束后可继续追问；发送/等待时有进度提示，回答以“思隅”标识，结束后显示真实状态与耗时。重新用相同 `--session` 启动可继续该会话，不会自动重放旧正文。已安装的制品直接提供 `siyu` 命令，无需上述源码简写。

| 交互 | 用法 |
|---|---|
| 查看帮助 | `/help` |
| 当前会话及上一回合标识 | `/session` |
| 开始新会话，保留原会话 | `/new` |
| 退出 | `/exit` 或 `/quit` |
| 多行提问 | 行末输入 `\` 后回车，最后一行直接回车发送 |
| 命令补全 / 本次输入历史 | Tab / ↑↓ |
| 发送以 `/` 开头的正文 | 使用 `//` 开头，发送时去掉一个 `/` |

Ctrl-C 退出客户端并尝试取消当前回合；停止客户端不会关闭外部 API。`NO_COLOR=1` 关闭颜色，`TERM=dumb` 使用无动画呈现。JSON/JSONL 与重定向输出不混入欢迎区、角色或进度动画。当前输入是逐轮对话，回答结束后再输入下一问。

直接在终端运行 `doctor`、`sessions list` 和 `config show` 时显示可读内容；使用 `--json` / `--jsonl` 或重定向输出时保留机器格式。欢迎区和等待提示按终端列宽裁剪，支持中文与 emoji；会话标题等外部字段在终端显示前会清除控制序列。

`sessions list` 每次只读取一页，默认 `--limit 100 --offset 0`，按服务端最近更新时间排序。`--limit` 可设为 1～100，`--offset` 是跳过的条数，可设为 0～9007199254740991；两者仅接受十进制整数，offset 只能用于此命令。终端显示完整本页，满页时提示下一组参数；服务端没有总数或下一页标记，后续页可能为空。JSON/JSONL 继续输出 `{ "version": 1, "data": { "items": [] } }`，不自动合并多页。会话新增或更新时间改变时，offset 分页可能重复或遗漏条目，不作为固定快照或完整导出。

`sessions history <ID>` 读取持久消息的当前版本，默认最近 20 轮，`--limit` 可设为 1～50。继续查看更早记录时显式传入上次返回的 `--cursor`，每页按回合创建顺序显示；不接受 offset、不自动翻页，也不重跑模型。JSON/JSONL 输出 `{ "version": 1, "data": { "sessionId": "…", "items": [], "nextCursor": null } }`；空页仍可能有下一游标。游标不是跨页固定快照，锚点被移除时提示从最近页重新读取。超限时可减小 limit，单轮超过读取上限仍无法由此入口读取，不静默截断正文。

历史显示真实完成状态与已保存前缀；“本轮输入”是服务端接受的有效输入，可能已合并 Inbox 内容。旧未关联版本标记只读，不从事件补造已缺失正文；撤回或脱敏版本仅显示占位符。此入口不提供编辑、完整导出或实时流替代，详细资格和预算见[持久历史协议](../../docs/reference/STREAMING_PROTOCOL.md#session-history-page)。

Token 由 `SIYU_API_TOKEN` 环境变量注入，不作为命令参数、不写入配置；地址用 `SIYU_API_URL` 或 `--api-base`。`config show` 查看实际配置，`config set apiBase http://127.0.0.1:3000` 保存地址。默认配置在用户目录 `.config/aervox/cli.json`；设置 `XDG_CONFIG_HOME` 或 `SIYU_CONFIG_FILE` 可覆盖位置。

模型配置通过本机 API 读写，使用当前共享契约；不会启动模型或自动调用供应商。先查看目录与脱敏摘要：

```bash
siyu models providers --json
siyu models config show --json
siyu models config set --file ./model.json --json
siyu models test --file ./connection.json --json
siyu models presets list --json
siyu models presets create 日常模型 --file ./model.json --json
siyu models presets activate <ID> --json
siyu models presets delete <ID> --json
```

`model.json` 使用 `enabled`、`providerType`、`baseUrl`、`modelId` 和可选 `temperature`、`maxTokens`、`settings`、`apiKey`；`connection.json` 只需 `providerType`、`baseUrl`、`modelId` 与可选 `apiKey`。文件上限 64 KiB。密钥可由 `SIYU_MODEL_API_KEY` 覆盖文件中的 `apiKey`，不作为命令行选项，也不会写入 CLI 连接配置。 `models config set` 使用完整配置；若文件省略 `apiKey` 且没有环境覆盖，会清空当前保存的模型密钥。含密钥的文件应放在版本控制之外并限制读取权限。

`models` 子命令中，`test` 会显式连接供应商，不保存测试配置；它可能产生供应商请求及相应费用。其余 `models` 子命令只管理本机配置。输出仅包含能力目录或配置摘要，密钥只显示配置状态；不输出原始 `settings`、供应商消息、探测模型名称列表或 URL 用户信息、query、fragment。保存、新建、激活和删除不会因超时或响应丢失自动重发；结果未知时先读取配置或预设列表确认。

`ask` 默认创建新会话，用 `--session` 继续已有会话；会话内容与学习记录始终由 API 持久化。`sessions list` 查看会话，`events <turnId>` 补读回合，`status <turnId>` 等待并查询终态。客户端只保存请求标识回执；提交响应丢失时不会自动重发，可用保存的幂等键对相同问题显式重试。

`--json` 输出一个最终对象；`--jsonl` 输出版本化事件。正文走 stdout，诊断与审批走 stderr。非交互输入不会自动批准写工具；交互批准只代表决定已保存，不保证当前工具自动续跑。只有中断（Ctrl-C / SIGTERM / 断管）会尝试通知服务端取消当前回合；超时或请求失败属于状态未知，不会替你取消已受理的回合，可用 `events <turnId>` 或 `status <turnId>` 追认结果，输出会区分取消请求与确认的执行结果。

安装闭环回归可从仓库根目录运行 `mise exec -- pnpm test:cli:integration`：生成压缩包，安装到临时空目录，使用 Token 连接真实 API 与临时 SQLite，再重启 API 查询持久历史。开发依赖不进入运行闭包，许可证随制品分发。

独立安装的 `siyu` 需要已有 API，不负责自动启动服务；仓库开发入口 `./aervox dev cli` 提供前述就绪检查与本机 API 启动。当前 CLI 尚不提供独立 Core 模式、后台主动任务、附件和学习/记忆专用命令。安装包、真实模型与平台验证范围以交付登记为准。
