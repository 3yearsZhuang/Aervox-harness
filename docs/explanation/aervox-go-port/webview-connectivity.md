# 第 5 批验证记录：WebView 可直连本机 PRoot 内的 API

**结论：App 内的 WebView 可以直接通过 `http://127.0.0.1:3000` 访问 PRoot 内的 Aervox API，读写均正常。**

这消除了整条路线最大的架构性不确定性。若此步不成立，PRoot 方案必须改用 Binder/Unix socket 等更复杂的通信方式。

## 为什么这一步关键

PRoot 内的 API 与 App 内的 WebView 是**不同的进程与不同的网络命名空间视角**。理论上存在三种可能：

| 可能 | 后果 |
|---|---|
| WebView 能访问 127.0.0.1:3000 | 现有 Vue 前端可原样使用 HTTP/SSE，改动最小 |
| 仅 Java 侧可访问，WebView 被策略拦截 | 需改用 native bridge 转发，工作量大 |
| 都不可访问 | 方案需改为 Unix socket 或 Binder |

实测结果是第一种。

## 实测方法

构造最小探针 APK（`dev.aervox.wvprobe`），同时验证两条路径：

1. **Java 侧对照**：`HttpURLConnection` 直连 `http://127.0.0.1:3000/v1/sessions`
2. **WebView 侧**：`loadDataWithBaseURL('http://127.0.0.1:3000/', html)`，在 `fetch()` 中请求同一地址

WebView 配置与生产一致：`setJavaScriptEnabled(true)`、`setAllowFileAccess(false)`、`setAllowUniversalAccessFromFileURLs(false)`。

Manifest 声明 `android.permission.INTERNET` 与 `android:usesCleartextTraffic="true"`（明文 HTTP，因为是 loopback）。

## 实测结果

| # | 路径 | 结果 |
|---|---|---|
| 1 | Java `HttpURLConnection` | ✅ `code=200` |
| 2 | WebView 页面加载 | ✅ `loaded: http://127.0.0.1:3000/` |
| 3 | **WebView 内 `fetch()`** | ✅ **`WEBVIEW-FETCH-OK:{"items":[]}`** |
| 4 | POST 写操作 | ✅ 返回 `{"id":"ses_mwwhxd9u_57zkoq","title":"WebView 联通验证"}` |

第 3 项是核心证据：WebView 的 JavaScript 拿到了 API 的真实 JSON 响应。

## 结论意义

| 问题 | 答案 |
|---|---|
| 可否用 URL 直接访问本机 API | ✅ 可以 |
| 现有 Vue 前端能否原样复用 | ✅ 网络层无需改动 |
| 是否需额外 native bridge | ❌ 不需要（对 HTTP/SSE 而言） |
| 明文 HTTP 是否可用 | ✅ 需 `usesCleartextTraffic=true` |

**架构上，PRoot + WebView 的组合可行。**

## 需要记录的限制

| 项 | 说明 |
|---|---|
| `usesCleartextTraffic=true` | 生产需评估：这让 App 可发任意明文 HTTP。建议配合 network security config 只允许 loopback |
| 探针用 `loadDataWithBaseURL` | 生产用固定 APK 资产（`file://` 或内部资源），需确认该场景下 CORS 与 base URL 行为 |
| 未测 SSE 长连接 | `fetch` 单向请求已验证，SSE 的 `EventSource` 或流式 fetch 未测 |
| 未测跨进程 | API 在 PRoot 内由 shell 启动；若改由 App 进程启动，需重测 |

## SSE 流式已验证

在 curl 侧确认事件流正常（WebView 内未重复测，但同为 HTTP over loopback）：

```text
POST /v1/sessions/{id}/turns
→ {"turnId":"turn_mwwhy3bk_2","status":"Created","eventsUrl":"/v1/turns/turn_mwwhy3bk_2/events"}

GET /v1/turns/turn_mwwhy3bk_2/events  (Accept: text/event-stream)
→ id: tev_turn_mwwhy3bk_2_1
  data: {"eventType":"message","sequence":1,...}
→ id: tev_turn_mwwhy3bk_2_2
  data: {"eventType":"error","data":{"code":"MODEL_UNAVAILABLE","retryable":true,"message":"fetch failed"}}
```

事件流格式正确、`sequence` 递增、`id` 可用于 `Last-Event-ID` 续传。

`MODEL_UNAVAILABLE` 是**预期结果**：尚未配置模型。它反而证明错误路径也能正常下发事件，而不是挂起连接。

## 未验证项

- WebView 内的 `EventSource`（curl 已验证 HTTP 层，WebView 的 SSE 客户端行为未测）
- 生产形态下的固定资产加载（`file://` 起始页）的 CORS 行为
- API 由 App 进程启动时的连通性
- 前台服务保活、冷启动耗时
- 配置真实模型后的完整对话

## 下一步

1. 验证 SSE 流式（这是对话功能的核心）
2. 把 PRoot 与 API 装进 App 私有目录并由 App 启动
3. 首次安装流程（解压 rootfs 的进度与容错）
