import BetterSqlite3 from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { checkDiagnosticsMigration } from "../src/server/persistence/migrations/012-check-diagnostics.js";

describe("Check Diagnostics migration", () => {
  it("creates one constrained diagnostic per Check with cascade deletion", () => {
    const database = new BetterSqlite3(":memory:");
    database.pragma("foreign_keys = ON");
    try {
      database.exec(`
        CREATE TABLE checks (id INTEGER PRIMARY KEY) STRICT;
        INSERT INTO checks VALUES (7);
        ${checkDiagnosticsMigration.sql}
      `);
      const insert = database.prepare(`
        INSERT INTO check_diagnostics (
          check_id, recorded_at, stage, total_ms
        ) VALUES (?, ?, ?, ?)
      `);

      insert.run(7, "2026-07-28T10:00:00.000Z", "navigation", 100);
      expect(() =>
        insert.run(7, "2026-07-28T10:01:00.000Z", "target", 200)
      ).toThrow();
      expect(() =>
        database.prepare(`
          INSERT INTO check_diagnostics (
            check_id, recorded_at, stage, total_ms,
            selector_field, selector_index
          ) VALUES (7, '2026-07-28T10:00:00.000Z', 'unknown', 100, NULL, 0)
        `).run()
      ).toThrow();

      database.prepare("DELETE FROM checks WHERE id = 7").run();
      expect(
        database.prepare("SELECT COUNT(*) count FROM check_diagnostics").get(),
      ).toEqual({ count: 0 });
    } finally {
      database.close();
    }
  });
});
