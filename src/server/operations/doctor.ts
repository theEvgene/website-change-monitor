import { constants, existsSync, statSync } from "node:fs";
import { access, stat } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, isAbsolute } from "node:path";

import { inspectApplicationDatabase } from "../persistence/database.js";
import { isWebsiteChangeMonitorAtPort } from "./instance.js";

export interface RuntimeFacts {
  nodeVersion: string;
  platform: string;
  architecture: string;
  windowsRelease: string;
}

type ReadyCheck = {
  name: "runtime" | "data" | "port";
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
      code: "not_configured";
    };

type FatalCheck = {
  name: "runtime" | "data" | "database" | "port";
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
  } catch {
    checks.push({ name: "database", status: "fatal", code: "database_unavailable" });
  }

  checks.push(await checkPort(options.port));
  checks.push(
    isUsableTelegramExecutable(telegramExecutablePath)
      ? { name: "telegram", status: "ready" }
      : {
          name: "telegram",
          status: "degraded",
          code: "not_configured",
        },
  );

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

function isUsableTelegramExecutable(path: string | null): boolean {
  if (path === null || !isAbsolute(path) || !existsSync(path)) {
    return false;
  }
  return statSync(path).isFile();
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
