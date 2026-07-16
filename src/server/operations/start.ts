import type { FastifyInstance } from "fastify";
import type { AddressInfo } from "node:net";

import type { PageProbeRuntime } from "../browser-playwright/playwright-page-probe.js";
import { buildHttpServer } from "../http/server.js";
import {
  openApplicationDatabase,
  type ApplicationDatabase,
} from "../persistence/database.js";
import { isWebsiteChangeMonitorAtPort } from "./instance.js";

export interface StartApplicationOptions {
  rootDirectory: string;
  staticRoot: string;
  port: number;
  version: string;
  openBrowser(url: string): Promise<void>;
  startPageProbe?(): Promise<PageProbeRuntime>;
}

export type StartOutcome =
  | { kind: "existing" }
  | {
      kind: "started";
      address: {
        host: string;
        family: string;
        port: number;
      };
      close(): Promise<void>;
    };

export class PortInUseError extends Error {
  constructor(port: number) {
    super(
      `Порт ${port} занят другим процессом. Website Change Monitor не запущен.`,
    );
    this.name = "PortInUseError";
  }
}

export async function startApplication(
  options: StartApplicationOptions,
): Promise<StartOutcome> {
  const url = `http://127.0.0.1:${options.port}/`;
  let database: ApplicationDatabase | undefined;
  let server: FastifyInstance | undefined;
  let pageProbeRuntime: PageProbeRuntime | undefined;
  let address: AddressInfo | undefined;

  try {
    database = openApplicationDatabase({ rootDirectory: options.rootDirectory });
    pageProbeRuntime = await options.startPageProbe?.();
    server = buildHttpServer({
      database,
      version: options.version,
      port: options.port,
      staticRoot: options.staticRoot,
      ...(pageProbeRuntime === undefined
        ? {}
        : { pageProbe: pageProbeRuntime.pageProbe }),
    });
    await server.listen({ host: "127.0.0.1", port: options.port });
    const listenerAddress = server.server.address();
    if (listenerAddress === null || typeof listenerAddress === "string") {
      throw new Error("Не удалось определить локальный адрес приложения.");
    }
    address = listenerAddress;
  } catch (error: unknown) {
    await closeResources(server, database, pageProbeRuntime);
    if (!isAddressInUse(error)) {
      throw error;
    }
    if (!(await isWebsiteChangeMonitorAtPort(options.port))) {
      throw new PortInUseError(options.port);
    }
    await options.openBrowser(url);
    return { kind: "existing" };
  }

  try {
    await options.openBrowser(url);
  } catch (error: unknown) {
    await closeResources(server, database, pageProbeRuntime);
    throw error;
  }
  const startedServer = server;
  const startedDatabase = database;
  const startedPageProbe = pageProbeRuntime;
  return {
    kind: "started",
    address: {
      host: address.address,
      family: address.family,
      port: address.port,
    },
    async close() {
      await closeResources(startedServer, startedDatabase, startedPageProbe);
    },
  };
}

function isAddressInUse(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "EADDRINUSE"
  );
}

async function closeResources(
  server: FastifyInstance | undefined,
  database: ApplicationDatabase | undefined,
  pageProbeRuntime?: PageProbeRuntime,
): Promise<void> {
  if (server !== undefined) {
    await server.close();
  }
  if (database !== undefined) {
    database.close();
  }
  if (pageProbeRuntime !== undefined) {
    await pageProbeRuntime.close();
  }
}
