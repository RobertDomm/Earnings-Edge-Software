import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  applyStartupMigrations,
  isBenignDuplicateError,
  STARTUP_MIGRATION_STATEMENTS,
  type QueryableClient,
} from "../startup-migrations.js";

function pgError(code: string, message = "boom"): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

describe("startup migrations idempotency", () => {
  it("classifies duplicate-object codes as benign, everything else as fatal", () => {
    for (const code of ["42P07", "42710", "42701", "23505"]) {
      assert.equal(isBenignDuplicateError(pgError(code)), true, code);
    }
    assert.equal(isBenignDuplicateError(pgError("42601")), false, "syntax error is fatal");
    assert.equal(isBenignDuplicateError(pgError("28P01")), false, "auth error is fatal");
    assert.equal(isBenignDuplicateError(new Error("no code")), false);
    assert.equal(isBenignDuplicateError(null), false);
  });

  it("running the full migration twice never throws, even when the DB reports duplicates on the second run", async () => {
    const executed: string[] = [];
    const created = new Set<string>();
    const client: QueryableClient = {
      async query(sql: string) {
        executed.push(sql);
        if (sql.includes("pg_advisory_")) return;
        // Simulate a DB where IF NOT EXISTS races: statements that already
        // ran once throw 42P07 the second time instead of no-oping.
        if (created.has(sql)) throw pgError("42P07", "relation already exists");
        created.add(sql);
      },
    };
    await applyStartupMigrations(client); // first boot: creates everything
    await applyStartupMigrations(client); // second boot: every stmt duplicates
    const ddlRuns = executed.filter((s) => !s.includes("pg_advisory_")).length;
    assert.equal(ddlRuns, STARTUP_MIGRATION_STATEMENTS.length * 2, "all statements attempted on both runs");
  });

  it("acquires and releases the advisory lock around the statements (release even on fatal error)", async () => {
    const calls: string[] = [];
    const okClient: QueryableClient = { async query(sql) { calls.push(sql); } };
    await applyStartupMigrations(okClient);
    assert.ok(calls[0]!.includes("pg_advisory_lock"), "lock acquired first");
    assert.ok(calls[calls.length - 1]!.includes("pg_advisory_unlock"), "lock released last");

    const fatalCalls: string[] = [];
    const fatalClient: QueryableClient = {
      async query(sql: string) {
        fatalCalls.push(sql);
        if (!sql.includes("pg_advisory_") && sql.includes("scanner_results")) {
          throw pgError("42601", "syntax error");
        }
      },
    };
    await assert.rejects(() => applyStartupMigrations(fatalClient), /syntax error/);
    assert.ok(
      fatalCalls[fatalCalls.length - 1]!.includes("pg_advisory_unlock"),
      "lock must still be released after a fatal error",
    );
  });

  it("fatal (non-duplicate) errors propagate", async () => {
    const client: QueryableClient = {
      async query(sql: string) {
        if (sql.includes("pg_advisory_")) return;
        throw pgError("28P01", "password authentication failed");
      },
    };
    await assert.rejects(() => applyStartupMigrations(client), /password authentication failed/);
  });
});
