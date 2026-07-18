export const notificationsMigration = {
  version: 7,
  name: "007-notifications",
  sql: `
    CREATE TABLE notification_events (
      id INTEGER PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('change_detected', 'check_failed_final')),
      monitor_id INTEGER NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
      monitor_name TEXT NOT NULL,
      scope_revision INTEGER NOT NULL CHECK (scope_revision > 0),
      check_id INTEGER NOT NULL REFERENCES checks(id) ON DELETE CASCADE,
      chain_check_id INTEGER NOT NULL REFERENCES checks(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      observed_at TEXT NOT NULL,
      target_path TEXT NOT NULL,
      dedupe_key TEXT NOT NULL UNIQUE
    ) STRICT;

    CREATE INDEX notification_events_feed ON notification_events(id);
    CREATE INDEX notification_events_monitor ON notification_events(monitor_id, id DESC);
  `,
} as const;
