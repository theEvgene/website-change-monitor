import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
      });

      expect(report.status).toBe("degraded");
      expect(report.exitCode).toBe(2);
      expect(report.checks).toEqual([
        { name: "runtime", status: "ready" },
        { name: "data", status: "ready" },
        { name: "database", status: "ready", schemaVersion: null },
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
      });

      expect(report.status).toBe("ready");
      expect(report.exitCode).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
