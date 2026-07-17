export const retriesAndPauseMigration = {
  version: 5,
  name: "005-retries-and-pause",
  sql: `
    ALTER TABLE monitors
      ADD COLUMN paused INTEGER NOT NULL DEFAULT 0 CHECK (paused IN (0, 1));

    ALTER TABLE checks
      ADD COLUMN is_final_error INTEGER NOT NULL DEFAULT 0
        CHECK (is_final_error IN (0, 1));

    ALTER TABLE check_intents
      ADD COLUMN retry_of_check_id INTEGER REFERENCES checks(id) ON DELETE CASCADE;

    CREATE UNIQUE INDEX check_intents_one_retry_per_check
      ON check_intents(retry_of_check_id)
      WHERE retry_of_check_id IS NOT NULL;
  `,
} as const;
