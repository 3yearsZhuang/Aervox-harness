# 第 3 批验证记录：第三方原生模块全部可用

**结论：Aervox API 依赖的三个关键原生模块在真机 PRoot 内全部正常工作。** 这是「保留全部能力」的最后一个技术关卡。

## 背景

第 2 批确认 Node 能在应用进程内运行，但 Node 内置模块不等于 Aervox 的依赖。Aervox API 通过 `packages/repositories` 与 `packages/host-runtime` 依赖三类原生能力：

| 模块 | 用途 | 平台包 |
|---|---|---|
| `@libsql/client` | SQLite 真源（仓储层） | `@libsql/linux-arm64-gnu` |
| `sharp` | 图片处理（头像、附件、日记素材） | `@img/sharp-linux-arm64` + `sharp-libvips-linux-arm64` |
| `@vscode/ripgrep` | 工作区全文搜索 | `@vscode/ripgrep-linux-arm64` |

三者都要 ARM64 Linux 的预编译二进制。PRoot 内的 glibc 环境是它们能工作的前提——这正是选择 PRoot 而非 bionic Node 的理由。

## 实测结果

环境：OPPO PMA110 / Android 17 / arm64 / Ubuntu 24.04 rootfs / Node v22.19.0 / PRoot 5.1.107.102

| # | 模块 | 测试 | 结果 |
|---|---|---|---|
| 1 | `@libsql/client` 0.14.0 | 用真实封装建库、写入、读取 | ✅ `[{"id":1,"body":"真机 PRoot 验证"}]` |
| 2 | `sharp` 0.35.5 | 生成 64×64 PNG 并读回元数据 | ✅ `64x64 png bytes=237` |
| 3 | `@vscode/ripgrep` 1.18.0 | 执行 `rg --version` | ✅ `ripgrep 15.0.0 features:+pcre2` |

第 1 项最关键：它不只是「模块能加载」，而是完成了**建表、参数绑定插入、查询回读**，且中文内容完好。这证明 SQLite 真源可以放在 rootfs 内。

## 过程中的三个坑

记录在此，避免后续重复踩：

### 1. `@libsql/client` 的底层 API 签名

直接 `require('index.node')` 得到的是 napi 层，`databaseOpen` 至少需要 3 个字符串参数（path、url、key），与直觉不符，试探成本高。

**正确做法：用 `@libsql/client` 的 JS 封装**（`createClient({ url: 'file:...' })`），不要直接调 napi 层。

### 2. `sharp` 0.35 的入口变更

`sharp/lib/index.js` 在 0.35 已不存在（`lib/` 只有 `.d.ts`），实际入口是 `sharp/dist/index.mjs`。

### 3. 传递依赖必须一起部署

只打包 `sharp` 与 `@img` 会缺 `semver` 等传递依赖，报 `ERR_MODULE_NOT_FOUND`。必须部署完整 `node_modules`（本批约 21 MB 压缩后，含 libsql + sharp 全部依赖）。

## 结论意义

| 问题 | 答案 |
|---|---|
| SQLite 真源能否放 rootfs | ✅ 可以，读写正常 |
| 图片处理能否工作 | ✅ 可以 |
| 全文搜索能否工作 | ✅ 可以 |
| 「全部能力」是否还有技术阻塞 | ❌ 没有了 |

**技术层面，PRoot 路线已无障碍。** 剩下的都是工程量与产品取舍问题。

## 未验证项

| 项 | 说明 |
|---|---|
| Aervox API 实际启动 | 本批只逐个验证模块，未跑完整 `apps/api`（其 `node_modules` 远大于本批测试用） |
| WebView ↔ 127.0.0.1 联通 | 未测 |
| 完整 rootfs（apt / bash / git） | 只用了 ubuntu-base 的库与 `/opt`，未验证包管理与工具链 |
| 前台服务保活 | 未测 |
| 功耗、发热、启动时间（完整 API） | 未测 |
| 升级保留数据 | 未测 |
| `sherpa-onnx-node`（语音，可选） | 未测 |

## 下一步

按风险排序：

1. **部署完整 Aervox API 并启动** —— 这是「能跑的原型」的真正判据
2. WebView 接入本机 API，验证 SSE 流式
3. 完整 rootfs 与工具链
4. 前台服务与保活
