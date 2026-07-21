import BetterSqlite3 from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { checkUrlMigration } from "../src/server/persistence/migrations/010-check-url.js";

describe("check URL migration", () => {
  it("backfills existing checks from their monitor URL", () => {
    const database = new BetterSqlite3(":memory:");
    try {
      database.exec(`
        CREATE TABLE monitors (id INTEGER PRIMARY KEY, url TEXT NOT NULL) STRICT;
        CREATE TABLE checks (id INTEGER PRIMARY KEY, monitor_id INTEGER NOT NULL) STRICT;
        INSERT INTO monitors VALUES (1, 'https://example.com/catalog');
        INSERT INTO checks VALUES (2, 1);
      `);
      database.exec(checkUrlMigration.sql);
      expect(database.prepare("SELECT url FROM checks WHERE id = 2").get()).toEqual({
        url: "https://example.com/catalog",
      });
    } finally {
      database.close();
    }
  });
});
