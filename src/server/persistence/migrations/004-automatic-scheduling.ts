export const automaticSchedulingMigration = {
  version: 4,
  name: "004-automatic-scheduling",
  sql: `
    DROP INDEX check_intents_one_active_per_monitor;

    CREATE UNIQUE INDEX check_intents_one_running_per_monitor
      ON check_intents(monitor_id)
      WHERE state = 'running';

    CREATE UNIQUE INDEX check_intents_one_queued_kind_per_monitor
      ON check_intents(monitor_id, kind)
      WHERE state = 'queued';
  `,
} as const;
