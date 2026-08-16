import { pgTable, text, integer, timestamp, jsonb } from "drizzle-orm/pg-core";

export const scannerResultsTable = pgTable("scanner_results", {
  id: integer("id").primaryKey().default(1),
  stocks: jsonb("stocks").notNull(),
  totalScanned: integer("total_scanned").notNull(),
  totalQualified: integer("total_qualified").notNull(),
  totalQualifiedWithCaveats: integer("total_qualified_with_caveats").notNull(),
  scanTime: text("scan_time").notNull(),
  dataAsOf: text("data_as_of").notNull(),
  dataFreshness: jsonb("data_freshness").notNull(),
  /** Persisted so all autoscale instances agree on scan lifecycle. */
  status: text("status").notNull().default("idle"),
  /**
   * Per-claim ownership token for the scan lease: each scan run writes a
   * fresh UUID here, and completion/error writes are conditioned on it so a
   * reclaimed lease cannot be overwritten by a stale run.
   * Also created idempotently by startup-migrations for existing databases.
   */
  runId: text("run_id"),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export type ScannerResult = typeof scannerResultsTable.$inferSelect;
export type InsertScannerResult = typeof scannerResultsTable.$inferInsert;
