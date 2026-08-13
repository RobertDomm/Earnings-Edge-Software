/**
 * startup-migrations.ts
 *
 * Idempotent DDL that runs once at server startup before the HTTP server
 * begins accepting traffic. All required tables are created here so every
 * cold instance — including ones deployed before a post-merge schema push
 * runs — self-provisions on startup rather than racing to lazy-create tables
 * mid-request.
 *
 * This is intentionally belt-and-suspenders alongside the Drizzle push in
 * the post-merge script; either alone is sufficient, both together guarantee
 * the schema exists under all deployment scenarios.
 *
 * Concurrency safety: `CREATE TABLE IF NOT EXISTS` is NOT race-safe — two
 * instances booting at the same time (e.g. a workflow restart overlapping the
 * old process, or multiple deployment instances) can both pass the existence
 * check and one then dies with 42P07 "relation already exists". We defend in
 * two layers:
 *   1. A session-scoped Postgres advisory lock serialises concurrent runners.
 *   2. Each statement individually tolerates benign "duplicate object" errors,
 *      in case something outside this process created the object between
 *      checks (drizzle push, another host, etc.).
 */

import { pool } from "@workspace/db";
import { logger } from "./logger.js";

/** Arbitrary but stable app-wide lock key for startup migrations. */
const MIGRATION_ADVISORY_LOCK_KEY = 727_401_164;

/**
 * Postgres error codes that mean "the object already exists" — harmless for
 * idempotent DDL that only ever creates objects.
 *   42P07 duplicate_table / duplicate relation (tables, indexes)
 *   42710 duplicate_object (constraints, roles, etc.)
 *   42701 duplicate_column
 *   23505 unique_violation (e.g. two racers inserting the same catalog row)
 */
const BENIGN_DUPLICATE_CODES = new Set(["42P07", "42710", "42701", "23505"]);

export function isBenignDuplicateError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    BENIGN_DUPLICATE_CODES.has(String((err as { code?: unknown }).code))
  );
}

/** Minimal client shape so the runner is unit-testable without a live pool. */
export interface QueryableClient {
  query(sql: string): Promise<unknown>;
}

/**
 * Run one DDL statement, swallowing benign duplicate-object errors.
 * Any other error is fatal and rethrown.
 */
async function runIdempotentStatement(
  client: QueryableClient,
  sql: string,
): Promise<void> {
  try {
    await client.query(sql);
  } catch (err) {
    if (isBenignDuplicateError(err)) {
      logger.warn(
        { code: (err as { code?: string }).code },
        "Startup migration statement skipped — object already exists (created concurrently)",
      );
      return;
    }
    throw err;
  }
}

/** The DDL statements, in order. Exported for tests. */
export const STARTUP_MIGRATION_STATEMENTS: readonly string[] = [
  // connect-pg-simple session table.
  // Provisioned here so concurrent cold starts don't race on lazy creation.
  // Note: WITH (OIDS=FALSE) was removed — OID support was dropped in PG 12.
  `
    CREATE TABLE IF NOT EXISTS "session" (
      "sid"    varchar      NOT NULL COLLATE "default",
      "sess"   json         NOT NULL,
      "expire" timestamp(6) NOT NULL,
      CONSTRAINT "session_pkey" PRIMARY KEY ("sid") NOT DEFERRABLE INITIALLY IMMEDIATE
    )
  `,
  `
    CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "session" ("expire")
  `,
  // Scanner results — single-row store for the last scan result and status.
  `
    CREATE TABLE IF NOT EXISTS scanner_results (
      id                           integer   PRIMARY KEY DEFAULT 1,
      stocks                       jsonb     NOT NULL DEFAULT '[]',
      total_scanned                integer   NOT NULL DEFAULT 0,
      total_qualified              integer   NOT NULL DEFAULT 0,
      total_qualified_with_caveats integer   NOT NULL DEFAULT 0,
      scan_time                    text      NOT NULL DEFAULT '',
      data_as_of                   text      NOT NULL DEFAULT '',
      data_freshness               jsonb     NOT NULL DEFAULT '{}',
      status                       text      NOT NULL DEFAULT 'idle',
      run_id                       text,
      updated_at                   timestamptz DEFAULT now()
    )
  `,
  // Idempotent column additions for tables created before these columns existed.
  `
    ALTER TABLE scanner_results ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'idle'
  `,
  // run_id — per-claim ownership token so a reclaimed lease cannot be overwritten
  // by the original worker. NULL for rows created before this column was added.
  `
    ALTER TABLE scanner_results ADD COLUMN IF NOT EXISTS run_id text
  `,
];

/**
 * Core runner — serialises via advisory lock, then applies each statement
 * idempotently. Accepts any queryable client so tests can drive it with a
 * stub. Safe to call any number of times, concurrently or not.
 */
export async function applyStartupMigrations(
  client: QueryableClient,
): Promise<void> {
  await client.query(`SELECT pg_advisory_lock(${MIGRATION_ADVISORY_LOCK_KEY})`);
  try {
    for (const sql of STARTUP_MIGRATION_STATEMENTS) {
      await runIdempotentStatement(client, sql);
    }
  } finally {
    // Always release, even when a statement failed fatally.
    await client
      .query(`SELECT pg_advisory_unlock(${MIGRATION_ADVISORY_LOCK_KEY})`)
      .catch(() => {});
  }
}

export async function runStartupMigrations(): Promise<void> {
  const client = await pool.connect();
  try {
    await applyStartupMigrations(client);
    logger.info("Startup migrations complete");
  } finally {
    client.release();
  }
}
