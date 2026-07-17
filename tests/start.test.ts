import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { buildHttpServer } from "../src/server/http/server.js";
import { startApplication } from "../src/server/operations/start.js";
import {
  simplePagePreviewTargets,
  successfulPageProbeResult,
} from "./support/page-probe.js";
import { PortInUseError } from "../src/server/operations/start.js";
import { openApplicationDatabase } from "../src/server/persistence/database.js";

describe("application start", () => {
  it("starts one foreground application and opens its UI", async () => {
    const { root, staticRoot } = await applicationFixture();
    const port = await freePort();
    const openedUrls: string[] = [];
    let outcome: Awaited<ReturnType<typeof startApplication>> | undefined;

    try {
      outcome = await startApplication({
        rootDirectory: root,
        staticRoot,
        port,
        version: "0.1.0",
        openBrowser: async (url) => {
          openedUrls.push(url);
        },
      });

      expect(outcome.kind).toBe("started");
      expect(outcome).toMatchObject({
        kind: "started",
        address: { host: "127.0.0.1", family: "IPv4", port },
      });
      expect(openedUrls).toEqual([`http://127.0.0.1:${port}/`]);
      const health = await fetch(`http://127.0.0.1:${port}/api/health`);
      expect(health.status).toBe(200);
      await expect(health.json()).resolves.toMatchObject({
        application: "website-change-monitor",
      });
      await expect(
        access(join(root, "data", "website-change-monitor.sqlite3")),
      ).resolves.toBeUndefined();
    } finally {
      if (outcome?.kind === "started") {
        await outcome.close();
      }
      await rm(root, { recursive: true, force: true });
    }
  });

  it("serves preview through one application PageProbe and closes it", async () => {
    const { root, staticRoot } = await applicationFixture();
    const port = await freePort();
    const preview = vi
      .fn()
      .mockResolvedValue(
        successfulPageProbeResult(
          "https://example.com/final",
          [{ selector: ".target", matchCount: 2 }],
          simplePagePreviewTargets("Первый", "Второй"),
        ),
      );
    const closePageProbe = vi.fn().mockResolvedValue(undefined);
    let outcome: Awaited<ReturnType<typeof startApplication>> | undefined;

    try {
      outcome = await startApplication({
        rootDirectory: root,
        staticRoot,
        port,
        version: "0.1.0",
        openBrowser: async () => undefined,
        startPageProbe: async () => ({
          pageProbe: { preview },
          close: closePageProbe,
        }),
      });

      const response = await fetch(`http://127.0.0.1:${port}/api/preview`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          url: "https://example.com/start",
          targetSelectors: [".target"],
          exclusionSelectors: [],
        }),
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({ targetCount: 2 });
      expect(preview).toHaveBeenCalledOnce();
    } finally {
      if (outcome?.kind === "started") {
        await outcome.close();
      }
      expect(closePageProbe).toHaveBeenCalledOnce();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps polling the durable queue while the application is running", async () => {
    const { root, staticRoot } = await applicationFixture();
    const port = await freePort();
    const database = openApplicationDatabase({ rootDirectory: root });
    const monitorId = database.monitors.createMonitor({
      name: "Catalog", url: "https://example.com/catalog",
      targetSelectors: [".card"], exclusionSelectors: [], intervalHours: 6,
    }, new Date(Date.now() + 150).toISOString());
    database.close();
    const preview = vi.fn().mockResolvedValue(
      successfulPageProbeResult(
        "https://example.com/catalog",
        [{ selector: ".card", matchCount: 1 }],
        simplePagePreviewTargets("Product"),
      ),
    );
    let outcome: Awaited<ReturnType<typeof startApplication>> | undefined;

    try {
      outcome = await startApplication({
        rootDirectory: root, staticRoot, port, version: "0.1.0",
        openBrowser: async () => undefined,
        startPageProbe: async () => ({ pageProbe: { preview }, close: async () => undefined }),
        workerIntervalMs: 20,
      });
      await vi.waitFor(() => expect(preview).toHaveBeenCalledOnce(), { timeout: 2_000 });

      const response = await fetch(`http://127.0.0.1:${port}/api/monitors/${monitorId}`);
      await expect(response.json()).resolves.toMatchObject({
        history: [{ kind: "scheduled", result: "baseline" }],
      });
    } finally {
      if (outcome?.kind === "started") await outcome.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("opens the UI of an existing Website Change Monitor instance", async () => {
    const { root, staticRoot } = await applicationFixture();
    const port = await freePort();
    const database = openApplicationDatabase({ rootDirectory: root });
    const server = buildHttpServer({
      database,
      version: "0.1.0",
      port,
      staticRoot,
    });
    const openedUrls: string[] = [];

    try {
      await server.listen({ host: "127.0.0.1", port });

      const outcome = await startApplication({
        rootDirectory: root,
        staticRoot,
        port,
        version: "0.1.0",
        openBrowser: async (url) => {
          openedUrls.push(url);
        },
      });

      expect(outcome).toEqual({ kind: "existing" });
      expect(openedUrls).toEqual([`http://127.0.0.1:${port}/`]);
    } finally {
      await server.close();
      database.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses to treat a foreign process on the port as the application", async () => {
    const { root, staticRoot } = await applicationFixture();
    const port = await freePort();
    const foreignServer = createHttpServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ application: "another-program" }));
    });
    await new Promise<void>((resolve, reject) => {
      foreignServer.once("error", reject);
      foreignServer.listen(port, "127.0.0.1", resolve);
    });
    const openedUrls: string[] = [];

    try {
      await expect(
        startApplication({
          rootDirectory: root,
          staticRoot,
          port,
          version: "0.1.0",
          openBrowser: async (url) => {
            openedUrls.push(url);
          },
        }),
      ).rejects.toBeInstanceOf(PortInUseError);
      expect(openedUrls).toEqual([]);
    } finally {
      await new Promise<void>((resolve, reject) => {
        foreignServer.close((error) =>
          error === undefined ? resolve() : reject(error),
        );
      });
      await rm(root, { recursive: true, force: true });
    }
  });

  it("releases the port when the browser cannot be opened", async () => {
    const { root, staticRoot } = await applicationFixture();
    const port = await freePort();

    try {
      await expect(
        startApplication({
          rootDirectory: root,
          staticRoot,
          port,
          version: "0.1.0",
          openBrowser: async () => {
            throw new Error("browser unavailable");
          },
        }),
      ).rejects.toThrow("browser unavailable");

      const probe = createTcpServer();
      await new Promise<void>((resolve, reject) => {
        probe.once("error", reject);
        probe.listen(port, "127.0.0.1", resolve);
      });
      await new Promise<void>((resolve, reject) => {
        probe.close((error) =>
          error === undefined ? resolve() : reject(error),
        );
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function applicationFixture() {
  const root = await mkdtemp(join(tmpdir(), "website-change-monitor-"));
  const staticRoot = join(root, "client");
  await mkdir(staticRoot);
  await writeFile(join(staticRoot, "index.html"), '<div id="root"></div>');
  return { root, staticRoot };
}

async function freePort(): Promise<number> {
  const server = createTcpServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Expected a TCP address");
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
  return address.port;
}
