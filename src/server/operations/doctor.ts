import { constants, existsSync } from "node:fs";
import { access, stat } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname } from "node:path";

import { inspectTelegramExecutable } from "../notifications/telegram-dispatcher.js";
import { inspectApplicationDatabase } from "../persistence/database.js";
import { latestSchemaVersion } from "../persistence/schema-version.js";
import { isWebsiteChangeMonitorAtPort } from "./instance.js";
import { applicationPaths } from "./paths.js";

export interface RuntimeFacts {
  nodeVersion: string;
  platform: string;
  architecture: string;
  windowsRelease: string;
}

type ReadyCheck = {
  name: "runtime" | "data" | "port" | "chromium" | "migrations";
  status: "ready";
};

type DatabaseCheck = {
  name: "database";
  status: "ready";
  schemaVersion: number | null;
};

type TelegramCheck =
  | { name: "telegram"; status: "ready" }
  | {
      name: "telegram";
      status: "degraded";
      code: "not_configured" | "unavailable";
    };

type FatalCheck = {
  name: "runtime" | "data" | "database" | "port" | "chromium" | "migrations";
  status: "fatal";
  code: string;
};

export type DoctorCheck =
  | ReadyCheck
  | DatabaseCheck
  | TelegramCheck
  | FatalCheck;

export interface DoctorReport {
  status: "ready" | "degraded" | "fatal";
  exitCode: 0 | 1 | 2;
  checks: DoctorCheck[];
}

export interface RunDoctorOptions {
  rootDirectory: string;
  port: number;
  runtime: RuntimeFacts;
  inspectTelegram?: (executablePath: string | null) => Promise<boolean>;
  browserExecutablePath?: string;
}

export async function runDoctor(
  options: RunDoctorOptions,
): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];

  const runtimeError = validateRuntime(options.runtime);
  checks.push(
    runtimeError === undefined
      ? { name: "runtime", status: "ready" }
      : { name: "runtime", status: "fatal", code: runtimeError },
  );

  checks.push(await checkDataRoot(options.rootDirectory));

  let telegramExecutablePath: string | null = null;
  try {
    const database = inspectApplicationDatabase({
      rootDirectory: options.rootDirectory,
    });
    telegramExecutablePath = database.telegramExecutablePath;
    checks.push({
      name: "database",
      status: "ready",
      schemaVersion: database.schemaVersion,
    });
    checks.push(database.schemaVersion === null || database.schemaVersion <= latestSchemaVersion
      ? { name: "migrations", status: "ready" }
      : { name: "migrations", status: "fatal", code: "schema_newer_than_application" });
  } catch {
    checks.push({ name: "database", status: "fatal", code: "database_unavailable" });
    checks.push({ name: "migrations", status: "fatal", code: "migration_state_unavailable" });
  }

  checks.push(options.browserExecutablePath !== undefined && existsSync(options.browserExecutablePath)
    ? { name: "chromium", status: "ready" }
    : { name: "chromium", status: "fatal", code: "chromium_unavailable" });
  checks.push(await checkPort(options.port));
  const telegramConfigured = telegramExecutablePath !== null;
  const telegramAvailable = await (options.inspectTelegram
    ? options.inspectTelegram(telegramExecutablePath)
    : inspectTelegramExecutable(telegramExecutablePath).then((state) => state.status === "available"));
  checks.push(telegramAvailable
    ? { name: "telegram", status: "ready" }
    : { name: "telegram", status: "degraded", code: telegramConfigured ? "unavailable" : "not_configured" });

  if (checks.some((check) => check.status === "fatal")) {
    return { status: "fatal", exitCode: 1, checks };
  }
  if (checks.some((check) => check.status === "degraded")) {
    return { status: "degraded", exitCode: 2, checks };
  }
  return { status: "ready", exitCode: 0, checks };
}

async function checkDataRoot(rootDirectory: string): Promise<DoctorCheck> {
  try {
    if (existsSync(rootDirectory)) {
      const root = await stat(rootDirectory);
      if (!root.isDirectory()) {
        return {
          name: "data",
          status: "fatal",
          code: "root_not_directory",
        };
      }
      await access(rootDirectory, constants.R_OK | constants.W_OK);
      const paths = applicationPaths(rootDirectory);
      for (const path of [paths.data, paths.backups, paths.logs, paths.browsers]) {
        if (!existsSync(path)) continue;
        const child = await stat(path);
        if (!child.isDirectory()) return { name: "data", status: "fatal", code: "application_path_not_directory" };
        await access(path, constants.R_OK | constants.W_OK);
      }
      return { name: "data", status: "ready" };
    }

    const parent = dirname(rootDirectory);
    const parentStats = await stat(parent);
    if (!parentStats.isDirectory()) {
      return {
        name: "data",
        status: "fatal",
        code: "root_parent_not_directory",
      };
    }
    await access(parent, constants.R_OK | constants.W_OK);
    return { name: "data", status: "ready" };
  } catch {
    return { name: "data", status: "fatal", code: "root_not_writable" };
  }
}

function validateRuntime(runtime: RuntimeFacts): string | undefined {
  const nodeMajor = Number(runtime.nodeVersion.split(".")[0]);
  if (nodeMajor !== 24) {
    return "node_24_required";
  }
  if (runtime.platform !== "win32" || runtime.architecture !== "x64") {
    return "windows_11_x64_required";
  }
  const build = Number(runtime.windowsRelease.split(".").at(-1));
  if (!Number.isFinite(build) || build < 22000) {
    return "windows_11_x64_required";
  }
  return undefined;
}

async function checkPort(port: number): Promise<DoctorCheck> {
  const available = await new Promise<boolean>((resolve) => {
    const probe = createServer();
    probe.unref();
    probe.once("error", () => resolve(false));
    probe.listen(port, "127.0.0.1", () => {
      probe.close(() => resolve(true));
    });
  });

  if (available) {
    return { name: "port", status: "ready" };
  }

  if (await isWebsiteChangeMonitorAtPort(port)) {
    return { name: "port", status: "ready" };
  }

  return { name: "port", status: "fatal", code: "port_in_use" };
}
