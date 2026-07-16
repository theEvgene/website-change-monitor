import { readFileSync } from "node:fs";
import { release } from "node:os";
import { resolve } from "node:path";

import { openInDefaultBrowser } from "./operations/browser.js";
import { runDoctor } from "./operations/doctor.js";
import { applicationRoot } from "./operations/paths.js";
import { startApplication } from "./operations/start.js";

const port = 43117;

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command === "doctor") {
    const report = await runDoctor({
      rootDirectory: applicationRoot(process.env),
      port,
      runtime: currentRuntime(),
    });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = report.exitCode;
    return;
  }

  if (command === "start") {
    const rootDirectory = applicationRoot(process.env);
    const preflight = await runDoctor({
      rootDirectory,
      port,
      runtime: currentRuntime(),
    });
    if (preflight.status === "fatal") {
      process.stderr.write(`${JSON.stringify(preflight, null, 2)}\n`);
      process.exitCode = preflight.exitCode;
      return;
    }

    const outcome = await startApplication({
      rootDirectory,
      staticRoot: resolve(process.cwd(), "dist", "client"),
      port,
      version: applicationVersion(),
      openBrowser: openInDefaultBrowser,
    });

    if (outcome.kind === "existing") {
      process.stdout.write("Website Change Monitor уже работает; интерфейс открыт.\n");
      return;
    }

    process.stdout.write(`Website Change Monitor: http://127.0.0.1:${port}/\n`);
    let closing = false;
    const close = () => {
      if (closing) {
        return;
      }
      closing = true;
      void outcome.close().then(
        () => {
          process.stdout.write("Website Change Monitor остановлен.\n");
        },
        (error: unknown) => {
          process.stderr.write(`${safeErrorMessage(error)}\n`);
          process.exitCode = 1;
        },
      );
    };
    process.once("SIGINT", close);
    process.once("SIGTERM", close);
    return;
  }

  process.stderr.write("Использование: website-change-monitor <start|doctor>\n");
  process.exitCode = 1;
}

function currentRuntime() {
  return {
    nodeVersion: process.versions.node,
    platform: process.platform,
    architecture: process.arch,
    windowsRelease: release(),
  };
}

function applicationVersion(): string {
  const packagePath = resolve(process.cwd(), "package.json");
  const packageJson = JSON.parse(readFileSync(packagePath, "utf8")) as {
    version?: unknown;
  };
  if (typeof packageJson.version !== "string") {
    throw new Error("Версия приложения отсутствует в package.json.");
  }
  return packageJson.version;
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Неизвестная ошибка приложения.";
}

void main().catch((error: unknown) => {
  process.stderr.write(`${safeErrorMessage(error)}\n`);
  process.exitCode = 1;
});
