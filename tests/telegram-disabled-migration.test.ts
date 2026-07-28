import BetterSqlite3 from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { telegramDisabledDeliveryMigration } from "../src/server/persistence/migrations/011-telegram-disabled-delivery.js";

describe("disabled Telegram delivery migration", () => {
  it("preserves existing deliveries and admits the neutral disabled outcome", () => {
    const database = new BetterSqlite3(":memory:");
    try {
      database.exec(`
        CREATE TABLE notification_events (id INTEGER PRIMARY KEY) STRICT;
        INSERT INTO notification_events VALUES (1);
        CREATE TABLE notification_deliveries (
          id INTEGER PRIMARY KEY,
          event_id INTEGER NOT NULL REFERENCES notification_events(id) ON DELETE CASCADE,
          channel TEXT NOT NULL CHECK (channel = 'telegram'),
          boot_id TEXT NOT NULL,
          state TEXT NOT NULL CHECK (state IN ('pending','sending','delivered','unavailable','permanent','temporary','timeout','abandoned')),
          failure_reason TEXT,
          diagnostic TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE(event_id, channel)
        ) STRICT;
        CREATE INDEX notification_deliveries_dispatch ON notification_deliveries(boot_id, state, id);
        INSERT INTO notification_deliveries VALUES
          (7, 1, 'telegram', 'old-boot', 'delivered', NULL, 'ok', '2026-07-18T08:00:00.000Z', '2026-07-18T08:00:01.000Z');
      `);

      database.exec(telegramDisabledDeliveryMigration.sql);

      expect(database.prepare("SELECT * FROM notification_deliveries WHERE id = 7").get()).toEqual({
        id: 7,
        event_id: 1,
        channel: "telegram",
        boot_id: "old-boot",
        state: "delivered",
        failure_reason: null,
        diagnostic: "ok",
        created_at: "2026-07-18T08:00:00.000Z",
        updated_at: "2026-07-18T08:00:01.000Z",
      });
      database.prepare(`
        INSERT INTO notification_events VALUES (2);
      `).run();
      expect(() => database.prepare(`
        INSERT INTO notification_deliveries VALUES
          (8, 2, 'telegram', 'new-boot', 'disabled', NULL, NULL, '2026-07-18T09:00:00.000Z', '2026-07-18T09:00:00.000Z')
      `).run()).not.toThrow();
      expect(() => database.prepare(`
        UPDATE notification_deliveries SET state = 'unknown' WHERE id = 8
      `).run()).toThrow();
    } finally {
      database.close();
    }
  });
});
