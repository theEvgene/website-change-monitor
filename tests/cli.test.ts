import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

import BetterSqlite3 from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { openApplicationDatabase } from "../src/server/persistence/database.js";

describe("command line", () => {
  it("prints the degraded doctor report and exits with code 2", async () => {
    const localAppData = await mkdtemp(
      join(tmpdir(), "website-change-monitor-localappdata-"),
    );

    try {
      const result = await runCli("doctor", localAppData);

      expect(result.exitCode).toBe(2);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toMatchObject({
        status: "degraded",
        exitCode: 2,
        checks: [
          { name: "runtime", status: "ready" },
          { name: "data", status: "ready" },
          { name: "database", status: "ready", schemaVersion: null },
          { name: "port", status: "ready" },
          { name: "telegram", status: "degraded", code: "not_configured" },
        ],
      });
      await expect(
        access(join(localAppData, "WebsiteChangeMonitor")),
      ).rejects.toThrow();
    } finally {
      await rm(localAppData, { recursive: true, force: true });
    }
  });

  it("prints a ready doctor report and exits with code 0 when Telegram is configured", async () => {
    const localAppData = await mkdtemp(
      join(tmpdir(), "website-change-monitor-localappdata-"),
    );
    const root = join(localAppData, "WebsiteChangeMonitor");
    await mkdir(root);
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
      const result = await runCli("doctor", localAppData);

      expect(result.exitCode).toBe(0);
      const report = JSON.parse(result.stdout) as {
        status: string;
        exitCode: number;
        checks: unknown[];
      };
      expect(report).toMatchObject({ status: "ready", exitCode: 0 });
      expect(report.checks).toContainEqual({
        name: "telegram",
        status: "ready",
      });
    } finally {
      await rm(localAppData, { recursive: true, force: true });
    }
  });

  it("refuses to start under Node 20 before creating application data", async () => {
    const localAppData = await mkdtemp(
      join(tmpdir(), "website-change-monitor-localappdata-"),
    );

    try {
      const result = await runCli(
        "start",
        localAppData,
        "C:\\Program Files\\nodejs\\node.exe",
      );

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("node_24_required");
      await expect(
        access(join(localAppData, "WebsiteChangeMonitor")),
      ).rejects.toThrow();
    } finally {
      await rm(localAppData, { recursive: true, force: true });
    }
  });
});

async function runCli(
  command: string,
  localAppData: string,
  nodeExecutable = process.execPath,
) {
  const child = spawn(
    nodeExecutable,
    ["node_modules/tsx/dist/cli.mjs", "src/server/cli.ts", command],
    {
      cwd: process.cwd(),
      env: { ...process.env, LOCALAPPDATA: localAppData },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });

  return { exitCode, stdout, stderr };
}
