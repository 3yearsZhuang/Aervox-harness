# 连接微信私聊与 QQ 群机器人

本指南说明如何配置第一方文字适配器、管理连接并运行独立 API 宿主。先按[从哪开始](../getting-started.md)完成环境安装和一次普通模型对话；平台连接成功与模型回答成功是两项检查。功能范围见 [SRS](../reference/SRS.md#fr-plg-005-bot-平台文字接入)，实现与实际验收状态见 [ITER-061](../../plan.md#iter-061)。

## 1. 先确认数据与权限

| 入口 | 谁可以触发 | 模型能使用什么 |
|---|---|---|
| 微信私聊 | 在管理页完成配对并确认的本人 | 普通人格、普通记忆与独立聊天历史；工具保持审批，不读取 CAP-033 私密画像 |
| QQ 群 | 白名单群内直接 `@bot` 的成员 | 公开基础身份与该成员在该群的历史；不读取本人人格、个人记忆、学习事实，不使用工具 |

QQ 回复仍发在群里，群成员均可看见；“成员独立上下文”不表示回复私密。群消息不会进入本人的个人记忆整理或日记素材。管理 API 仍只属于实例所有者，群成员不会获得管理账号。

首期只处理文字。微信群、QQ 私聊、图片、语音、文件、主动提醒和平台内工具审批均不支持。需要批准工具或完成工作台交互时，使用受认证的工作台；不要把审批令牌或 API Token 发到平台聊天中。

## 2. 微信：扫码后再配对本人

源码部署若尚未安装 Bot 声明包，先在仓库根运行 `mise tasks run package-plugins`，再通过插件管理导入 `dist-plugins/` 下的 `bot-weixin-<version>.aervox-plugin` 或 `bot-onebot-<version>.aervox-plugin` 并启用。声明包只登记随宿主构建的第一方能力，不加载包内任意服务端代码。

1. 在设置中的“机器人连接”创建微信连接，填写便于识别的名称并启用。确认微信第一方插件已安装且启用；默认服务地址无需修改。
2. 发起扫码登录，用手机微信扫描管理页二维码并在微信内确认。二维码由浏览器本地渲染；过期后重新发起登录。首次连接需要手机微信具备 ClawBot 功能，平台条件参考 [AstrBot 固定版本说明](https://github.com/AstrBotDevs/AstrBot/blob/6ca3931925ab60a05c638fd66cb3c977b0d97f39/docs/zh/platform/weixin_oc.md)。
3. 登录确认后，在管理页发起本人配对。将本次一次性配对码发送到微信 Bot 私聊；配对码五分钟内有效。
4. 回到管理页核对候选发送者标识，确认确实来自本人后完成绑定。没有确认前，陌生人普通消息不会获得模型响应；系统不会把首个发消息的人自动认作主人。
5. 连续发送两条相关文字，检查回复及上下文接续。发送 `/cancel` 可取消当前回合；平台已经接受的回复无法由此撤回。

登录态由宿主加密保存，重启可恢复。连接显示需要登录时重新扫码；协议返回会话失效时会停止旧令牌轮询。换账号、连接地址或认证令牌后重新确认配对，不沿用另一账号的上下文凭据和本人绑定。

## 3. QQ：连接 NapCat 正向 WebSocket

1. 独立运行 [NapCat](https://napneko.github.io/config/basic)，完成 QQ 登录，并让该账号加入需要接入的群。
2. 在 NapCat 中启用 OneBot v11 **WebSocket 服务器**，让思隅主动连接它；消息上报使用数组格式。配置访问令牌，关闭自身消息上报。这里不使用反向 WebSocket 或 Webhook。
3. 在“机器人连接”创建 QQ 连接，填写实际 WebSocket 地址、登录 QQ 号、允许的群号以及访问令牌。例如同机地址可为 `ws://127.0.0.1:3001`；实际端口以 NapCat 配置为准。跨机使用受控网络及 `wss` 或安全隧道，不直接暴露未认证端口。
4. 启用连接，确认状态为已连接。适配器通过 `get_login_info` 核对 QQ 号；不匹配时会停止并报错，先修正账号或 NapCat 登录状态。
5. 在白名单群中用明确的 `@bot` 发送文字，换另一个成员继续验证。普通群消息、机器人自身消息及 `@all` 不触发；取消同样发送 `@bot /cancel`。

每个连接、平台账号、群和成员组合拥有独立上下文。连接支持有界重连和心跳检查，但 OneBot 没有在这里提供历史补拉：断线期间未收到的消息不承诺补齐。必要时由发送者重新发送。

## 4. 本机运行与独立机器常驻

### 本机

开发环境可使用 `./aervox dev web` 运行 API、Worker 和浏览器入口；具体启动范围以[入门指南](../getting-started.md)及脚本为准。Bot 连接由 API 持有，关闭浏览器或聊天窗口不会停止一个仍在运行的 API；停止 API、休眠断网或关机会使连接离线。完整退出桌面应用是否结束其 API 进程取决于实际启动方式，不能把窗口关闭等同于服务常驻验收。

构建后也可在仓库根单独运行 API：

```bash
mise exec -- pnpm exec turbo run build --filter=@aervox/api...
mise exec -- pnpm --filter @aervox/api start
```

Bot 的完整 Turn 由 API 处理；日记、删除传播等其它后台任务仍由 Worker 负责。需要这些功能时一并运行 Worker，指向相同的本地数据库与既有控制账本。

### Linux 独立机器

使用专属操作系统用户部署源码、mise 固定工具链和根依赖，在仓库根执行安装与构建：

```bash
mise exec -- pnpm install --frozen-lockfile
mise exec -- pnpm exec turbo run build --filter=@aervox/api...
```

配置固定的本地数据库、Bot 密钥路径与模型服务。以下是 `/etc/aervox/bot-host.env` 的非秘密部分示例；必须另行在该受保护文件中配置 `AERVOX_AUTH_TOKEN` 和实际模型凭据。令牌值不得提交到仓库或写入 service 文件。

```dotenv
NODE_ENV=production
PORT=3000
AERVOX_API_HOST=127.0.0.1
AERVOX_AUTH_MODE=token
DATABASE_URL=file:/var/lib/aervox/aervox.db
AERVOX_BOT_KEY_PATH=/var/lib/aervox/bot-credentials.key
AERVOX_LOOP_PROVIDER=llm
AERVOX_LOOP_DRIVER=native
```

使用 [systemd 示例](../examples/aervox-bot-api.service)，按真实部署替换服务用户、仓库路径、mise 的绝对路径与环境文件路径。服务用户须拥有数据库目录及 mise 工具链，目录权限为 `0700`，密钥和环境文件为 `0600`。先按相同用户与环境启动 API，确认认证、模型和连接均正常，再安装为 `/etc/systemd/system/aervox-bot-api.service`：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now aervox-bot-api.service
sudo systemctl status aervox-bot-api.service
sudo journalctl -u aervox-bot-api.service --since today
```

管理访问建议通过 SSH 隧道或受控 HTTPS 反向代理，API 保持 loopback 与 Bearer 认证。例如在管理电脑建立 `ssh -L 3000:127.0.0.1:3000 aervox@bot-host`，再将受认证客户端连接到隧道地址。API 提供服务接口，不自动部署 Web 静态站点；客户端部署沿用现有 Web/桌面方式。不要将认证 Token 放入 URL。

同一数据库只运行一个拥有这些连接的 API 实例。独立机器不会自动获得电脑上的人格、记忆或配置；迁移数据要显式备份并恢复，不能同时启动两个复制了同一登录态的实例冒充高可用。Worker 如需常驻，应另配 service；本示例仅管理 Bot API。

## 5. 状态、失败投递与恢复

管理页可查看连接和分段投递；机器接口以 [Bot OpenAPI](../../packages/contracts/src/bot-openapi.ts) 为准，包括 `/v1/bot-adapters` 和 `/v1/bot-connections` 下的登录、配对与投递操作。

| 状态/现象 | 处理方式 |
|---|---|
| 需要登录 | 微信重新扫码；检查本人配对是否仍有效 |
| 正在重连 | 检查网络、NapCat 进程和账号在线状态；恢复后重新发送断线期间遗漏的 QQ 消息 |
| 账号不匹配 | 核对配置 QQ 号与 NapCat 实际登录账号；不要跳过身份检查 |
| 排队中/发送中 | 检查 API 和模型是否正常，不重复触发同一回合 |
| 平台已接受 | 已收到平台回执，不代表收件人已读 |
| 发送失败 | 检查错误及当前账号/配对/群白名单；仅在绑定仍有效时通过管理页重试 |
| 结果未知 | 先在平台核对是否已收到；系统不会自动重发，人工重试可能造成重复 |

停用连接会关闭网络并中止关联活动回合；再次启用创建新实例。重配、账号切换或授权变化会使旧投递失去原绑定，不能绕过校验强行重发。卸载插件、删除连接和停用连接具有不同数据影响，删除前先完成必要导出与备份。

## 6. 备份、回退与验收

Bot 连接、入站、投递与会话映射分别存放在 `bot_connections`、`bot_inbox`、`bot_deliveries`、`bot_session_bindings`；完整业务会话仍在现有会话表。默认 Bot 加密密钥为仓库数据目录下的 `data/bot-credentials.key`，可通过 `AERVOX_BOT_KEY_PATH` 指向固定私有位置。若使用 `AERVOX_BOT_KEY` 注入密钥，备份其安全来源，不把值写入导出包。

备份前停用连接并停止 API、Worker 等写入者，按[数据库运行手册](../reference/operations.md#5-sqlite-故障与备份恢复)生成一致性数据库备份。单独保管对应 Bot 密钥、配置与必要的控制账本；只复制活动 `.db` 文件不构成 WAL 一致性备份，只有数据库而没有密钥也无法恢复平台凭据。

恢复时先保持连接停用，核对数据库完整性、控制账本、密钥可解密及文件权限；确认原宿主已停止，再在目标宿主逐个启用、核验登录账号、本人绑定和白名单。保留结果未知的投递状态。增量迁移的应用回退先停适配器，并用当前版本在工作台取消仍未结束的 Bot 回合，确认回合及其执行尝试均已结束后再停止 API 和 Worker、备份并更换版本。保留新表与投递记录；不识别 Bot 执行策略的旧版 Worker 在完成这项检查前保持停止，避免接管遗留回合。需要换库时遵循[迁移演练](run-database-migration-drill.md)，不要删除新数据或清空队列来伪造恢复成功。

发布前分别记录真实微信扫码/配对/连续对话、真实 QQ 多成员隔离/重连、本机关闭窗口后的运行及 Linux 服务重启恢复。自动化协议与界面测试、真实平台验收、正式发布是三项独立证据；未完成的检查继续留在 [ITER-061](../../plan.md#iter-061)。
