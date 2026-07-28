import BetterSqlite3 from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { telegramDisabledDeliveryMigration } from "../src/server/persistence/migrations/011-telegram-disabled-delivery.js";

describe("disabled Telegram delivery migration", () => {
  it("preserves existing deliveries and admits the neutral disabled outcome", () => {
    const database = new BetterSqlite3(":memory:");
    try {
      database.exec(`
        CREATE TABLE notification_events (id INTEGER PRIMARY KEY) STRICT;
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
      `);
      const legacyStates = ["pending", "sending", "delivered", "unavailable", "permanent", "temporary", "timeout", "abandoned"];
      const insertEvent = database.prepare("INSERT INTO notification_events VALUES (?)");
      const insertDelivery = database.prepare(`
        INSERT INTO notification_deliveries VALUES (?, ?, 'telegram', ?, ?, ?, ?, ?, ?)
      `);
      legacyStates.forEach((state, index) => {
        const id = index + 1;
        insertEvent.run(id);
        insertDelivery.run(
          100 + id,
          id,
          `boot-${id}`,
          state,
          index % 2 === 0 ? null : `reason-${id}`,
          index % 2 === 0 ? `diagnostic-${id}` : null,
          `2026-07-18T08:00:0${index}.000Z`,
          `2026-07-18T08:01:0${index}.000Z`,
        );
      });
      const before = database.prepare("SELECT * FROM notification_deliveries ORDER BY id").all();

      database.exec(telegramDisabledDeliveryMigration.sql);

      expect(database.prepare("SELECT * FROM notification_deliveries ORDER BY id").all()).toEqual(before);
      database.prepare("INSERT INTO notification_events VALUES (9)").run();
      expect(() => database.prepare(`
        INSERT INTO notification_deliveries VALUES
          (109, 9, 'telegram', 'new-boot', 'disabled', NULL, NULL, '2026-07-18T09:00:00.000Z', '2026-07-18T09:00:00.000Z')
      `).run()).not.toThrow();
      expect(() => database.prepare(`
        UPDATE notification_deliveries SET state = 'unknown' WHERE id = 109
      `).run()).toThrow();
    } finally {
      database.close();
    }
  });
});
