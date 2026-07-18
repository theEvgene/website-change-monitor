import { spawn } from "node:child_process";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { NdjsonLogger } from "./logger.js";
import { applicationPaths } from "./paths.js";
import { createAutomaticBackup, restoreManualBackup } from "../persistence/maintenance.js";

export interface CommandResult { exitCode: number; stdout: string; stderr: string }
export interface CommandRunner { run(command: string, args: string[]): Promise<CommandResult> }
export interface ReleaseOptions {
  checkoutDirectory: string;
  rootDirectory: string;
  runner: CommandRunner;
  logger: NdjsonLogger;
}
export interface UpdateResult { previousCommit: string; targetCommit: string; preUpdateBackup: string; preMigrationBackup: string }
interface RollbackState { previousCommit: string; targetCommit: string; preUpdateBackup: string }

export async function updateRelease(options: ReleaseOptions, tag: string): Promise<UpdateResult> {
  assertSafeTag(tag);
  await requireCleanCheckout(options);
  const previousCommit = await gitValue(options, ["rev-parse", "HEAD"]);
  const targetCommit = await gitValue(options, ["rev-parse", "--verify", `refs/tags/${tag}^{commit}`]);
  const activeRollback = tryReadRollbackState(options.rootDirectory);
  const preUpdateBackup = await createAutomaticBackup(
    options.rootDirectory,
    "pre-update",
    activeRollback === undefined ? [] : [activeRollback.preUpdateBackup],
  );
  options.logger.write("update_started", { tag, previousCommit, targetCommit, preUpdateBackup });
  let migrationStarted = false;
  try {
    await requireCommand(options, "git", ["checkout", "--detach", targetCommit]);
    const checkedOutCommit = await gitValue(options, ["rev-parse", "HEAD"]);
    if (checkedOutCommit !== targetCommit) throw new Error("Git checkout не соответствует commit выбранного tag.");
    await installAndVerify(options);
    const preMigrationBackup = await createAutomaticBackup(options.rootDirectory, "pre-migration");
    migrationStarted = true;
    await requireCommand(options, process.execPath, ["dist/server/cli.js", "migrate"]);
    await requireDoctor(options);
    writeRollbackState(options.rootDirectory, { previousCommit, targetCommit, preUpdateBackup });
    options.logger.write("update_succeeded", { tag, previousCommit, targetCommit, preUpdateBackup, preMigrationBackup });
    return { previousCommit, targetCommit, preUpdateBackup, preMigrationBackup };
  } catch (error) {
    options.logger.write("update_failed", { tag, stage: migrationStarted ? "migration" : "verification", error });
    await recoverPreviousRelease(options, previousCommit, migrationStarted ? preUpdateBackup : undefined);
    throw new Error(`Обновление не применено; восстановлена прежняя версия. ${safeMessage(error)}`);
  }
}

export async function rollbackRelease(options: ReleaseOptions): Promise<RollbackState> {
  await requireCleanCheckout(options);
  const state = readRollbackState(options.rootDirectory);
  const current = await gitValue(options, ["rev-parse", "HEAD"]);
  if (current !== state.targetCommit) throw new Error("Rollback запрещён: checkout не соответствует последнему обновлению.");
  const currentDatabaseBackup = await createAutomaticBackup(options.rootDirectory, "pre-migration");
  options.logger.write("rollback_started", { ...state });
  let databaseRestored = false;
  try {
    await requireCommand(options, "git", ["checkout", "--detach", state.previousCommit]);
    await installAndBuild(options);
    restoreManualBackup(options.rootDirectory, state.preUpdateBackup);
    databaseRestored = true;
    await requireCommand(options, "npm.cmd", ["test"]);
    await requireDoctor(options);
    rmSync(rollbackStatePath(options.rootDirectory), { force: true });
    options.logger.write("rollback_succeeded", { ...state });
    return state;
  } catch (error) {
    options.logger.write("rollback_failed", { ...state, error });
    try {
      await requireCommand(options, "git", ["checkout", "--detach", state.targetCommit]);
      await installAndBuild(options);
      if (databaseRestored) restoreManualBackup(options.rootDirectory, currentDatabaseBackup);
      await requireDoctor(options);
      options.logger.write("rollback_recovery_succeeded", { targetCommit: state.targetCommit, currentDatabaseBackup });
    } catch (recoveryError) {
      options.logger.write("rollback_recovery_failed", { targetCommit: state.targetCommit, currentDatabaseBackup, error: recoveryError });
      throw new Error(`Rollback и автоматическое восстановление не удались. Новая база сохранена в ${currentDatabaseBackup}. ${safeMessage(recoveryError)}`);
    }
    throw new Error(`Rollback не применён; восстановлена новая версия. ${safeMessage(error)}`);
  }
}

