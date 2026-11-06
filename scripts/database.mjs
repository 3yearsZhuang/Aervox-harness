#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const help = `用法: ./aervox database <操作> [参数]
  status                              查看当前主库（不显示凭据）
  migrate --source <SQLite文件> --schema <独立schema> --backup <新目录>
          [--instance <实例ID>] [--vault <本地Vault>] [--ledger <本地账本>]
                                      停止API/Worker后，备份、导入并验证
  activate --receipt <迁移回执>        验证后切换主库，保留SQLite写入锁
  recover                             原操作进程退出后恢复中断的切换
  abort --source <SQLite文件>          放弃未启用迁移，保留备份和目标schema

连接凭据只从 AERVOX_POSTGRESQL_URL 读取。
SQLite默认保留；先在插件市场安装并启用 PostgreSQL 插件。
切换配置默认在 data/database-selection.json，可用 AERVOX_DATABASE_SELECTION_PATH 指定。`;
class DatabaseCommandUsageError extends Error {}

export async function runDatabaseCommand(argv, api, env = process.env, write = console.log) {
  const [operation = 'status', ...args] = argv;
  if (['help', '-h', '--help'].includes(operation)) { write(help); return; }
  const allowed = {
    status: [], migrate: ['source', 'schema', 'backup', 'instance', 'vault', 'ledger'],
    activate: ['receipt'], recover: [], abort: ['source'],
  }[operation];
  if (!allowed) throw new DatabaseCommandUsageError('未知数据库操作；运行 ./aervox database help');
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]?.slice(2), value = args[i + 1];
    if (!args[i]?.startsWith('--') || !allowed.includes(key) || !value || value.startsWith('--') || Object.hasOwn(options, key)) {
      throw new DatabaseCommandUsageError('数据库参数无效；连接地址须使用 AERVOX_POSTGRESQL_URL');
    }
    options[key] = value;
  }
  const required = key => { if (!options[key]) throw new DatabaseCommandUsageError(`缺少 --${key}`); return options[key]; };
  const connection = () => { if (!env.AERVOX_POSTGRESQL_URL) throw new DatabaseCommandUsageError('缺少 AERVOX_POSTGRESQL_URL'); return env.AERVOX_POSTGRESQL_URL; };
  let result;
  switch (operation) {
    case 'status': result = await api.getDatabaseSelectionStatus(); break;
    case 'migrate': {
      const receipt = await api.preparePostgresqlDatabaseMigration({
        sourcePath: required('source'), targetSchema: required('schema'), backupDirectory: required('backup'),
        instanceId: options.instance ?? randomUUID(), connectionString: connection(),
        protectedVaultPath: options.vault ?? fileURLToPath(api.resolveProactiveVaultUrl()), controlLedgerPath: options.ledger,
      });
      result = { phase: receipt.phase, receiptPath: receipt.receiptPath, locality: receipt.target.locality,
        schema: receipt.target.schema, sourcePreserved: true, activated: false };
      break;
    }
    case 'activate': result = await api.activatePostgresqlMigration({ receiptPath: required('receipt'), connectionString: connection() }); break;
    case 'recover': result = await api.recoverDatabaseActivation(); break;
    case 'abort': result = await api.abortSqliteToPostgresqlMigration({ sourcePath: required('source') }); break;
  }
  write(JSON.stringify(result, null, 2));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    if (['help', '-h', '--help'].includes(process.argv[2])) console.log(help);
    else await runDatabaseCommand(process.argv.slice(2), await import('@aervox/repositories'));
  } catch (error) {
    // Driver errors can include connection values; emit only a bounded safe code.
    const code = typeof error?.code === 'string' && /^[A-Z0-9_]{3,100}$/.test(error.code) ? error.code : 'DATABASE_OPERATION_FAILED';
    const detail = error instanceof DatabaseCommandUsageError ? error.message
      : String(error?.message).includes('protected history') ? '远程迁移包含 local_only 或无法分类的历史；请使用经过验证的本机存储。'
      : String(error?.message).includes('quiescence') ? '请停止全部API、Worker和数据库连接。'
      : code === 'DATABASE_OPERATION_FAILED' ? '操作未完成；保留源库、备份与迁移证据。检查参数、停止服务和数据库配置后重试。'
      : '请检查数据库状态；中断的切换可运行 recover。';
    console.error(`${code}：${detail}`);
    process.exitCode = 1;
  }
}
