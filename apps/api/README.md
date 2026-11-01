# API 服务

Aervox 本机 API 服务（Fastify 5），承载会话、Agent 执行、插件运行时和数据访问。默认监听 `127.0.0.1:3000`。

架构见 [ADR-014](../../docs/reference/adr/ADR-014-modular-monolith-structure.md)，API 约定见 [API 约定](../../docs/reference/API_CONVENTIONS.md)。

## 开发

从仓库根目录运行：

```bash
./aervox dev api    # 仅启动 API
./aervox dev        # 启动完整开发环境（API + Web + 桌面端 + Worker）
```
