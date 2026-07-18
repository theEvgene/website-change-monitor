import { existsSync, readFileSync, statSync } from "node:fs";
import { release } from "node:os";
import { isAbsolute, resolve } from "node:path";

import { inspectTelegramExecutable } from "./notifications/telegram-dispatcher.js";
import { openInDefaultBrowser } from "./operations/browser.js";
import { runDoctor } from "./operations/doctor.js";
import { createNdjsonLogger } from "./operations/logger.js";
import { applicationPaths, applicationRoot } from "./operations/paths.js";
import { startApplication } from "./operations/start.js";
import { openApplicationDatabase } from "./persistence/database.js";
import { createManualBackup, restoreManualBackup } from "./persistence/maintenance.js";
import { isWebsiteChangeMonitorAtPort } from "./operations/instance.js";

const port = 43117;

async function browserExecutablePath(): Promise<string> {
  if (process.env.WEBSITE_CHANGE_MONITOR_BROWSER_PATH !== undefined) {
    return process.env.WEBSITE_CHANGE_MONITOR_BROWSER_PATH;
  }
  const { chromium } = await import("playwright");
  return chromium.executablePath();
}

async function main(): Promise<void> {
  const command = process.argv[2];
  const rootDirectory = applicationRoot(process.env);
  const paths = applicationPaths(rootDirectory);
  process.env.PLAYWRIGHT_BROWSERS_PATH = paths.browsers;
  if (command === "backup" || command === "restore") {
    if (await isWebsiteChangeMonitorAtPort(port)) {
      process.stderr.write("Остановите Website Change Monitor перед backup или restore.\n");
      process.exitCode = 1;
      return;
    }
    try {
      if (command === "backup") {
        const marker = process.argv.indexOf("--output");
        const output = marker < 0 ? undefined : process.argv[marker + 1];
        const created = await createManualBackup(rootDirectory, output);
        process.stdout.write(`Резервная копия создана: ${created}\n`);
      } else {
        const marker = process.argv.indexOf("--input");
        const input = marker < 0 ? undefined : process.argv[marker + 1];
        if (input === undefined) throw new Error("Укажите --input <absolute-or-backup-path>.");
        const restored = restoreManualBackup(rootDirectory, input);
        process.stdout.write(`База данных восстановлена: ${restored}\n`);
      }
    } catch (error) {
      process.stderr.write(`${safeErrorMessage(error)}\n`);
      process.exitCode = 1;
    }
    return;
  }
  if (command === "configure") {
    const marker = process.argv.indexOf("--telegram-executable");
    const executable = marker < 0 ? undefined : process.argv[marker + 1];
    if (executable === undefined || !isAbsolute(executable) || !existsSync(executable) || !statSync(executable).isFile()) {
      process.stderr.write("Укажите существующий абсолютный путь: --telegram-executable <path>\n"); process.exitCode = 1; return;
    }
    const telegram = await inspectTelegramExecutable(executable);
    if (telegram.status !== "available") {
      process.stderr.write(`${telegram.reason ?? "Telegram sender недоступен."}\n`);
      process.exitCode = 1;
      return;
    }
    const database = openApplicationDatabase({ rootDirectory });
    try { database.configureTelegramExecutable(executable); } finally { database.close(); }
    process.stdout.write(`Telegram executable сохранён: ${executable}\n`); return;
  }
  if (command === "doctor") {
    const report = await runDoctor({
      rootDirectory,
      port,
      runtime: currentRuntime(),
      browserExecutablePath: await browserExecutablePath(),
    });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = report.exitCode;
    return;
  }

  if (command === "start") {
    const preflight = await runDoctor({
      rootDirectory,
      port,
      runtime: currentRuntime(),
      browserExecutablePath: await browserExecutablePath(),
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
      startPageProbe: async () => {
        const { launchPlaywrightPageProbe } = await import("./browser-playwright/playwright-page-probe.js");
        return launchPlaywrightPageProbe();
      },
    });

    if (outcome.kind === "existing") {
      process.stdout.write("Website Change Monitor уже работает; интерфейс открыт.\n");
      return;
    }

    process.stdout.write(`Website Change Monitor: http://127.0.0.1:${port}/\n`);
    const logger = createNdjsonLogger(paths.logs);
    logger.write("application_started", { port });
    let closing = false;
    const close = () => {
      if (closing) {
        return;
      }
      closing = true;
      void outcome.close().then(
        () => {
          process.stdout.write("Website Change Monitor остановлен.\n");
          logger.write("application_stopped");
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

  process.stderr.write("Использование: website-change-monitor <start|doctor|configure|backup|restore>\n");
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
