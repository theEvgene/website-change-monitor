import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import BetterSqlite3 from "better-sqlite3";

import { initialMigration } from "./migrations/001-initial.js";
import { monitorsMigration } from "./migrations/002-monitors.js";
import { manualChecksMigration } from "./migrations/003-manual-checks.js";
import { automaticSchedulingMigration } from "./migrations/004-automatic-scheduling.js";
import { retriesAndPauseMigration } from "./migrations/005-retries-and-pause.js";
import { monitorManagementMigration } from "./migrations/006-monitor-management.js";
import { createMonitorStore, type MonitorStore } from "./monitor-store.js";

export interface DatabaseDiagnostics {
  status: "ready";
  schemaVersion: number;
  journalMode: "wal";
  foreignKeys: true;
  synchronous: "full";
  busyTimeoutMs: 5000;
}

export interface ApplicationDatabase {
  readonly path: string;
  readonly monitors: MonitorStore;
  diagnostics(): DatabaseDiagnostics;
  close(): void;
}

export interface OpenApplicationDatabaseOptions {
  rootDirectory: string;
}

export interface DatabaseInspection {
  status: "ready";
  schemaVersion: number | null;
  telegramExecutablePath: string | null;
}

const migrations = [
  initialMigration,
  monitorsMigration,
  manualChecksMigration,
  automaticSchedulingMigration,
  retriesAndPauseMigration,
  monitorManagementMigration,
];

export function openApplicationDatabase(
  options: OpenApplicationDatabaseOptions,
): ApplicationDatabase {
  const dataDirectory = join(options.rootDirectory, "data");
  mkdirSync(dataDirectory, { recursive: true });

  const databasePath = join(dataDirectory, "website-change-monitor.sqlite3");
  const database = new BetterSqlite3(databasePath);

  database.pragma("journal_mode = WAL");
  database.pragma("foreign_keys = ON");
  database.pragma("synchronous = FULL");
  database.pragma("busy_timeout = 5000");

  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      applied_at TEXT NOT NULL
    ) STRICT;
  `);

  const isApplied = database.prepare(
    "SELECT 1 FROM schema_migrations WHERE version = ?",
  );
  const recordMigration = database.prepare(
    "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
  );

  for (const migration of migrations) {
    if (isApplied.get(migration.version) !== undefined) {
      continue;
    }

    database.transaction(() => {
      database.exec(migration.sql);
      recordMigration.run(
        migration.version,
        migration.name,
        new Date().toISOString(),
      );
    })();
  }

  return {
    path: databasePath,
    monitors: createMonitorStore(database),
    diagnostics() {
      const schemaVersion = database
        .prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations")
        .get() as { version: number };

      return {
        status: "ready",
        schemaVersion: schemaVersion.version,
        journalMode: database.pragma("journal_mode", { simple: true }) as "wal",
        foreignKeys: foreignKeysEnabled(
          database.pragma("foreign_keys", { simple: true }) as number,
        ),
        synchronous: synchronousName(
          database.pragma("synchronous", { simple: true }) as number,
        ),
        busyTimeoutMs: database.pragma("busy_timeout", {
          simple: true,
        }) as 5000,
      };
    },
    close() {
      database.close();
    },
  };
}

export function inspectApplicationDatabase(
  options: OpenApplicationDatabaseOptions,
): DatabaseInspection {
  const path = applicationDatabasePath(options.rootDirectory);
  if (!existsSync(path)) {
    return {
      status: "ready",
      schemaVersion: null,
      telegramExecutablePath: null,
    };
  }

  const database = new BetterSqlite3(path, {
    readonly: true,
    fileMustExist: true,
  });
  try {
    const migrationTable = database
      .prepare(
        "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'schema_migrations'",
      )
      .get();
    if (migrationTable === undefined) {
      return {
        status: "ready",
        schemaVersion: 0,
        telegramExecutablePath: null,
      };
    }
    const row = database
      .prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations")
      .get() as { version: number };
    const telegram = database
      .prepare(
        "SELECT value FROM application_metadata WHERE key = 'telegram_executable_path'",
      )
      .get() as { value: string } | undefined;
    return {
      status: "ready",
      schemaVersion: row.version,
      telegramExecutablePath: telegram?.value ?? null,
    };
  } finally {
    database.close();
  }
}

function applicationDatabasePath(rootDirectory: string): string {
  return join(rootDirectory, "data", "website-change-monitor.sqlite3");
}

function synchronousName(value: number): "full" {
  if (value !== 2) {
    throw new Error(`Unexpected SQLite synchronous mode: ${value}`);
  }
  return "full";
}

function foreignKeysEnabled(value: number): true {
  if (value !== 1) {
    throw new Error("SQLite foreign keys are disabled");
  }
  return true;
}
