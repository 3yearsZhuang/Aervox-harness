/** Backend identity belongs to prepared host handles, never to a caller-provided URL. */
export type DatabaseBackend = "sqlite" | "postgresql";
const backends = new WeakMap<object, DatabaseBackend>();

export function registerDatabaseBackend(database: object, backend: DatabaseBackend): void {
  const previous = backends.get(database);
  if (previous && previous !== backend) throw new Error("DATABASE_BACKEND_IDENTITY_CONFLICT");
  backends.set(database, backend);
}

/** Existing injected SQLite handles retain their original backend by default. */
export function backendFor(database: object): DatabaseBackend {
  return backends.get(database) ?? "sqlite";
}
