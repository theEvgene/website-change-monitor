export const monitorManagementMigration = {
  version: 6,
  name: "006-monitor-management",
  sql: `
    CREATE TABLE labels (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      normalized_name TEXT NOT NULL UNIQUE
    ) STRICT;

    CREATE TABLE monitor_labels (
      monitor_id INTEGER NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
      label_id INTEGER NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
      PRIMARY KEY (monitor_id, label_id)
    ) STRICT;

    CREATE INDEX monitor_labels_by_label ON monitor_labels(label_id, monitor_id);
  `,
} as const;
