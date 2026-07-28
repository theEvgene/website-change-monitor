import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildHttpServer } from "../src/server/http/server.js";
import {
  openApplicationDatabase,
  type ApplicationDatabase,
} from "../src/server/persistence/database.js";

describe("local HTTP server", () => {
  const roots: string[] = [];
  const databases: ApplicationDatabase[] = [];
  const servers: Array<ReturnType<typeof buildHttpServer>> = [];

  afterEach(async () => {
    for (const server of servers.splice(0)) {
      await server.close();
    }
    for (const database of databases.splice(0)) {
      database.close();
    }
    for (const root of roots.splice(0)) {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports the application and database state through health", async () => {
    const root = await mkdtemp(join(tmpdir(), "website-change-monitor-"));
    roots.push(root);
    const database = openApplicationDatabase({ rootDirectory: root });
    databases.push(database);
    const server = buildHttpServer({ database, version: "0.1.0", port: 43117 });
    servers.push(server);

    const response = await server.inject({
      method: "GET",
      url: "/api/health",
      headers: { host: "127.0.0.1:43117" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      application: "website-change-monitor",
      status: "degraded",
      version: "0.1.0",
      database: {
        status: "ready",
        schemaVersion: 11,
      },
      telegram: {
        status: "unavailable",
        reason: "Исполняемый файл Telegram не настроен или недоступен.",
      },
    });
  });

  it("reads runtime notification settings and disables Telegram without degrading health", async () => {
    const root = await mkdtemp(join(tmpdir(), "website-change-monitor-")); roots.push(root);
    const database = openApplicationDatabase({ rootDirectory: root }); databases.push(database);
    const server = buildHttpServer({ database, version: "0.1.0", port: 43117 }); servers.push(server);
    const headers = { host: "127.0.0.1:43117" };

    expect((await server.inject({ method: "GET", url: "/api/settings/notifications", headers })).json()).toEqual({
      telegramEnabled: true,
      notifyWhenUnchanged: false,
      telegramPhase: "enabled",
    });
    const updated = await server.inject({
      method: "PUT",
      url: "/api/settings/notifications",
      headers,
      payload: { telegramEnabled: false, notifyWhenUnchanged: true },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toEqual({
      telegramEnabled: false,
      notifyWhenUnchanged: false,
      telegramPhase: "disabled",
    });
    expect((await server.inject({ method: "GET", url: "/api/health", headers })).json()).toMatchObject({
      status: "ready",
      telegram: { status: "disabled", reason: null },
    });
    expect((await server.inject({
      method: "PUT",
      url: "/api/settings/notifications",
      headers,
      payload: { notifyWhenUnchanged: true },
    })).json()).toEqual({
      telegramEnabled: false,
      notifyWhenUnchanged: false,
      telegramPhase: "disabled",
    });
    expect((await server.inject({
      method: "PUT",
      url: "/api/settings/notifications",
      headers,
      payload: {},
    })).statusCode).toBe(400);
  });

  it("keeps Telegram disabled when an older re-enable check completes late", async () => {
    const root = await mkdtemp(join(tmpdir(), "website-change-monitor-")); roots.push(root);
    const database = openApplicationDatabase({ rootDirectory: root }); databases.push(database);
    let resolveCheck!: (state: { status: "available"; reason: null }) => void;
    let inspections = 0;
    const server = buildHttpServer({
      database,
      version: "0.1.0",
      port: 43117,
      inspectTelegramAvailability: () => {
        inspections += 1;
        if (inspections === 1) return Promise.resolve({ status: "available", reason: null });
        return new Promise((resolve) => { resolveCheck = resolve; });
      },
    });
    servers.push(server);
    const headers = { host: "127.0.0.1:43117" };

    await server.inject({ method: "PUT", url: "/api/settings/notifications", headers, payload: { telegramEnabled: false } });
    expect((await server.inject({
      method: "PUT",
      url: "/api/settings/notifications",
      headers,
      payload: { telegramEnabled: true },
    })).json()).toMatchObject({ telegramEnabled: true, telegramPhase: "checking" });
    expect((await server.inject({ method: "GET", url: "/api/health", headers })).json()).toMatchObject({
      status: "degraded",
      telegram: { status: "checking", reason: null },
    });

    await server.inject({ method: "PUT", url: "/api/settings/notifications", headers, payload: { telegramEnabled: false } });
    resolveCheck({ status: "available", reason: null });
    await Promise.resolve();

    expect((await server.inject({ method: "GET", url: "/api/settings/notifications", headers })).json()).toEqual({
      telegramEnabled: false,
      notifyWhenUnchanged: false,
      telegramPhase: "disabled",
    });
    expect((await server.inject({ method: "GET", url: "/api/health", headers })).json()).toMatchObject({
      status: "ready",
      telegram: { status: "disabled", reason: null },
    });
  });

  it("serves the built React entry page from the same process", async () => {
    const root = await mkdtemp(join(tmpdir(), "website-change-monitor-"));
    roots.push(root);
    const staticRoot = join(root, "client");
    await mkdir(staticRoot);
    await writeFile(
      join(staticRoot, "index.html"),
      "<!doctype html><title>Website Change Monitor</title><div id=\"root\"></div>",
      "utf8",
    );
    const database = openApplicationDatabase({ rootDirectory: root });
    databases.push(database);
    const server = buildHttpServer({
      database,
      version: "0.1.0",
      port: 43117,
      staticRoot,
    });
    servers.push(server);

    const response = await server.inject({
      method: "GET",
      url: "/",
      headers: { host: "127.0.0.1:43117" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/html");
    expect(response.body).toContain("Website Change Monitor");
  });

  it("rejects DNS-rebinding hosts and foreign browser origins", async () => {
    const root = await mkdtemp(join(tmpdir(), "website-change-monitor-"));
    roots.push(root);
    const database = openApplicationDatabase({ rootDirectory: root });
    databases.push(database);
    const server = buildHttpServer({ database, version: "0.1.0", port: 43117 });
    servers.push(server);

    const foreignHost = await server.inject({
      method: "GET",
      url: "/api/health",
      headers: { host: "attacker.example:43117" },
    });
    const foreignOrigin = await server.inject({
      method: "GET",
      url: "/api/health",
      headers: {
        host: "127.0.0.1:43117",
        origin: "https://attacker.example",
      },
    });
    const localBrowser = await server.inject({
      method: "GET",
      url: "/api/health",
      headers: {
        host: "127.0.0.1:43117",
        origin: "http://127.0.0.1:43117",
      },
    });

    expect(foreignHost.statusCode).toBe(421);
    expect(foreignHost.json()).toMatchObject({
      error: { code: "invalid_host" },
    });
    expect(foreignOrigin.statusCode).toBe(403);
    expect(foreignOrigin.json()).toMatchObject({
      error: { code: "invalid_origin" },
    });
    expect(localBrowser.statusCode).toBe(200);
  });
});
