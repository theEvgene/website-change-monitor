export const controlNotificationsMigration = {
  version: 9,
  name: "009-control-notifications",
  sql: `
    CREATE TABLE application_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      notify_when_unchanged INTEGER NOT NULL CHECK (notify_when_unchanged IN (0, 1))
    ) STRICT;
    INSERT INTO application_settings (id, notify_when_unchanged) VALUES (1, 0);

    CREATE TABLE notification_events_next (
      id INTEGER PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('change_detected', 'check_failed_final', 'control_check_ok')),
      center_visible INTEGER NOT NULL CHECK (center_visible IN (0, 1)),
      monitor_id INTEGER NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
      monitor_name TEXT NOT NULL,
      scope_revision INTEGER NOT NULL CHECK (scope_revision > 0),
      check_id INTEGER NOT NULL REFERENCES checks(id) ON DELETE CASCADE,
      chain_check_id INTEGER NOT NULL REFERENCES checks(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      observed_at TEXT NOT NULL,
      target_path TEXT NOT NULL,
      dedupe_key TEXT NOT NULL UNIQUE,
      url TEXT NOT NULL
    ) STRICT;
    INSERT INTO notification_events_next
      SELECT id, kind, 1, monitor_id, monitor_name, scope_revision, check_id,
        chain_check_id, title, body, observed_at, target_path, dedupe_key, url
      FROM notification_events;

    CREATE TABLE notification_deliveries_next AS SELECT * FROM notification_deliveries;
    DROP TABLE notification_deliveries;
    DROP TABLE notification_events;
    ALTER TABLE notification_events_next RENAME TO notification_events;
    CREATE INDEX notification_events_feed ON notification_events(id);
    CREATE INDEX notification_events_monitor ON notification_events(monitor_id, id DESC);

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
    INSERT INTO notification_deliveries SELECT * FROM notification_deliveries_next;
    DROP TABLE notification_deliveries_next;
    CREATE INDEX notification_deliveries_dispatch ON notification_deliveries(boot_id, state, id);
  `,
} as const;
