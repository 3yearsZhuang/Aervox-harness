# 操作指南：可选模块的 submodule 初始化与协作规范（How-to）

- 提出人：3yearszhuang · 2026-08-26
- 修改人：3yearszhuang · 2026-08-31

> 文档编号：AVX-GUIDE-003  
> 类型：How-To  
> 版本：v0.2  
> 更新日期：2026-08-31
> 状态：Draft  
> 关联：[能力注册表](../reference/capability-registry.md) · [能力组合与可选化目录规范](../reference/capability-composition.md) · [文档索引](../README.md)

本指南回答"引入 `modules/*` 之后的 clone、初始化、增删、升级和协作流程"，是[能力注册表](../reference/capability-registry.md)（交付载体与启用方式登记）与[能力组合与可选化目录规范](../reference/capability-composition.md)（机制与判定准则）的落地操作手册。机制决定与门禁以它们为准，本文件只给步骤与规范，不重复规则。

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

按 [§8 生命周期门禁](#8-生命周期门禁) 执行，新增必须：

1. 走 `CR-*` 登记新模块与受影响 `CAP-*`;
2. 建立独立 git 仓库并固定初始版本;
3. 以 submodule 挂入（推荐挂 `modules/<name>`)：

```bash
git submodule add <repo-url> modules/<name>
git add .gitmodules modules/<name>
```

1. 在[能力注册表](../reference/capability-registry.md)声明状态/启用方式/接口边界/关联 ADR。
2. 更新根 `pnpm-workspace.yaml` 打包范围（若尚未声明 `modules/*`，先加回该条目；当前仓库未声明，属 ADR-001/AVX-CAP-001 预留的可选能力 submodule 宿主机制）并在主 app 声明 `workspace:*` 依赖。

> 新增模块属于机制变更类，需同步更新文档登记表核验日期。

## 4. 升级 / 降级模块版本

1. 记录升级/降级原因并建 `CR-*`（对齐 [PRD 15.1](../reference/PRD.md#prd-reference-manifest) 参考仓库规则）；
2. 在子模块内 checkout 目标版本 → 更新指针；主仓 `pnpm install` 后跑模块测试 + 主仓集成 CI；
3. 通过后提交两层指针；失败则回退指针并保留回归记录。

## 5. 删除 / 停用一个可选模块

1. 从[能力注册表](../reference/capability-registry.md)移除或标 `远期`；
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
- CI 中未初始化或指针未 pin 的模块应**显式失败**，不得静默跳过（见 [§8 生命周期门禁](#8-生命周期门禁));
- 合并主仓分支前检查 `.gitmodules` 与子模块指针冲突（`git diff --submodule`）;
- 若他人只切了外层指针而未切内层，拉取后执行 `git submodule update` 同步。

## 7. 常见问题

| 现象 | 原因 | 处理 |
|---|---|---|
| `pnpm install` 报缺 `@aervox/mod-*` | 子模块未初始化 | `git submodule update --init --recursive` |
| build 通过 but 模块功能不在 | 构建清单未含该模块 | 在构建配置声明启用 |
| 子模块代码不见了 | 指针未同步 | `git submodule update` |
| 两层提交错乱 | 外层指到不存在/旧 commit | 回退指针、重提内层、保持一致 |

## 8. 生命周期门禁

模块的新增、升级、停用必须满足以下门禁，未满足视为未闭环、提交打回：

1. **新增**：先走 `CR-*` 在[需求追踪基线](../reference/REQUIREMENTS_TRACEABILITY.md)与[能力注册表](../reference/capability-registry.md)登记新模块及受影响 `CAP-*` → 建立独立 git 仓库并固定初始版本 → 以 submodule 挂入 `modules/*` → 声明状态/启用方式/接口边界/关联 ADR → 更新[文档生命周期登记表](../DOC_REGISTRY.md)与构建清单（步骤见[§3 新增](#3-新增一个可选模块)）。
2. **CI**：模块自身 CI（build/typecheck/test/OpenAPI diff）+ 主仓集成 CI（引用改动时跑）；`ci.yml` 需纳入 `modules/*`；未初始化的 submodule 应让 CI **显式失败**而非静默跳过。
3. **许可证 / 安全**：每个模块按其来源执行许可证评审（对齐 [PRD 15.1](../reference/PRD.md#prd-reference-manifest)）；AGPL 类模块不得形成主仓链接依赖。
4. **数据 / 隐私 / 删除**：模块不得绕过主仓删除、同意、导出与保留边界（见[能力组合规范 · 接口边界](../reference/capability-composition.md#接口边界)）；被停用模块的数据按主仓删除/导出规则处理，不允许绕过 [DATA_PRIVACY](../reference/DATA_PRIVACY.md)。
5. **回滚 / 降级**：任一模块构建或运行时降级不阻断核心流程；失败则回退指针并保留回归记录。
6. **更新登记**：模块每次批准/修订后更新[能力注册表](../reference/capability-registry.md)与[文档生命周期登记表](../DOC_REGISTRY.md)核验日期。

## 门禁提醒

- 未初始化子模块视为构建失败，不静默放行；
- 新增/升级/删除模块均需满足[§8 生命周期门禁](#8-生命周期门禁)，并同步更新[文档生命周期登记表](../DOC_REGISTRY.md)与[能力注册表](../reference/capability-registry.md)。
