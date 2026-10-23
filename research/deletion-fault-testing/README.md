# 删除故障测试：历史外部集成

此私有 workspace 持有固定历史版本的 LangChain、LlamaIndex 与 libsql 依赖和实际适配器。产品 workspace 禁止依赖它；依赖仍在仓库根统一安装、锁定并审计，普通根安装仍会安装该研究包。

在仓库根运行分层门禁：

```sh
mise exec -- pnpm check:deletion-fault-testing
mise exec -- pnpm check:deletion-fault-integration
mise exec -- node scripts/deletion-fault-testing/pilot.mjs --check
```

第一层验证引擎、计划、候选与证据校验；第二层验证固定外部 API、真实临时持久化观察器和当前源码绑定。`--check` 只解析并校验输入，不执行实验；需先完成前述构建。全量与增量 CI 均执行两个门禁，完整依赖审计继续包含研究包。

本次依赖迁移属于工程修订。论文、原始证据与方法结论仍以[归档研究包](https://github.com/3yearsZhuang/Aervox-docs-archive/tree/main/deletion-fault-testing)及冻结提交为准：初始版本 `84424da3` 的两次失败、清理时限修订 `f69addab` 的一次工程验证均保留；按对应提交检出并锁定安装复现。新布局修改了测量输入，不可用于声称旧报告的当前源码哈希仍匹配，也不计为新增正式实验或方法收益证据。
