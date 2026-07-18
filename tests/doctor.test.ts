import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import BetterSqlite3 from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { runDoctor } from "../src/server/operations/doctor.js";
import { openApplicationDatabase } from "../src/server/persistence/database.js";

describe("doctor", () => {
  it("reports a working core with unavailable Telegram as degraded", async () => {
    const root = await mkdtemp(join(tmpdir(), "website-change-monitor-"));

    try {
      const report = await runDoctor({
        rootDirectory: root,
        port: 0,
        runtime: {
          nodeVersion: "24.14.0",
          platform: "win32",
          architecture: "x64",
          windowsRelease: "10.0.26200",
        },
        browserExecutablePath: process.execPath,
      });

      expect(report.status).toBe("degraded");
      expect(report.exitCode).toBe(2);
      expect(report.checks).toEqual([
        { name: "runtime", status: "ready" },
        { name: "data", status: "ready" },
        { name: "database", status: "ready", schemaVersion: null },
        { name: "migrations", status: "ready" },
        { name: "chromium", status: "ready" },
        { name: "port", status: "ready" },
        {
          name: "telegram",
          status: "degraded",
          code: "not_configured",
        },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports an unsupported Node runtime as fatal", async () => {
    const root = await mkdtemp(join(tmpdir(), "website-change-monitor-"));

    try {
      const report = await runDoctor({
        rootDirectory: root,
        port: 0,
        runtime: {
          nodeVersion: "20.11.1",
          platform: "win32",
          architecture: "x64",
          windowsRelease: "10.0.26200",
        },
        browserExecutablePath: process.execPath,
      });

      expect(report.status).toBe("fatal");
      expect(report.exitCode).toBe(1);
      expect(report.checks[0]).toEqual({
        name: "runtime",
        status: "fatal",
        code: "node_24_required",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports a data root occupied by a file as fatal", async () => {
    const parent = await mkdtemp(join(tmpdir(), "website-change-monitor-"));
    const root = join(parent, "WebsiteChangeMonitor");
    await writeFile(root, "not a directory", "utf8");

    try {
      const report = await runDoctor({
        rootDirectory: root,
        port: 0,
        runtime: {
          nodeVersion: "24.14.0",
          platform: "win32",
          architecture: "x64",
          windowsRelease: "10.0.26200",
        },
        browserExecutablePath: process.execPath,
      });

      expect(report.status).toBe("fatal");
      expect(report.exitCode).toBe(1);
      expect(report.checks).toContainEqual({
        name: "data",
        status: "fatal",
        code: "root_not_directory",
      });
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it("reports ready when every required and optional check is available", async () => {
    const root = await mkdtemp(join(tmpdir(), "website-change-monitor-"));
    const executable = join(root, "telegram-alert.exe");
    await writeFile(executable, "fixture", "utf8");
    const applicationDatabase = openApplicationDatabase({ rootDirectory: root });
    applicationDatabase.close();
    const sqlite = new BetterSqlite3(
      join(root, "data", "website-change-monitor.sqlite3"),
    );
    sqlite
      .prepare(
        "INSERT INTO application_metadata (key, value) VALUES ('telegram_executable_path', ?)",
      )
      .run(executable);
    sqlite.close();

    try {
      const report = await runDoctor({
        rootDirectory: root,
        port: 0,
        runtime: {
          nodeVersion: "24.14.0",
          platform: "win32",
          architecture: "x64",
          windowsRelease: "10.0.26200",
        },
        browserExecutablePath: process.execPath,
        inspectTelegram: async () => true,
      });

      expect(report.status).toBe("ready");
      expect(report.exitCode).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("allows an intact older schema to proceed to forward migrations", async () => {
    const root = await mkdtemp(join(tmpdir(), "website-change-monitor-old-schema-"));
    await mkdir(join(root, "data"), { recursive: true });
    const sqlite = new BetterSqlite3(join(root, "data", "website-change-monitor.sqlite3"));
    sqlite.exec(`
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, applied_at TEXT NOT NULL) STRICT;
      CREATE TABLE application_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
      INSERT INTO schema_migrations VALUES (1, '001-initial', '2026-01-01T00:00:00.000Z');
    `);
    sqlite.close();
    try {
      const report = await runDoctor({
        rootDirectory: root,
        port: 0,
        runtime: { nodeVersion: "24.14.0", platform: "win32", architecture: "x64", windowsRelease: "10.0.26200" },
        browserExecutablePath: process.execPath,
      });
      expect(report.checks).toContainEqual({ name: "migrations", status: "ready" });
      expect(report.status).toBe("degraded");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
