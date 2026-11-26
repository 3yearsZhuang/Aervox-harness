# `.agents/` — 第三方 skill 快照

本目录与根目录的 [skills-lock.json](../skills-lock.json) 配对：锁文件记录 13 个第三方 skill 的来源仓库、
路径与内容哈希，本目录存放对应版本的 `SKILL.md` 快照。

## 为什么入库

这些不是某个人的本地工具状态，而是**按内容哈希固定的 vendored 依赖**：锁文件声明了期望的
`computedHash`，快照与之对应。删掉快照会让锁文件指向不存在的内容，同事和 CI 也无法复现同一套 skill。
性质上与 `patches/`（pnpm 补丁的固定字节）、`.env.example`（配置的固定形状）相同。

来源与许可以 `skills-lock.json` 的 `source`/`skillPath` 字段为准，不在此复制清单。

## 与另外三个目录的区别

`.workbuddy/`、`.zcode/`、`.commandcode/` 是纯本地工具目录，已在 `.gitignore` 中忽略，不应入库。
本目录**入库是刻意的**，不要按「本地目录」一并忽略或删除。

## 更新方式

新增或升级 skill 时同时更新锁文件与本目录快照，保持 `computedHash` 一致；只改一侧会让两者失配。
