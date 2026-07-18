import BetterSqlite3 from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { controlNotificationsMigration } from "../src/server/persistence/migrations/009-control-notifications.js";

describe("control notification migration", () => {
  it("preserves existing events and Telegram deliveries while adding the disabled setting", () => {
    const database = new BetterSqlite3(":memory:");
    try {
      database.exec(`
        CREATE TABLE monitors (id INTEGER PRIMARY KEY) STRICT;
        CREATE TABLE checks (id INTEGER PRIMARY KEY) STRICT;
        CREATE TABLE notification_events (
          id INTEGER PRIMARY KEY, kind TEXT NOT NULL, monitor_id INTEGER NOT NULL,
          monitor_name TEXT NOT NULL, scope_revision INTEGER NOT NULL, check_id INTEGER NOT NULL,
          chain_check_id INTEGER NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL,
          observed_at TEXT NOT NULL, target_path TEXT NOT NULL, dedupe_key TEXT NOT NULL UNIQUE,
          url TEXT NOT NULL
        ) STRICT;
        CREATE TABLE notification_deliveries (
          id INTEGER PRIMARY KEY, event_id INTEGER NOT NULL, channel TEXT NOT NULL,
          boot_id TEXT NOT NULL, state TEXT NOT NULL, failure_reason TEXT, diagnostic TEXT,
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(event_id, channel)
        ) STRICT;
        INSERT INTO monitors VALUES (1); INSERT INTO checks VALUES (2);
        INSERT INTO notification_events VALUES (3, 'change_detected', 1, 'Catalog', 1, 2, 2, 'Changed', 'Body', '2026-07-18T08:00:00.000Z', '/?check=2', 'change:2', 'https://example.com');
        INSERT INTO notification_deliveries VALUES (4, 3, 'telegram', 'old', 'delivered', NULL, NULL, '2026-07-18T08:00:00.000Z', '2026-07-18T08:00:01.000Z');
      `);
      database.exec(controlNotificationsMigration.sql);
      expect(database.prepare("SELECT kind, center_visible FROM notification_events").get()).toEqual({ kind: "change_detected", center_visible: 1 });
      expect(database.prepare("SELECT event_id, state FROM notification_deliveries").get()).toEqual({ event_id: 3, state: "delivered" });
      expect(database.prepare("SELECT notify_when_unchanged FROM application_settings").get()).toEqual({ notify_when_unchanged: 0 });
    } finally { database.close(); }
  });
});
