# aervox-intro · 应用内嵌版产品介绍

供桌面端「设置 → 外观 → 完整产品介绍」在窗口内嵌（iframe）播放的静态展示页，生产构建随 `electron-vite` 从 `public/` 复制到 renderer 输出目录，以相对路径 `aervox-intro/index.html` 加载（dev 与 file:// 均可用）。

## 来源与裁剪

源物料为自研宣讲包 `Aervox-Siyu-20260829`（仓库根目录，不入库），本目录是其**裁剪副本**，改动仅限：

- 移除演讲者模式模块、ESC 索引视图、`B` 键静态切换与对应死 CSS / 死按钮（提示条精简为「← → 翻页」）；
- 背景图压缩为 WebP（q82，约 4.3MB → 124KB）；
- 保留：全部 10 页内容、WebGL 双背景、Motion One 入场动效、圆点/键盘/滚轮/触屏翻页、`?slide=N` 直达。

源宣讲包更新时应重新执行同样裁剪，不要手改本目录生成物之外的内容。

## 第三方代码（PRD §15.1）

| 文件 | 来源 | 许可证 |
|---|---|---|
| `assets/motion.min.js` | jsDelivr `motion@11.11.17`（历史 Rollup 2.79.2 + Terser 5.39.0 构建） | MIT；完整文本见 `licenses/motion.LICENSE` |
| `assets/lucide.min.js` | jsDelivr `lucide v1.8.0`，与固定 npm 分发内容逐字节一致 | ISC 及所含 Feather 图标的 MIT；完整文本见 `licenses/lucide.LICENSE` |

准确获取地址、npm 源包完整性、资源 SHA-256、许可 SHA-256 和冻结 Git 提交记录在 `vendor-manifest.json`。许可直接取自对应版本的 npm tarball，下载后先验证其 SHA-512 integrity，保留完整版权及通知。

在仓库根离线核验资源及许可：

```sh
mise exec -- node packages/public/scripts/vendor-assets.mjs --verify
```

在新目录恢复相同字节：

```sh
mise exec -- node packages/public/scripts/vendor-assets.mjs --restore /tmp/aervox-intro-vendor-copy
```

恢复从当前检出的 Git 对象读取已冻结资源，以 manifest 的历史 SHA-256 验证，浅克隆同样可用。脚本先验证全部输入，再创建新输出目录，拒绝覆盖已有目录。

Motion 的动态 CDN 构建现已返回不同字节，不能把重新下载称为历史包的等字节重建。本仓保留原资源，通过冻结 Git 对象恢复并验证；历史构建的完整依赖闭包尚未恢复，因此不声称可从源代码重新生成相同 bundle。未来更新需独立更新固定输入、许可、哈希和界面验证，不能仅替换 CDN 地址。日常构建先离线校验，再同步原资源到消费端。

`images/*.webp` 为自研物料（源 PNG 在宣讲包内），由 `cwebp` 转码生成。
