/** Explicit expressions for the shared query frontend. No SQL text is translated. */
import { sql, type SQL, type SQLWrapper } from "drizzle-orm";
import { backendFor } from "./database-backend.js";

type Expression = SQLWrapper;
const literal = (value: string): SQL => sql.raw(`'${value.replaceAll("'", "''")}'`);
const postgres = (db: object): boolean => backendFor(db) === "postgresql";

function jsonPath(value: Expression, path: string): SQL {
  if (path === "$") return sql`cast(${value} as json)`;
  if (!/^\$(?:\.[A-Za-z_][A-Za-z0-9_]*)+$/.test(path)) throw new TypeError("Unsupported repository JSON path");
  return path.slice(2).split(".").reduce((query, key) => sql`${query}->${literal(key)}`, sql`cast(${value} as json)`);
}

export function validJson(db: object, value: Expression): SQL {
  return postgres(db) ? sql`(${value} is json value)` : sql`json_valid(${value})`;
}

/** Missing or malformed values remain NULL, rather than establishing identity. */
export function jsonText(db: object, value: Expression, path: string): SQL<string | null> {
  if (!postgres(db)) return sql`case when json_valid(${value}) then json_extract(${value}, ${literal(path)}) else null end`;
  const at = jsonPath(value, path);
  return sql`case when ${validJson(db, value)} then (${at}) #>> '{}' else null end`;
}

export function jsonKind(db: object, value: Expression, path = "$"): SQL<string | null> {
  if (!postgres(db)) return sql`case when json_valid(${value}) then json_type(${value}${path === "$" ? sql.empty() : sql`, ${literal(path)}`}) else null end`;
  const at = jsonPath(value, path);
  return sql`case when ${validJson(db, value)} then
    case json_typeof(${at}) when 'string' then 'text'
      when 'boolean' then cast(${at} as text)
      when 'number' then case when cast(${at} as text) ~ '^-?[0-9]+$' then 'integer' else 'real' end
      else json_typeof(${at}) end else null end`;
}

/** SQLite represents JSON booleans as 0/1, and numeric values as numbers. */
export function jsonNumber(db: object, value: Expression, path: string): SQL<number | null> {
  if (!postgres(db)) return sql`case when json_valid(${value}) then json_extract(${value}, ${literal(path)}) else null end`;
  const at = jsonPath(value, path);
  return sql`case when ${validJson(db, value)} then case json_typeof(${at})
    when 'boolean' then case when cast(${at} as text) = 'true' then 1 else 0 end
    when 'number' then cast(cast(${at} as text) as numeric)
    else null end else null end`;
}

export function nullSafeDifferent(db: object, left: Expression, right: Expression | string | number): SQL {
  return postgres(db) ? sql`${left} is distinct from ${right}` : sql`${left} is not ${right}`;
}

export function jsonValue(db: object, value: Expression): SQL {
  return postgres(db) ? sql`cast(${value} as json)` : sql`json(${value})`;
}

/** Keys are developer declarations; values retain native numeric/JSON/null types. */
export function jsonObject(db: object, entries: readonly (readonly [string, Expression])[]): SQL<string> {
  const args = sql.join(entries.flatMap(([key, value]) => [literal(key), value]), sql`, `);
  return postgres(db) ? sql`cast(json_build_object(${args}) as text)` : sql`json_object(${args})`;
}

export function jsonQuote(db: object, value: Expression): SQL<string> {
  return postgres(db) ? sql`cast(to_json(${value}) as text)` : sql`json_quote(${value})`;
}

export function byteLength(db: object, value: Expression): SQL<number> {
  return postgres(db) ? sql`octet_length(${value})` : sql`length(cast(${value} as blob))`;
}

export function rowPosition(db: object, tableAlias?: string): SQL<number> {
  const name = postgres(db) ? "_aervox_rowid" : "rowid";
  return tableAlias ? sql`${sql.identifier(tableAlias)}.${sql.identifier(name)}` : sql`${sql.identifier(name)}`;
}

export function greatest(db: object, left: Expression, right: Expression | number): SQL<number> {
  return postgres(db) ? sql`greatest(${left}, ${right})` : sql`max(${left}, ${right})`;
}

export function asciiCharactersOnly(db: object, value: Expression, allowed: "a-f0-9" | "0-9"): SQL {
  return postgres(db) ? sql`${value} !~ ${literal(`[^${allowed}]`)}`
    : sql`${value} not glob ${literal(`*[^${allowed}]*`)}`;
}

export function randomGeneration(db: object): SQL<string> {
  return postgres(db) ? sql`replace(cast(gen_random_uuid() as text), '-', '')` : sql`lower(hex(randomblob(16)))`;
}

/** Restricted repository iteration over declared JSON array/object shapes. */
export function jsonEach(db: object, value: Expression, options: { path?: string; alias?: string; kind: "array" | "object" }): SQL {
  const path = options.path ?? "$";
  const alias = options.alias ?? "json_each";
  if (!postgres(db)) return sql`json_each(${value}${path === "$" ? sql.empty() : sql`, ${literal(path)}`}) as ${sql.identifier(alias)}`;
  const at = jsonPath(value, path);
  const safe = sql`case when ${validJson(db, value)} then case when json_typeof(${at}) = ${literal(options.kind)}
    then ${at} else ${options.kind === "array" ? sql`'[]'::json` : sql`'{}'::json`} end
    else ${options.kind === "array" ? sql`'[]'::json` : sql`'{}'::json`} end`;
  const entries = options.kind === "object" ? sql`json_each(${safe}) as avx_json_entry(key, item)`
    : sql`json_array_elements(${safe}) with ordinality as avx_json_entry(item, ordinal)`;
  const key = options.kind === "object" ? sql`key` : sql`cast(ordinal - 1 as text)`;
  return sql`lateral (select ${key} as key, item #>> '{}' as value,
    case json_typeof(item) when 'string' then 'text' when 'boolean' then cast(item as text)
      when 'number' then case when cast(item as text) ~ '^-?[0-9]+$' then 'integer' else 'real' end
      else json_typeof(item) end as type from ${entries}) as ${sql.identifier(alias)}`;
}

/** Preserve SQLite's ASCII-only case folding; C collation avoids locale folding. */
export function textLike(db: object, value: Expression, pattern: string): SQL {
  return postgres(db) ? sql`translate(${value}, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz') collate "C" like
    translate(${pattern}, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz') collate "C" escape ''`
    : sql`${value} like ${pattern}`;
}

/** Nullable repository ordering retains SQLite's first-on-ASC, last-on-DESC
 * behavior. Native PostgreSQL defaults place NULL at the opposite end. */
export function ascendingNullsFirst(db: object, value: Expression): SQL {
  return postgres(db) ? sql`${value} asc nulls first` : sql`${value} asc`;
}
export function descendingNullsLast(db: object, value: Expression): SQL {
  return postgres(db) ? sql`${value} desc nulls last` : sql`${value} desc`;
}
