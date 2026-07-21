export const checkUrlMigration = {
  version: 10,
  name: "010-check-url",
  sql: `
    ALTER TABLE checks ADD COLUMN url TEXT NOT NULL DEFAULT '';
    UPDATE checks
    SET url = (SELECT monitors.url FROM monitors WHERE monitors.id = checks.monitor_id);
  `,
} as const;
