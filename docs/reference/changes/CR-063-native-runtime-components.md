---
id: CR-063
type: reference
scope: change
owner: platform
doc_status: review-candidate
decision_status: accepted
delivery_status: implemented
version: 0.1.2
updated_at: 2026-10-13
reviewed_at: 2026-10-13
review_interval_days: 90
sources:
  - docs/reference/ARCHITECTURE.md
  - docs/reference/DATABASE.md
  - docs/reference/SRS.md
  - docs/reference/changes/CR-062-native-search-pilot.md
---

# CR-063 原生计算、活动 Helper 与进程主管

## 1. 授权与交付边界

维护者于 2026-10-12 授权在 Rust 分支继续完成评估方向，并明确同时支持 macOS、Windows、Linux。本提案承接 CR-062，挂靠 ITER-017、ITER-015 与 CAP-005/018/020/027/033。取号已核对主仓 CR-062 和归档库 CR-059。

TypeScript 继续负责业务、授权、写事务与数据权利。`@aervox/native-runtime` 只提供有界异步进程通信、可信制品校验和可关闭生命周期；Rust 承接只读向量计算、应用活动元数据与声明进程树管理。默认检出不依赖预先存在的二进制。生产签名、OS 权限和实机发布验收分别取证，不以合同测试冒充。

## 2. 向量计算合同

SQLite 仍是唯一真源，写入、删除和模型切换沿现有仓储 Port。Rust 连接以只读模式打开显式本地数据库；按模型缓存连续浮点数据，不复制业务正文。每次查询核对 SQLite `data_version`，缓存随其他连接提交、模型变化或文件替换失效；新进程不复用旧缓存。SQLite 读入与 JSON 解码只在水位变化时发生，查询只传输向量和 top-K 结果，不逐行跨语言调用。

查询保留余弦、零向量、维度不匹配、阈值及同分顺序。来源资格在 TypeScript 宿主返回模型上下文前回读真源；缓存不得成为删除或授权真源。更新中失去一致性时有界重试或明确失败。只读连接不能将缓存回写业务库。内存、记录数、维度、消息、并发与截止均有限额。原生进程失败允许回到权威 SQLite 路径，禁止返回旧缓存结果。

固定文件 SQLite 负载比较全排序、TypeScript 有界 top-K、连续数组缓存、Rust 冷/热查询及 `sqlite-vec`；记录查询与进程开销、候选质量和浮点精度差量。默认方案由端到端收益决定，成熟扩展只在隔离基准库试验，不迁移生产 Schema。

## 3. 系统活动 Helper

Provider 只产出当前应用标识、名称及 PID，不采集窗口标题、网址、命令行、键盘内容或任意文件。macOS 使用 AppKit 与真实 Accessibility 状态；Windows 使用前台窗口及受限进程查询；Linux 使用 X11/EWMH，Wayland 无可信前台应用接口时报告不可用，禁止退回全进程列表冒充前台活动。

宿主每次采集核对设备、授权 revision、来源 Grant、激活 epoch、有效期与暂停/撤权状态。Helper 的短租约仅存内存、到期停止，重启不自动恢复旧授权；私有标准输入是控制通道，记录仍沿现有 CAP-033 入库与删除链。UI 窗口关闭可由已确认后台授权继续运行；宿主退出、通信中断或授权失效后停止。生产 Helper 必须校验随发行包签署的制品摘要与签名；开发测试豁免只能由宿主显式配置且不能用于打包态。

## 4. 进程主管与其它计算

主管使用显式版本化清单，仅启动声明的 API、Worker 与模型角色，参数数组传递、不经过 Shell；同一数据目录只有一个持锁主管。按 PID/进程组或 Windows Job 回收自己创建的进程树；端口冲突、就绪超时、子进程异常、关闭与父通道退出均可见。模型角色不得同时由 API 模型 Driver 启动。版本失败保留数据与旧制品，升级/卸载不删除业务目录；签名、公证和平台发行矩阵仍是发布门槛。

音频先测 WAV 解码、混音与重采样；原生预处理可选接入现有 ASR Provider，识别继续使用 `sherpa-onnx`。插件包先比较有界 Worker 与原生处理；没有实测收益时保留成熟压缩库，隔离同步计算。所有输入限额、格式错误、超时和取消均须有回归，不能为了性能降低预检与路径校验。

## 5. 验证与退出

验证文件 SQLite 更新、外连接删除、模型切换、资格过滤、进程崩溃、错误消息与超时；Helper 验证无租约、错设备/修订、撤权、到期、重启及真实 OS 探测；主管验证重复归属、异常退出、端口占用、就绪失败及后代清理。三平台构建与可执行合同纳入 CI，平台能力探测与真实桌面权限矩阵分别报告。

关闭原生选项或移除制品后业务走 TypeScript 路径；停用 Helper 不恢复授权，主管停止只回收自己创建的进程。没有业务数据格式迁移，也不因实现完成直接提升 Released 状态。

实现与基准见[追踪基线 §4.2](../REQUIREMENTS_TRACEABILITY.md#42-落地实现登记)和[原生组件操作指南](../../how-to/run-native-components.md)。本切片提供可配置的 Rust 与连续数组 Worker 向量 Port、三平台活动 Provider、租约/签名闸门、声明主管、可选音频预处理与插件 Worker。未执行生产迁移、OS 系统服务注册或公开发布。

## 6. 原生源码与 IPC 结构收敛

维护者于 2026-10-13 授权按结构建议顺序实施：分离构建任务、统一 Cargo 工作区、拆分平台模块与 IPC 契约。沿用既有数据所有权和进程边界，目录事实源见[架构 §3](../ARCHITECTURE.md#3-仓库与领域边界)。

迁移将 `packages/native-runtime/native` 与 `scripts/native-vector` 合并为顶层 `native/` 的两个 Cargo 成员，共用锁文件并保留依赖版本。TypeScript 公共出口和发行制品路径保持兼容；源码回退须同时回退构建路径、增量范围和协议生成物，不触及业务数据。

`native/protocol/runtime.json` 是内部 IPC 的唯一机读定义，声明方法、输入输出、错误码、版本与帧限额。采用生成器显式支持的 JSON Schema 子集；Rust 嵌入同一文件，TypeScript 类型从该文件生成，双端执行同一组正反夹具。公共 HTTP/OpenAPI 契约继续由 `packages/contracts` 管理。

协议维持 v1，宿主在每个进程代际的首次业务调用前校验握手；非法消息、错误结果形状和未知错误码明确失败。活动租约或采集请求校验失败会失效该实例授权；有效请求沿原有授权与租约复核执行。生成物漂移、协议不匹配、冷构建缺失制品和包外源码未触发验证均由自动化门禁覆盖。

独立 Helper/主管发行物以独立权限、签名身份或部署生命周期需求为前提；本切片继续使用单一生产可执行文件和各宿主分别拥有的进程实例。签名、公证、安装升级与平台实机发布验收仍按 ITER-015 取证。
