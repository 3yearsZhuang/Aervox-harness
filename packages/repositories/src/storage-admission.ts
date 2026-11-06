import fs from "node:fs";

/** A migrated source remains fenced even after the PostgreSQL target activates. */
export function assertSqliteMigrationUnlocked(filename: string): void {
  try { fs.lstatSync(`${filename}.aervox-migration.lock`); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  const error = new Error("SQLite source is fenced by a database migration; use the saved receipt to activate or explicitly abort it");
  Object.assign(error, { code: "DATABASE_MIGRATION_SOURCE_FENCED" });
  throw error;
}
