import BetterSqlite3 from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { telegramDeliveryMigration } from "../src/server/persistence/migrations/008-telegram-delivery.js";

describe("Telegram delivery migration", () => {
  it("keeps existing notifications visible without retroactively sending them", () => {
    const database = new BetterSqlite3(":memory:");
    try {
      database.exec(`
        CREATE TABLE monitors (id INTEGER PRIMARY KEY, url TEXT NOT NULL) STRICT;
        CREATE TABLE notification_events (
          id INTEGER PRIMARY KEY,
          kind TEXT NOT NULL,
          monitor_id INTEGER NOT NULL REFERENCES monitors(id),
          monitor_name TEXT NOT NULL,
          scope_revision INTEGER NOT NULL,
          check_id INTEGER NOT NULL,
          chain_check_id INTEGER NOT NULL,
          title TEXT NOT NULL,
          body TEXT NOT NULL,
          observed_at TEXT NOT NULL,
          target_path TEXT NOT NULL,
          dedupe_key TEXT NOT NULL
        ) STRICT;
        INSERT INTO monitors (id, url) VALUES (1, 'https://example.com/catalog');
        INSERT INTO notification_events VALUES (
          7, 'change_detected', 1, 'Catalog', 1, 4, 4,
          'Changed', 'Body', '2026-07-18T08:00:00.000Z', '/?check=4', 'change:4'
        );
      `);

      database.exec(telegramDeliveryMigration.sql);

      expect(database.prepare("SELECT url FROM notification_events WHERE id = 7").get()).toEqual({
        url: "https://example.com/catalog",
      });
      expect(database.prepare("SELECT event_id, state FROM notification_deliveries WHERE event_id = 7").get()).toEqual({
        event_id: 7,
        state: "abandoned",
      });
    } finally {
      database.close();
    }
  });
});
