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
| `assets/motion.min.js` | jsDelivr `motion@11.11.17`（Rollup + Terser 打包） | MIT |
| `assets/lucide.min.js` | jsDelivr `lucide v1.8.0` | ISC |

`images/*.webp` 为自研物料（源 PNG 在宣讲包内），由 `cwebp` 转码生成。
