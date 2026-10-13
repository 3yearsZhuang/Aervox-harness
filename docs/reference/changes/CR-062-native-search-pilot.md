---
id: CR-062
type: reference
scope: change
owner: platform
doc_status: review-candidate
decision_status: accepted
delivery_status: implemented
version: 0.1.1
updated_at: 2026-10-12
reviewed_at: 2026-10-12
review_interval_days: 90
sources:
  - docs/reference/ARCHITECTURE.md
  - docs/explanation/architecture-implementation-review.md
  - docs/reference/REQUIREMENTS_TRACEABILITY.md
---

# CR-062 有界代码搜索与原生向量计算试点

## 1. 决策与范围

维护者于 2026-10-12 授权按 Rust 评估建议在新分支落地。取号已核对归档仓库最大编号 CR-059 与主仓 CR-061。当前工作归属 [ITER-017](../../../plan.md#iter-017)。

本次实施有界本地代码搜索、向量计算对照及合成数据基准。保持 TypeScript 业务主体、本地 SQLite 真源、现有授权和删除责任；不切换生产向量索引，不迁移业务数据库，不替换 Electron 或 Agent Core。

## 2. 搜索行为差量

- `dsh_search_code` 从 API 事件循环中的同步目录扫描改为受控 `ripgrep` 子进程。二进制由锁定版本的 npm 平台包分发，不依赖用户 PATH，不在运行期下载。
- 保留字面文本匹配、默认大小写不敏感、相对路径、行号、行内容和全局结果数上限。大小写比较采用 `ripgrep` 的 Unicode 简单折叠；包含换行、空字符或超过 4096 字节的查询明确拒绝。
- 不使用 `.gitignore` 缩小原有搜索范围；继续跳过隐藏条目、`node_modules`、`dist` 与原有二进制扩展名，不跟随符号链接，起始目录真实路径须在仓库根内。
- 单文件扫描上限 8 MiB，单次搜索截止 10 秒，单进程最多两路搜索，输出与单条记录均设上限。达到匹配数上限时停止子进程；超时、取消、资源上限或执行失败明确返回错误，不伪装成完整空结果。文件大小限制在工具说明中可见。
- 参数以数组传递，不经过 Shell。调用者取消信号经本地 MCP 回路到达搜索进程，进程退出后释放并发名额。

## 3. 向量试点与采纳标准

用固定种子生成 1 千、1 万、10 万条向量，对照当前 JSON 解析加全排序、TypeScript 有界 top-K、连续数组及 Rust 计算实现。报告注明数据维度、设备、样本数、预热、延迟分位数、内存采样边界、候选结果一致性和进程/传输开销。不能把纯计算耗时当作 SQLite 端到端收益。

Rust 原型只处理合成向量，不拥有业务记录或授权真源。生产接入必须另有完整 SQLite 查询基准、召回资格与删除回归、跨平台构建及有意义的端到端收益；若收益不足，保留负结果并继续使用 TypeScript。成熟原生索引扩展作为后续对照，不因引入 Rust 而自研持久索引。

## 4. 后续宿主方案（待评审）

以下是可评审的后续范围，不属于本次实施承诺，也不改变对应计划条目状态。

- Privacy Helper：首个切片只实现应用活动 Provider 的权限探测、事件采集及撤权停止，使用现有 Provider 边界；业务画像与授权仍由既有宿主管理。验收 UI 退出后采集生命周期、撤权及时停止、重启不复用过期授权、macOS 签名及权限矩阵。独立签名与 OS Broker 合同需专项 CR。
- 进程主管：按 [ITER-015](../../../plan.md#iter-015) 管理 API、Worker 与模型进程的唯一所有权、就绪和退出；不接管业务数据库写入或 Privacy Helper 权限。验收干净目录安装、端口冲突、随机退出、子进程残留及版本回退，明确各平台服务管理与签名方案后立专项 CR。

## 5. 验证与回滚

代码搜索验证真实二进制、字面匹配、大小写、忽略规则、全局上限、越界路径、取消、超时、输出洪泛和失败后的资源回收。向量验证排序、同分顺序、零向量、阈值和不同规模的结果一致性，性能数字不作为机器负载敏感的单元门禁。

交付运行完整代码与文档门禁。回滚以本分支代码和依赖版本为单位，不涉及数据转换；原生向量试点不进入默认 API/Worker 运行路径。架构与交付证据按现行真源更新，原型验证不提升生产发布状态。

本次切片已实施，验证与合成基准见[交付登记](../REQUIREMENTS_TRACEABILITY.md#42-落地实现登记)和[架构评估 §8](../../explanation/architecture-implementation-review.md#8-本轮验证与剩余限制)。后续宿主方案仍待专项评审；ITER-017 的生产测量及其它性能治理差量保持原有验收门槛。
