export const initialMigration = {
  version: 1,
  name: "001-initial",
  sql: `
    CREATE TABLE application_metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    ) STRICT;
  `,
} as const;
