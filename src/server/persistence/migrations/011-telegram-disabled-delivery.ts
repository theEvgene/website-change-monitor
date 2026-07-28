export const telegramDisabledDeliveryMigration = {
  version: 11,
  name: "011-telegram-disabled-delivery",
  sql: `
    CREATE TABLE notification_deliveries_next AS SELECT * FROM notification_deliveries;
    DROP TABLE notification_deliveries;

    CREATE TABLE notification_deliveries (
      id INTEGER PRIMARY KEY,
      event_id INTEGER NOT NULL REFERENCES notification_events(id) ON DELETE CASCADE,
      channel TEXT NOT NULL CHECK (channel = 'telegram'),
      boot_id TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('pending','sending','delivered','unavailable','permanent','temporary','timeout','abandoned','disabled')),
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
