/**
 * Aervox｜思隅 @aervox/repositories — Schema ⇄ DDL 索引等价性守卫
 *
 * 规则依据：docs/reference/DATABASE.md §2「机器事实源与包边界」——
 * `packages/schema/src/*.ts` 是表与字段的机器事实源，而
 * `packages/repositories/src/schema/ddl/*.ts` **必须与 Schema 等价**且可从空库幂等初始化。
 *
 * 背景：该不变量此前长期无人校验，实际漂移严重——DDL 创建了 169 个索引而 Schema 只声明 106 个，
 * 交集仅 96。后果有二：
 * - 一旦有人对真实库执行 `drizzle-kit generate`，会生成「DROP 掉数十个性能索引」的迁移；
 * - 反向的 10 个「Schema 声明但从未创建」的索引让读路径误以为有索引可用。
 *
 * 本测试用真实内存库的 `PRAGMA index_list/index_info` 与 Drizzle 的 `getTableConfig`
 * 双向比对，把不变量锁死；两侧集合必须逐名逐列相等。
 */
import { describe, expect, it } from "vitest";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import * as schemaModule from "@aervox/schema";
import { createInMemoryDatabase, initDatabaseSchema, initLedgerSchema } from "../src/index.js";


interface IndexInfo {
  table: string;
  name: string;
  columns: string[];
  unique: boolean;
}

/** Schema 侧：Drizzle 声明的索引 / 唯一约束 / 主键列集。 */
function collectSchemaIndexes(): {
  indexes: IndexInfo[];
  constrainedUnique: Map<string, Set<string>>;
} {
  const indexes: IndexInfo[] = [];
  const constrainedUnique = new Map<string, Set<string>>();

  for (const value of Object.values(schemaModule)) {
    let config: ReturnType<typeof getTableConfig>;
    try {
      config = getTableConfig(value as never);
    } catch {
      continue;
    }
    if (!config || typeof config.name !== "string" || !Array.isArray(config.columns)) continue;
    const table = config.name;

    for (const index of config.indexes) {
      // 表达式索引（`index(...).on(sql\`...\`)`）的列不是普通列，暂不参与列集比对
      const columns = index.config.columns.map((c) => (c as { name?: string }).name ?? "<expr>");
      indexes.push({
        table,
        name: index.config.name,
        columns,
        unique: Boolean(index.config.unique),
      });
    }

    const covered = new Set<string>();
    for (const constraint of config.uniqueConstraints) {
      covered.add(constraint.columns.map((c) => c.name).join(","));
    }
    for (const key of config.primaryKeys) {
      covered.add(key.columns.map((c) => c.name).join(","));
    }
    // 单列主键在 Drizzle 里可能表现为列级 primaryKey()，用列属性兜底
    for (const column of config.columns) {
      if (column.primaryKey) covered.add(column.name);
    }
    constrainedUnique.set(table, covered);
  }

  return { indexes, constrainedUnique };
}

/** DDL 侧：真实空库初始化后由 SQLite 实际创建的索引与约束。 */
async function collectDdlState(client: {
  execute: (sql: string) => Promise<{ rows: Array<Record<string, unknown>> }>;
}): Promise<{
  created: IndexInfo[];
  constrainedUnique: Map<string, Set<string>>;
}> {
  const tables = await client.execute(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
  );
  const created: IndexInfo[] = [];
  const constrainedUnique = new Map<string, Set<string>>();

  for (const row of tables.rows) {
    const table = String(row.name);
    const list = await client.execute(`PRAGMA index_list('${table}')`);
    const covered = new Set<string>();
    constrainedUnique.set(table, covered);

    for (const indexRow of list.rows) {
      const name = String(indexRow.name);
      const unique = Number(indexRow.unique) === 1;
      // origin: 'c' = CREATE INDEX 创建，'u' = UNIQUE 约束，'pk' = 主键
      const origin = String(indexRow.origin);
      const info = await client.execute(`PRAGMA index_info('${name}')`);
      const columns = info.rows
        .sort((a, b) => Number(a.seqno) - Number(b.seqno))
        .map((r) => String(r.name));

      if (origin === "c") {
        created.push({ table, name, columns, unique });
      } else if (unique || origin === "pk") {
        // 表级 UNIQUE() / PRIMARY KEY 由 SQLite 建 sqlite_autoindex_*，名称不可控，
        // 故只比较「被约束覆盖的列集」。
        covered.add(columns.join(","));
      }
    }
  }

  return { created, constrainedUnique };
}

describe("Schema ⇄ DDL 索引等价性（docs/reference/DATABASE.md §2）", () => {
  it("两侧索引集合逐名逐列相等，且不存在「声明了却从未创建」的索引", async () => {
    const { client, cleanup } = await createInMemoryDatabase();
    try {
      await initDatabaseSchema(client);
      // 账本是独立故障域，主库初始化不包含它（另有 initLedgerSchema 入口）；
      // 这里一并初始化，使 recovery_control_ledger 也纳入等价性校验。
      await initLedgerSchema(client);

      const schema = collectSchemaIndexes();
      const ddl = await collectDdlState(client);

      const schemaByName = new Map(schema.indexes.map((i) => [i.name, i]));
      const ddlByName = new Map(ddl.created.map((i) => [i.name, i]));

      // 方向一：DDL 实际创建的索引，Schema 必须同名声明（否则 drizzle-kit 会生成 DROP）
      const missingInSchema = ddl.created
        .filter((i) => !schemaByName.has(i.name))
        .map((i) => `${i.table}.${i.name}(${i.columns.join(", ")})`)
        .sort();
      expect(missingInSchema).toEqual([]);

      // 方向二：Schema 声明的索引必须真的被创建，或其唯一性已由表级约束等价覆盖
      const neverCreated = schema.indexes
        .filter((i) => {
          if (ddlByName.has(i.name)) return false;
          const covered = ddl.constrainedUnique.get(i.table);
          return !(i.unique && covered?.has(i.columns.join(",")));
        })
        .map((i) => `${i.table}.${i.name}(${i.columns.join(", ")})`)
        .sort();
      expect(neverCreated).toEqual([]);

      // 方向三：同名索引的列集与唯一性必须一致
      const mismatched: string[] = [];
      for (const [name, ddlIndex] of ddlByName) {
        const schemaIndex = schemaByName.get(name);
        if (!schemaIndex) continue;
        const sameColumns = schemaIndex.columns.join(",") === ddlIndex.columns.join(",");
        const sameUnique = schemaIndex.unique === ddlIndex.unique;
        if (!sameColumns || !sameUnique) {
          mismatched.push(
            `${name}: schema=(${schemaIndex.columns.join(",")})${schemaIndex.unique ? " UNIQUE" : ""}` +
              ` vs ddl=(${ddlIndex.columns.join(",")})${ddlIndex.unique ? " UNIQUE" : ""}`,
          );
        }
      }
      expect(mismatched.sort()).toEqual([]);
    } finally {
      await cleanup();
    }
  });
});
