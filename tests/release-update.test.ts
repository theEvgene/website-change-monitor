import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { NdjsonLogger } from "../src/server/operations/logger.js";
import { rollbackRelease, updateRelease, type CommandResult, type CommandRunner } from "../src/server/operations/release.js";
import { applicationPaths } from "../src/server/operations/paths.js";
import { openApplicationDatabase } from "../src/server/persistence/database.js";

describe("source release update", () => {
  it("verifies a tag before migration and records a paired rollback", async () => {
    const root = await fixtureRoot();
    const runner = new FakeRunner();
    try {
      const result = await updateRelease(options(root, runner), "v0.2.0");
      expect(result).toMatchObject({ previousCommit: "old-commit", targetCommit: "new-commit" });
      expect(runner.commands).toEqual([
        "git status --porcelain",
        "git rev-parse HEAD",
        "git rev-parse --verify refs/tags/v0.2.0^{commit}",
        "git checkout --detach new-commit",
        "git rev-parse HEAD",
        "npm.cmd ci",
        "npm.cmd run install:chromium",
        "npm.cmd run build",
        "npm.cmd test",
        `${process.execPath} dist/server/cli.js doctor`,
        `${process.execPath} dist/server/cli.js migrate`,
        `${process.execPath} dist/server/cli.js doctor`,
      ]);
      expect(existsSync(join(applicationPaths(root).data, "release-rollback.json"))).toBe(true);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("restores the previous checkout when verification fails before migration", async () => {
    const root = await fixtureRoot();
    const runner = new FakeRunner({ doctorExitCode: 1 });
    try {
      await expect(updateRelease(options(root, runner), "v0.2.0")).rejects.toThrow("восстановлена прежняя версия");
      expect(runner.commands).not.toContain(`${process.execPath} dist/server/cli.js migrate`);
      expect(runner.commands).toContain("git checkout --detach old-commit");
      expect(existsSync(join(applicationPaths(root).data, "release-rollback.json"))).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("rejects a dirty checkout before creating backups", async () => {
    const root = await fixtureRoot();
    const runner = new FakeRunner({ dirty: true });
    try {
      await expect(updateRelease(options(root, runner), "v0.2.0")).rejects.toThrow("чистого Git checkout");
      expect(existsSync(applicationPaths(root).backups)).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("rolls code and database back as one operation", async () => {
    const root = await fixtureRoot();
    const runner = new FakeRunner();
    try {
      const updated = await updateRelease(options(root, runner), "v0.2.0");
      const database = openApplicationDatabase({ rootDirectory: root });
      database.configureTelegramExecutable("C:\\changed.exe");
      database.close();
      const rolledBack = await rollbackRelease(options(root, runner));
      expect(rolledBack.preUpdateBackup).toBe(updated.preUpdateBackup);
      const restored = openApplicationDatabase({ rootDirectory: root });
      expect(restored.telegramExecutablePath()).toBeNull();
      restored.close();
      expect(existsSync(join(applicationPaths(root).data, "release-rollback.json"))).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("restores the target pair when rollback verification fails", async () => {
    const root = await fixtureRoot();
    const runner = new FakeRunner({ failRollbackBuild: true });
    try {
      await updateRelease(options(root, runner), "v0.2.0");
      const database = openApplicationDatabase({ rootDirectory: root });
      database.configureTelegramExecutable("C:\\new-version.exe");
      database.close();
      await expect(rollbackRelease(options(root, runner))).rejects.toThrow("восстановлена новая версия");
      const current = openApplicationDatabase({ rootDirectory: root });
      expect(current.telegramExecutablePath()).toBe("C:\\new-version.exe");
      current.close();
      expect(runner.commands.at(-5)).toBe("git checkout --detach new-commit");
      expect(existsSync(join(applicationPaths(root).data, "release-rollback.json"))).toBe(true);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("verifies HEAD after checking out the resolved tag commit", async () => {
    const root = await fixtureRoot();
    const runner = new FakeRunner({ checkoutMismatch: true });
    try {
      await expect(updateRelease(options(root, runner), "v0.2.0")).rejects.toThrow("восстановлена прежняя версия");
      expect(runner.commands).toContain("git checkout --detach new-commit");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

class FakeRunner implements CommandRunner {
  readonly commands: string[] = [];
  private currentCommit = "old-commit";
  private rollbackBuildFailed = false;
  constructor(private readonly behavior: { dirty?: boolean; doctorExitCode?: number; failRollbackBuild?: boolean; checkoutMismatch?: boolean } = {}) {}
  async run(command: string, args: string[]): Promise<CommandResult> {
    const rendered = `${command} ${args.join(" ")}`;
    this.commands.push(rendered);
    if (rendered === "git status --porcelain") return result(0, this.behavior.dirty ? " M file.ts" : "");
    if (rendered === "git rev-parse HEAD") return result(0, `${this.currentCommit}\n`);
    if (rendered.includes("refs/tags/")) return result(0, "new-commit\n");
    if (rendered === "git checkout --detach new-commit" && !this.behavior.checkoutMismatch) this.currentCommit = "new-commit";
    if (rendered === "git checkout --detach old-commit") this.currentCommit = "old-commit";
    if (rendered === "npm.cmd ci" && this.currentCommit === "old-commit" && this.behavior.failRollbackBuild && !this.rollbackBuildFailed) {
      this.rollbackBuildFailed = true;
      return result(1, "rollback build failed");
    }
    if (rendered.endsWith("dist/server/cli.js doctor")) return result(this.behavior.doctorExitCode ?? 2, "{}");
    return result(0, "");
  }
}

function result(exitCode: number, stdout: string): CommandResult { return { exitCode, stdout, stderr: "" }; }
function options(rootDirectory: string, runner: CommandRunner) {
  const logger: NdjsonLogger = { write() {} };
  return { checkoutDirectory: process.cwd(), rootDirectory, runner, logger };
}
async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "wcm-release-"));
  const database = openApplicationDatabase({ rootDirectory: root });
  database.close();
  return root;
}
