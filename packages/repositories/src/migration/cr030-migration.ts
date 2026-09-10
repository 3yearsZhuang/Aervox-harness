import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Client } from "@libsql/client";

export const CR030_PHASES = [
  "planned",
  "quiesced",
  "backup_verified",
  "scope_selected",
  "staging_built",
  "validated",
  "swapped",
  "completed",
] as const;

export type Cr030Phase = (typeof CR030_PHASES)[number];

export interface Cr030MigrationState {
  readonly phase: Cr030Phase;
  readonly sourceReplaced: boolean;
  readonly updatedAt: string;
  readonly selectedScope?: ScopeKey;
}

export interface ScopeKey {
  readonly workspaceId: string;
  readonly subjectUserId: string;
}

export interface LegacyScope {
  readonly key: ScopeKey;
  readonly rowCount: number;
  readonly rowsByTable: Readonly<Record<string, number>>;
}

export interface LegacyScopeScan {
  readonly tables: readonly string[];
  readonly scopes: readonly LegacyScope[];
  readonly issues: readonly string[];
}

export interface ScopeSelection {
  readonly mode: "system-only" | "single" | "explicit";
  readonly scope?: ScopeKey;
}

const transitions: Readonly<Record<Cr030Phase, readonly Cr030Phase[]>> = {
  planned: ["quiesced"],
  quiesced: ["backup_verified"],
  backup_verified: ["scope_selected"],
  scope_selected: ["staging_built"],
  staging_built: ["validated"],
  validated: ["swapped"],
  swapped: ["completed"],
  completed: [],
};

export function canAdvanceCr030Phase(from: Cr030Phase, to: Cr030Phase): boolean {
  return transitions[from].includes(to);
}

export function assertSafeStartup(state: Cr030MigrationState | undefined): void {
  if (!state) return;
  if (state.phase === "completed") return;
  if (state.phase === "planned" && !state.sourceReplaced) return;
  throw new Error(`CR-030 migration is incomplete (${state.phase}); startup must fail closed`);
}

export class Cr030MigrationStateStore {
  public constructor(private readonly statePath: string) {}

  public async read(): Promise<Cr030MigrationState | undefined> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.statePath, "utf8")) as Cr030MigrationState;
      if (!CR030_PHASES.includes(parsed.phase) || typeof parsed.sourceReplaced !== "boolean") {
        throw new Error("invalid CR-030 migration state");
      }
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  public async write(state: Cr030MigrationState): Promise<void> {
    await fs.mkdir(path.dirname(this.statePath), { recursive: true });
    const temporaryPath = `${this.statePath}.tmp-${process.pid}-${randomUUID()}`;
    await fs.writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    const handle = await fs.open(temporaryPath, "r+");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temporaryPath, this.statePath);
  }

  public async initialize(): Promise<Cr030MigrationState> {
    const existing = await this.read();
    if (existing) return existing;
    const planned: Cr030MigrationState = {
      phase: "planned",
      sourceReplaced: false,
      updatedAt: new Date().toISOString(),
    };
    await this.write(planned);
    return planned;
  }

  public async transition(
    to: Cr030Phase,
    options: { selectedScope?: ScopeKey } = {},
  ): Promise<Cr030MigrationState> {
    const current = (await this.read()) ?? {
      phase: "planned" as const,
      sourceReplaced: false,
      updatedAt: new Date().toISOString(),
    };
    if (!canAdvanceCr030Phase(current.phase, to)) {
      throw new Error(`invalid CR-030 migration transition: ${current.phase} -> ${to}`);
    }
    const next: Cr030MigrationState = {
      phase: to,
      sourceReplaced: to === "swapped" || to === "completed" ? true : current.sourceReplaced,
      selectedScope: options.selectedScope ?? current.selectedScope,
      updatedAt: new Date().toISOString(),
    };
    await this.write(next);
    return next;
  }
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function scopeId(key: ScopeKey): string {
  return JSON.stringify([key.workspaceId, key.subjectUserId]);
}

/** Read-only inventory of legacy tenant scopes. It never mutates the source database. */
export async function scanLegacyScopes(client: Client): Promise<LegacyScopeScan> {
  const tablesResult = await client.execute(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  );
  const tables: string[] = [];
  const scopes = new Map<string, { key: ScopeKey; rowCount: number; rowsByTable: Record<string, number> }>();
  const issues: string[] = [];

  for (const tableRow of tablesResult.rows) {
    const table = String(tableRow.name);
    const columnsResult = await client.execute(`PRAGMA table_info(${quoteIdentifier(table)})`);
    const columns = new Set(columnsResult.rows.map((row) => String(row.name)));
    const hasWorkspace = columns.has("workspace_id");
    const hasSubject = columns.has("subject_user_id");
    if (!hasWorkspace && !hasSubject) continue;
    tables.push(table);
    if (!hasWorkspace || !hasSubject) {
      issues.push(`${table}: legacy tenant columns must include workspace_id and subject_user_id`);
      continue;
    }

    const rowsResult = await client.execute(
      `SELECT workspace_id, subject_user_id, COUNT(*) AS row_count FROM ${quoteIdentifier(table)} GROUP BY workspace_id, subject_user_id`,
    );
    for (const row of rowsResult.rows) {
      if (row.workspace_id == null || row.subject_user_id == null) {
        issues.push(`${table}: NULL tenant scope is not migratable`);
        continue;
      }
      const key = { workspaceId: String(row.workspace_id), subjectUserId: String(row.subject_user_id) };
      const id = scopeId(key);
      const rowCount = Number(row.row_count);
      const existing = scopes.get(id) ?? { key, rowCount: 0, rowsByTable: {} };
      existing.rowCount += rowCount;
      existing.rowsByTable[table] = (existing.rowsByTable[table] ?? 0) + rowCount;
      scopes.set(id, existing);
    }
  }

  return { tables, scopes: [...scopes.values()], issues };
}

export function selectLegacyScope(
  scan: LegacyScopeScan,
  requestedScope?: ScopeKey,
  acknowledgeDestructive = false,
): ScopeSelection {
  if (scan.issues.length > 0) throw new Error(`CR-030 scope scan failed: ${scan.issues.join("; ")}`);
  if (scan.scopes.length === 0) return { mode: "system-only" };
  if (scan.scopes.length === 1) {
    const onlyScope = scan.scopes[0];
    if (!onlyScope) throw new Error("CR-030 scope scan returned an invalid empty result");
    const only = onlyScope.key;
    if (requestedScope && scopeId(requestedScope) !== scopeId(only)) {
      throw new Error("requested CR-030 scope does not exist");
    }
    return { mode: "single", scope: only };
  }
  if (!requestedScope) throw new Error("multiple CR-030 scopes require explicit selection");
  if (!acknowledgeDestructive) throw new Error("multiple CR-030 scopes require destructive acknowledgement");
  if (!scan.scopes.some((scope) => scopeId(scope.key) === scopeId(requestedScope))) {
    throw new Error("requested CR-030 scope does not exist");
  }
  return { mode: "explicit", scope: requestedScope };
}
