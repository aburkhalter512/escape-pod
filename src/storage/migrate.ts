import { MIGRATIONS, type Migration } from './schema.js'

interface AppliedMigrationRow extends Record<string, string | number | null> {
  id: number
}

// Called from EscapePodDurableObject's constructor inside
// blockConcurrencyWhile, so no request is served until this finishes.
// Idempotent — safe to call on every DO startup, not just the first.
export function runMigrations(storage: DurableObjectStorage): void {
  // PRAGMA changes are silently ignored inside a transaction, and aren't
  // persisted across connections — must run first, unconditionally,
  // outside any transactionSync block below.
  storage.sql.exec('PRAGMA foreign_keys = ON')

  storage.sql.exec(`CREATE TABLE IF NOT EXISTS _schema_migrations (
    id INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
  )`)

  const applied = new Set(
    [...storage.sql.exec<AppliedMigrationRow>('SELECT id FROM _schema_migrations')].map((row) => row.id)
  )

  for (const migration of MIGRATIONS) {
    if (!applied.has(migration.id)) {
      applyMigration(storage, migration)
    }
  }
}

function applyMigration(storage: DurableObjectStorage, migration: Migration): void {
  storage.transactionSync(() => {
    for (const statement of migration.statements) {
      storage.sql.exec(statement)
    }
    storage.sql.exec('INSERT INTO _schema_migrations (id, applied_at) VALUES (?, ?)', migration.id, new Date().toISOString())
  })
}
