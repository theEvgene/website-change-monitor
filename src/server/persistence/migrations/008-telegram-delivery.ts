export const telegramDeliveryMigration = {
  version: 8,
  name: "008-telegram-delivery",
  sql: `
    ALTER TABLE notification_events ADD COLUMN url TEXT NOT NULL DEFAULT '';
    UPDATE notification_events
    SET url = COALESCE((SELECT url FROM monitors WHERE monitors.id = notification_events.monitor_id), '');

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

    INSERT INTO notification_deliveries (
      event_id, channel, boot_id, state, failure_reason, diagnostic, created_at, updated_at
    )
    SELECT id, 'telegram', 'migration', 'abandoned',
      'Уведомление создано до подключения Telegram.', NULL, observed_at, observed_at
    FROM notification_events;
  `,
} as const;
