export const CHAT_COMMANDS = ['/help', '/session', '/new', '/exit', '/quit'];

export const CHAT_HELP = `对话命令
  /help       显示这份帮助
  /session    查看当前会话、服务及上一回合的恢复标识
  /new        切换到新会话，原会话保留
  /exit       退出（也可用 /quit）

Enter 发送 · 行末 \\ + Enter 换行 · Tab 补全命令 · ↑/↓ 本次输入历史
Ctrl-C 退出并尝试取消当前回合。以 // 开头可发送字面量 /。
模型由本机服务配置；会话内容由服务端保存。`;

export const HELP = `思隅 CLI 0.1.0 — 连接本机思隅服务（Node.js 24+）

用法：siyu <命令> [参数]
  ask <问题>                  单次提问；也可通过 stdin 或 --file 输入
  chat                        连续对话；/exit 退出，--session 继续既有会话
  sessions list               列出最近 100 个会话
  events <turnId>             补读已有回合并等待权威终态，不重新提交
  status <turnId>             等待并显示回合终态（受 --timeout 限制）
  doctor                      检查本机连接、认证和会话接口
  config show                 查看连接配置（不显示 Token）
  config set apiBase <地址>    保存本机 API 地址
  config set sessionId <ID>    设置默认会话

选项：--api-base <URL> --session <ID> --file <路径>
      --json（单个最终对象） --jsonl（事件流）
      --timeout <毫秒，1000～600000，默认120000>
      --request-id <ID>（仅同一问题的显式幂等重试使用）
      --help --version

API Token：环境变量 SIYU_API_TOKEN；地址默认 http://127.0.0.1:3000。
对话内：/help /session /new /exit；Tab 补全；行末 \\ 换行。
凭据不写入 CLI 配置。非 TTY 不自动批准工具；不自动启动服务或切换独立模式。
退出码：0 成功；1 执行/连接失败；2 用法/配置；3 认证；4 需要交互；
        5 超时/未确认结果；130 SIGINT；143 SIGTERM。
`;