export function createCommandRunner(checkoutDirectory: string, logger: NdjsonLogger): CommandRunner {
  return {
    run(command, args) {
      logger.write("release_command_started", { command, args });
      return new Promise((resolve, reject) => {
        const child = spawn(command, args, { cwd: checkoutDirectory, env: process.env, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => { stdout += chunk; });
        child.stderr.on("data", (chunk: string) => { stderr += chunk; });
        child.once("error", reject);
        child.once("exit", (code) => {
          const result = { exitCode: code ?? 1, stdout, stderr };
          logger.write("release_command_finished", { command, args, exitCode: result.exitCode, stdout, stderr });
          resolve(result);
        });
      });
    },
  };
}

async function installAndVerify(options: ReleaseOptions): Promise<void> {
  await installAndBuild(options);
  await requireCommand(options, "npm.cmd", ["test"]);
  await requireDoctor(options);
}

async function installAndBuild(options: ReleaseOptions): Promise<void> {
  await requireCommand(options, "npm.cmd", ["ci"]);
  await requireCommand(options, "npm.cmd", ["run", "install:chromium"]);
  await requireCommand(options, "npm.cmd", ["run", "build"]);
}

async function recoverPreviousRelease(options: ReleaseOptions, previousCommit: string, databaseBackup?: string): Promise<void> {
  try {
    await requireCommand(options, "git", ["checkout", "--detach", previousCommit]);
    await installAndBuild(options);
    if (databaseBackup !== undefined) restoreManualBackup(options.rootDirectory, databaseBackup);
    options.logger.write("update_recovery_succeeded", { previousCommit, databaseBackup });
  } catch (error) {
    options.logger.write("update_recovery_failed", { previousCommit, databaseBackup, error });
    throw new Error(`Автоматическое восстановление не удалось. Используйте backup ${databaseBackup ?? "pre-update"}. ${safeMessage(error)}`);
  }
}

async function requireCleanCheckout(options: ReleaseOptions): Promise<void> {
  const status = await requireCommand(options, "git", ["status", "--porcelain"]);
  if (status.stdout.trim() !== "") throw new Error("Обновление и rollback разрешены только из чистого Git checkout.");
}

async function gitValue(options: ReleaseOptions, args: string[]): Promise<string> {
  return (await requireCommand(options, "git", args)).stdout.trim();
}

async function requireDoctor(options: ReleaseOptions): Promise<void> {
  const result = await options.runner.run(process.execPath, ["dist/server/cli.js", "doctor"]);
  if (result.exitCode !== 0 && result.exitCode !== 2) throw commandError("doctor", result);
}

async function requireCommand(options: ReleaseOptions, command: string, args: string[]): Promise<CommandResult> {
  const result = await options.runner.run(command, args);
  if (result.exitCode !== 0) throw commandError(`${command} ${args.join(" ")}`, result);
  return result;
}

function commandError(command: string, result: CommandResult): Error {
  return new Error(`${command} завершилась с кодом ${result.exitCode}: ${(result.stderr || result.stdout).trim()}`);
}

function assertSafeTag(tag: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._+/-]*$/u.test(tag) || tag.includes("..") || tag.endsWith("/") || tag.includes("//")) {
    throw new Error("Укажите точное безопасное имя Git tag.");
  }
}

function rollbackStatePath(rootDirectory: string): string { return join(applicationPaths(rootDirectory).data, "release-rollback.json"); }

function writeRollbackState(rootDirectory: string, state: RollbackState): void {
  const path = rollbackStatePath(rootDirectory);
  const staged = `${path}.tmp`;
  writeFileSync(staged, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(staged, path);
}

function readRollbackState(rootDirectory: string): RollbackState {
  const path = rollbackStatePath(rootDirectory);
  if (!existsSync(path)) throw new Error("Нет состояния последнего обновления для rollback.");
  const value = JSON.parse(readFileSync(path, "utf8")) as Partial<RollbackState>;
  if (typeof value.previousCommit !== "string" || typeof value.targetCommit !== "string" || typeof value.preUpdateBackup !== "string") {
    throw new Error("Состояние rollback повреждено.");
  }
  return value as RollbackState;
}

function tryReadRollbackState(rootDirectory: string): RollbackState | undefined {
  return existsSync(rollbackStatePath(rootDirectory)) ? readRollbackState(rootDirectory) : undefined;
}

function safeMessage(error: unknown): string { return error instanceof Error ? error.message : "Неизвестная ошибка."; }
