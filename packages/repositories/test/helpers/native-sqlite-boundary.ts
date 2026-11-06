import type { Client, InStatement, Transaction } from "@libsql/client";

export function nativeSqliteBoundary(client: Client, options: { truncateNul?: boolean } = {}) {
  const measurements = { largestWindowBytes: 0 };
  const cap = <T extends Client | Transaction>(target: T): T => new Proxy(target, { get(owner, property) {
    if (property === "execute") return async (input: InStatement) => {
      const result = await owner.execute(input);
      // A native result must fit one 1 MiB CursorWindow without refill. Account
      // for cell/row allocation as well as UTF-8 bodies at the real SQL boundary.
      const bytes = result.rows.reduce((total, row) => total + 16 + result.columns.reduce((cells, _column, index) => {
        const value = row[index];
        const size = typeof value === "string" ? Buffer.byteLength(value) + 1
          : value instanceof ArrayBuffer ? value.byteLength : value === null ? 0 : 8;
        return cells + 16 + size;
      }, 0), 0);
      measurements.largestWindowBytes = Math.max(measurements.largestWindowBytes, bytes);
      if (result.rows.length > 512) throw new Error("NATIVE_RESULT_ROW_LIMIT");
      if (bytes > 1024 * 1024) throw new Error("NATIVE_CURSOR_WINDOW_LIMIT");
      if (!options.truncateNul) return result;
      // Mirror the native text decoder. JSON-quoted identities survive because
      // the cell contains an escape, while a raw text cell is truncated.
      const rows = result.rows.map(row => {
        const values = result.columns.map((_name, index) => typeof row[index] === "string" ? row[index].split("\0")[0] : row[index]);
        return Object.assign(values, Object.fromEntries(result.columns.map((name, index) => [name, values[index]])));
      });
      return { ...result, rows };
    };
    if (property === "transaction" && "transaction" in owner) return async (...input: Parameters<Client["transaction"]>) => cap(await owner.transaction(...input));
    const value: unknown = Reflect.get(owner, property, owner);
    return typeof value === "function" ? value.bind(owner) : value;
  } });
  return { client: cap(client), measurements };
}
