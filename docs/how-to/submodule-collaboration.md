# 操作指南：可选模块的 submodule 初始化与协作规范（How-to）

> 文档编号：AVX-GUIDE-003  
> 版本：v0.1  
> 更新日期：2026-08-24  
> 状态：Draft  
> 关联：[可选功能模块化方案](../explanation/optional_modules.md) · [文档索引](../README.md)

本指南回答"引入 `modules/*` 之后的 clone、初始化、增删、升级和协作流程"，是[可选功能模块化方案](../explanation/optional_modules.md)的落地操作手册。机制决定与门禁以该方案为准，本文件只给步骤与规范，不重复规则。

## 1. 角色与一次性环境准备

`modules/*` 采用 git submodule；每个普通开发者的本机**只需要做一次初始化**即可长期使用。

```bash
# clone 主仓（含子模块）
git clone --recurse-submodules git@github.com:3yearsZhuang/Aervox-harness.git

# 若已经 clone 了主仓但没拉子模块
git submodule update --init --recursive

# 后续同步上游子模块指针
git submodule update --remote modules/*
```

> 说明：`--recurse-submodules` 会一并检出全部子模块；仓库内 `reference/` 也同为子模块，本流程对两者一致适用。CI 中 `workflow_dispatch` 或本地首次 `pnpm install` 前必须完成此步，否则 `@aervox/mod-*` workspace 包缺失导致 build 失败。

## 2. 在子模块内开发（两层提交规范）

可选模块是**独立 git 仓库**，因此存在"内层（模块）提交"与"外层（主仓）指针提交"两层：

1. 在 `modules/<name>/` 内改代码 → 先提交到**子模块自身的 git**；
2. 回到主仓根目录 → `git add modules/<name>`（记录新 commit 指针）→ 提交主仓。

```bash
cd modules/skins
# ...修改代码...
git add . && git commit -m "feat: ..."      # 内层提交
cd ../..
git add modules/skins                       # 更新主仓记录的子模块指针
git commit -m "chore(skins): bump pointer"  # 外层提交
```

**规范**：

- 内层、外层提交信息都要写清"改了哪个可选功能、为什么";
- 内层提交信息建议带父级功能标识（如 `skins:`、`sync:`），便于跨两层追溯;
- **禁止只提交外层指针、不提交内层代码**（会造成主仓指向不存在的 commit -> CI 红）;
- **禁止跳过内层、在主仓直接改 `modules/<name>`**（= 丢弃子模块独立版本化）。

## 3. 新增一个可选模块

按 [optional_modules.md 第 5 节] 门禁，新增必须：

1. 走 `CR-*` 登记新模块与受影响 `CAP-*`;
2. 建立独立 git 仓库并固定初始版本;
3. 以 submodule 挂入（推荐挂 `modules/<name>`)：

```bash
git submodule add <repo-url> modules/<name>
git add .gitmodules modules/<name>
```

1. 在[可选功能清单](../explanation/optional_modules.md#4-可选功能清单)声明状态/启用方式/接口边界/关联 ADR。
2. 更新根 `pnpm-workspace.yaml` 打包范围（需含 `modules/*`) 并在主 app 声明 `workspace:*` 依赖。

> 新增模块属于机制变更类，需同步更新文档登记表核验日期。

## 4. 升级 / 降级模块版本

1. 记录升级/降级原因并建 `CR-*`（对齐 [PRD 15.1](../reference/PRD.md#prd-reference-manifest) 参考仓库规则）；
2. 在子模块内 checkout 目标版本 → 更新指针；主仓 `pnpm install` 后跑模块测试 + 主仓集成 CI；
3. 通过后提交两层指针；失败则回退指针并保留回归记录。

## 5. 删除 / 停用一个可选模块

1. 从[可选功能清单](../explanation/optional_modules.md#4-可选功能清单)移除或标 `远期`；
2. 从主 app 依赖与构建清单剔除 `workspace:*` 引用；
3. 清理子模块：

```bash
git submodule deinit -f modules/<name>   # 彻底移出
rm -rf .git/modules/<name> modules/<name>
git rm -f modules/<name>
```

1. 被停用模块的数据按主仓删除/导出规则处理（不允许绕过 [DATA_PRIVACY](../reference/DATA_PRIVACY.md))。

## 6. 多开发者 / CI 协作要点

- **clone 第一步就跑 `submodule update --init`**，否则 `pnpm build` 报找不到 `@aervox/mod-*`;
- CI 中未初始化或指针未 pin 的模块应**显式失败**，不得静默跳过（见 [optional_modules.md 第 5 节](../explanation/optional_modules.md#5-生命周期与门禁));
- 合并主仓分支前检查 `.gitmodules` 与子模块指针冲突（`git diff --submodule`）;
- 若他人只切了外层指针而未切内层，拉取后执行 `git submodule update` 同步。

## 7. 常见问题

| 现象 | 原因 | 处理 |
|---|---|---|
| `pnpm install` 报缺 `@aervox/mod-*` | 子模块未初始化 | `git submodule update --init --recursive` |
| build 通过 but 模块功能不在 | 构建清单未含该模块 | 在构建配置声明启用 |
| 子模块代码不见了 | 指针未同步 | `git submodule update` |
| 两层提交错乱 | 外层指到不存在/旧 commit | 回退指针、重提内层、保持一致 |

## 门禁提醒

- 未初始化子模块视为构建失败，不静默放行;
- 新增/升级/删除可选模块均需更新[文档登记表](../README.md#11-文档生命周期登记表owner-指派与核验)与[可选功能清单](../explanation/optional_modules.md#4-可选功能清单)。
