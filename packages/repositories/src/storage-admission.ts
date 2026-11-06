import fs from "node:fs";

function assertUnclaimed(filename: string): void {
  try { fs.lstatSync(`${filename}.aervox-migration.lock`); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  const error = new Error("SQLite source is fenced by a database migration; use the saved receipt to activate or explicitly abort it");
  Object.assign(error, { code: "DATABASE_MIGRATION_SOURCE_FENCED" });
  throw error;
}

/** A migrated source remains fenced even after the PostgreSQL target activates.
 * Return the actual filename so an opened client stays bound to that source,
 * even if the caller later retargets a symbolic link. Multiple hard links have
 * no single canonical sidecar identity and are conservatively unsupported. */
export function assertSqliteMigrationUnlocked(filename: string): string {
  assertUnclaimed(filename);
  let actual: string;
  try { actual = fs.realpathSync(filename); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    // A dangling file symlink may point to a fenced source whose primary file
    // was removed. Do not recreate that target under the alias's sidecar name.
    try { fs.lstatSync(filename); }
    catch (inspectionError) { if ((inspectionError as NodeJS.ErrnoException).code === "ENOENT") return filename; throw inspectionError; }
    throw error;
  }
  assertUnclaimed(actual);
  const stat = fs.statSync(actual);
  if (stat.isFile() && stat.nlink > 1) {
    const error = new Error("SQLite source has multiple hard links; one source filename is required for migration admission");
    Object.assign(error, { code: "DATABASE_SOURCE_HARD_LINKS_UNSUPPORTED" });
    throw error;
  }
  return actual;
}
