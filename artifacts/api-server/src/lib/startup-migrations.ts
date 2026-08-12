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
 */

import { pool } from "@workspace/db";
import { logger } from "./logger.js";

export async function runStartupMigrations(): Promise<void> {
  const client = await pool.connect();
  try {
    // connect-pg-simple session table.
    // Provisioned here so concurrent cold starts don't race on lazy creation.
    // Note: WITH (OIDS=FALSE) was removed — OID support was dropped in PG 12.
    await client.query(`
      CREATE TABLE IF NOT EXISTS "session" (
        "sid"    varchar      NOT NULL COLLATE "default",
        "sess"   json         NOT NULL,
        "expire" timestamp(6) NOT NULL,
        CONSTRAINT "session_pkey" PRIMARY KEY ("sid") NOT DEFERRABLE INITIALLY IMMEDIATE
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "session" ("expire")
    `);

    // Scanner results — single-row store for the last scan result and status.
    await client.query(`
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
    `);
    // Idempotent column additions for tables created before these columns existed.
    await client.query(`
      ALTER TABLE scanner_results ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'idle'
    `);
    // run_id — per-claim ownership token so a reclaimed lease cannot be overwritten
    // by the original worker. NULL for rows created before this column was added.
    await client.query(`
      ALTER TABLE scanner_results ADD COLUMN IF NOT EXISTS run_id text
    `);

    logger.info("Startup migrations complete");
  } finally {
    client.release();
  }
}
