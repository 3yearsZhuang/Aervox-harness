/** Node build-time data only. This is neither an initializer nor a migration
 * plan: a native consumer must prove an empty isolated database, execute one
 * atomic initialization, verify physical parity and only then bind the journal.
 * Unknown or existing databases still require the ordinary schema/migration gate.
 */
import {
  CURRENT_SCHEMA_VERSION, SCHEMA_RELEASES, SCHEMA_VERSION_JOURNAL_SQL,
  schemaFingerprint, schemaManifest, SchemaMigrationRequiredError, type SchemaScope,
} from "./manifest.js";
import { FTS_SCHEMA_STATEMENTS } from "./fts-definition.js";

export interface PortableSchemaArtifact {
  readonly formatVersion: 1;
  readonly scope: SchemaScope;
  readonly schemaVersion: number;
  /** Canonical schema release identity, not a checksum/authenticator of artifact bytes or projections. */
  readonly fingerprint: string;
  readonly initialization: {
    readonly requiredDatabaseState: "empty";
    readonly statements: readonly string[];
    readonly journal: {
      readonly sql: string;
      readonly parameters: Readonly<{ scope: SchemaScope; version: string; fingerprint: string }>;
      readonly requiredRuntimeParameters: readonly ["applied_at"];
    };
  };
  readonly projections: {
    readonly rebuildable: true;
    readonly statements: readonly string[];
  };
}

/** Generate deterministic JSON from the sole schema declarations and release
 * ledger. It performs no database or filesystem access and contains no paths,
 * timestamps, driver instances or business rows. main and ledger remain distinct.
 */
export function buildPortableSchemaArtifact(scope: SchemaScope): PortableSchemaArtifact {
  if (scope !== "main" && scope !== "ledger") throw new Error("Unsupported schema scope");
  const fingerprint = schemaFingerprint(scope);
  if (SCHEMA_RELEASES[CURRENT_SCHEMA_VERSION]?.[scope] !== fingerprint) {
    throw new SchemaMigrationRequiredError([`${scope}: target changed without a versioned migration`]);
  }
  return Object.freeze({
    formatVersion: 1,
    scope,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    fingerprint,
    initialization: Object.freeze({
      requiredDatabaseState: "empty",
      statements: Object.freeze(schemaManifest(scope).flatMap(table => [table.sql, ...table.indexes.map(index => index.sql)])),
      journal: Object.freeze({
        sql: SCHEMA_VERSION_JOURNAL_SQL,
        parameters: Object.freeze({ scope, version: String(CURRENT_SCHEMA_VERSION), fingerprint }),
        requiredRuntimeParameters: Object.freeze(["applied_at"] as const),
      }),
    }),
    projections: Object.freeze({ rebuildable: true, statements: Object.freeze(scope === "main" ? [...FTS_SCHEMA_STATEMENTS] : []) }),
  });
}
