# 第 12 批：修复插件装配失败（插件目录层级错误）

**结论：10 个第一方插件全部成功装配，`plugin_runtime_identity_unavailable` 从 2 条降为 0。**

![插件装配成功](assets/aervox-go-plugins-ok.png)

## 症状

从第 6 批起，每次启动都有：

```text
[plugin-assembly] 插件 ap-tool-anki-sync 贡献装配失败 Error: plugin_runtime_identity_unavailable
[plugin-assembly] 插件 ap-workflow-diary-distillers 贡献装配失败 Error: plugin_runtime_identity_unavailable
[plugins] 以下第一方插件未能装配：ap-tool-anki-sync, ap-workflow-diary-distillers
```

`/v1/plugins` 返回 `{"items":[]}`——不只这两个失败，**所有插件都没入库**。

## 排查过程

按报错反查，`plugin-runtime-tools.ts:23` 的抛错条件是：

```ts
const installed = await deps.plugins.getPlugin(pluginId);
if (!version || !installed || installed.version !== version
  || (installed.availability ?? "available") !== "available" || !installed.lifecycleGeneration) {
  throw new Error("plugin_runtime_identity_unavailable");
}
```

`getPlugin` 返回空。查数据库：

```text
plugins: 0 rows
skill_registrations: 0 rows
```

所以问题不在装配，而在**更早的同步阶段**——插件从未写入仓储。

逐个排除：

| 假设 | 验证 | 结论 |
|---|---|---|
| 插件目录不在 APK 内 | `ls .../node_modules/plugins/tool/` | 存在，7 个分类目录 |
| 清单文件缺失 | `plugin.manifest.json` 存在 | 排除 |
| 硬链接被拒（`nlink > 1`） | `nlink=1` | 排除 |
| 清单校验失败 | `hostApiVersion` 均在 `1.1.0 ~ 2.0.0` | 排除 |
| `targets` 差异 | 失败的含 `cli`，成功的含 `web` | 排除（`targets` 只用于校验） |
| 路径推导错误 | 模拟 `import.meta.dirname` 四级上溯 | 得到 `/app/node_modules/plugins`，正确 |

最后读 `discoverBuiltinPluginDirectories` 的实现才发现布局要求：

```ts
const categorized = path.join(root, "plugins");     // ← 要求 <root>/plugins/
for (const category of ["tool", "bot", "ui", ...]) {
  const directory = path.join(categorized, category);  // <root>/plugins/<category>
```

即期望 `<root>/plugins/<category>/<id>`。

而打包后的实际布局是 `<root>/<category>/<id>`：

```text
app/node_modules/plugins/tool/anki-sync/plugin.manifest.json   ← 实际
app/node_modules/plugins/plugins/tool/anki-sync/...            ← 期望
```

少了一层 `plugins`。

扫描在第一层循环里看到 `tool`、`bot` 这些目录，但它们内部没有 `plugin.manifest.json`（清单在下一层），于是全部跳过；随后 `categorized = <root>/plugins/plugins` 也不存在，返回 `undefined`。最终 `found = []`，什么也不装。

这也解释了早先日志里的 `ENOENT: scandir '/app/node_modules/plugins'` ——我当时看到这个路径存在，就以为没问题，**忽略了它还要再进一层**。

## 修复

在安装完成、引擎启动之前，把 `<root>/plugins/<category>` 重命名为 `<root>/plugins/plugins/<category>`：

```kotlin
private fun fixPluginLayout(rootfs: java.io.File) {
    val root = java.io.File(rootfs, "app/node_modules")
    if (!root.isDirectory) return
    val nested = java.io.File(root, "plugins/plugins")
    if (nested.exists()) return
    nested.mkdirs()
    var moved = 0
    for (category in listOf("tool", "bot", "ui", "proactive", "sync", "workflow", "theme")) {
        val src = java.io.File(root, "plugins/$category")
        if (!src.isDirectory) continue
        val dst = java.io.File(nested, category)
        if (dst.exists()) continue
        if (src.renameTo(dst)) moved++ else Log.w(TAG, "plugin move failed: $category")
    }
    Log.i(TAG, "plugin layout fixed, moved=$moved")
}
```

在 `boot()` 与 install 回调中各调一次（前者覆盖「已安装后启动」，后者覆盖「首次安装后立即启动」）。

### 为什么用 `renameTo` 而不是软链

第一版尝试创建软链 `plugins -> plugins/plugins`（循环链）不成立；退而创建 `<root>/plugins/plugins` 目录但内容不动，扫描仍找不到清单。`renameTo` 把分类目录整体移进去，是最小且语义正确的做法——它只是把打包时的目录层级纠正为运行时期望的层级。

## 验证

| 项 | 修复前 | 修复后 |
|---|---|---|
| `/v1/plugins` | `{"items":[]}` | **10 个插件** |
| `plugins` 表行数 | 0 | 10 |
| `plugin_runtime_identity_unavailable` | 2 条/次 | **0 条** |
| 两个曾失败的插件 | unavailable | `available` |

全部 10 个插件：

```text
ap-bot-onebot              v1.0.1  available
ap-bot-weixin               v1.0.1  available
ap-proactive-health-guard   v1.0.1  available
ap-sync-xiaomi-health       v1.0.1  available
ap-tool-anki-sync           v1.1.0  available   ← 此前失败
ap-tool-flowcampus          v1.1.0  available
ap-tool-home-assistant      v1.0.1  available
ap-tool-multimodal-ocr      v1.0.1  available
ap-ui-focus-mode            v1.0.1  available
ap-workflow-diary-distillers v1.1.0 available   ← 此前失败
```

## 这是打包缺陷，不是代码缺陷

需要强调：**主仓的插件发现逻辑没有问题**，是 aervox-go 打包 `node_modules` 时把 `plugins/plugins/<category>` 压平成了 `plugins/<category>`（我的剥离脚本只保留了分类目录，丢失了中间层）。

修复放在 App 侧而不是重建 rootfs，是因为重建 382 MB 归档成本高、且这只影响试验仓的打包流程；若将来正式集成，应在打包脚本里保持原层级。

## 遗留

- 两个插件虽已 `available`，但其**运行时工具贡献**的可用性边界已在[第 13 批](plugin-tool-availability.md)查明：
  工具正确进入目录，处理器按回合上下文构造，**不能通过 REST 直接调用**（设计行为，与主仓测试一致）；
  能否在对话中被模型调用仍需配置模型后验证。
- 冷启动仍约 24 秒（首装）/ 12 秒（已装）
