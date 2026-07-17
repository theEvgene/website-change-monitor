export const manualChecksMigration = {
  version: 3,
  name: "003-manual-checks",
  sql: `
    ALTER TABLE monitors
      ADD COLUMN current_snapshot_id INTEGER REFERENCES snapshots(id) ON DELETE SET NULL;

    ALTER TABLE checks
      ADD COLUMN before_snapshot_id INTEGER REFERENCES snapshots(id);

    ALTER TABLE checks
      ADD COLUMN after_snapshot_id INTEGER REFERENCES snapshots(id);

    CREATE UNIQUE INDEX check_intents_one_active_per_monitor
      ON check_intents(monitor_id)
      WHERE state IN ('queued', 'running');
  `,
} as const;
