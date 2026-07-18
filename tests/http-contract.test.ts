import { afterEach, describe, expect, it } from "vitest";

import { createHttpTestContext } from "./support/http-test-context.js";

describe("public HTTP contract", () => {
  const context = createHttpTestContext();

  afterEach(async () => {
    await context.cleanup();
  });

  it("publishes OpenAPI 3.1 generated from the public Fastify routes", async () => {
    const server = await context.applicationServer();

    const response = await server.inject({
      method: "GET",
      url: "/openapi.json",
      headers: localHeaders(),
    });

    expect(response.statusCode).toBe(200);
    const document = response.json<{
      openapi: string;
      info: { version: string };
      paths: Record<string, Record<string, { operationId?: string }>>;
      components: { schemas: Record<string, unknown> };
    }>();
    expect(document.openapi).toBe("3.1.0");
    expect(document.info.version).toBe("0.1.0");
    expect(Object.keys(document.paths).sort()).toEqual([
      "/api/check-intents",
      "/api/checks",
      "/api/checks/{checkId}/comparison",
      "/api/health",
      "/api/monitors",
      "/api/monitors/{monitorId}",
      "/api/monitors/{monitorId}/checks",
      "/api/monitors/{monitorId}/pause",
      "/api/monitors/{monitorId}/resume",
      "/api/notifications",
      "/api/notifications/stream",
      "/api/preview",
      "/api/telegram",
      "/api/telegram/recheck",
      "/api/version",
    ]);
    expect(document.paths["/api/health"]?.get?.operationId).toBe("getHealth");
    expect(document.paths["/api/checks"]?.get?.operationId).toBe("listJournal");
    expect(document.paths["/api/check-intents"]?.get?.operationId).toBe("listCheckIntents");
    expect(document.paths["/api/checks/{checkId}/comparison"]?.get?.operationId).toBe("getComparison");
    expect(document.paths["/api/preview"]?.post?.operationId).toBe(
      "previewObservationScope",
    );
    expect(document.paths["/api/monitors"]?.post?.operationId).toBe(
      "createMonitor",
    );
    expect(document.paths["/api/monitors"]?.get?.operationId).toBe(
      "listMonitors",
    );
    expect(document.paths["/api/monitors/{monitorId}"]?.get?.operationId).toBe(
      "getMonitor",
    );
    expect(document.paths["/api/monitors/{monitorId}"]?.put?.operationId).toBe("updateMonitor");
    expect(document.paths["/api/monitors/{monitorId}"]?.delete?.operationId).toBe("deleteMonitor");
    expect(
      document.paths["/api/monitors/{monitorId}/checks"]?.get?.operationId,
    ).toBe("listMonitorChecks");
    expect(
      document.paths["/api/monitors/{monitorId}/checks"]?.post?.operationId,
    ).toBe("requestManualCheck");
    expect(document.paths["/api/monitors/{monitorId}/pause"]?.post?.operationId).toBe("pauseMonitor");
    expect(document.paths["/api/monitors/{monitorId}/resume"]?.post?.operationId).toBe("resumeMonitor");
    expect(document.paths["/api/version"]?.get?.operationId).toBe("getVersion");
    expect(document.paths["/api/notifications"]?.get?.operationId).toBe("listNotifications");
    expect(document.paths["/api/notifications/stream"]?.get?.operationId).toBe("streamNotifications");
    expect(document.paths["/api/telegram"]?.get?.operationId).toBe("getTelegramState");
    expect(document.paths["/api/telegram/recheck"]?.post?.operationId).toBe("recheckTelegram");
    expect(Object.keys(document.components.schemas).sort()).toEqual([
      "ApiErrorV1",
      "CheckIntentListResponseV1",
      "CheckIntentV1",
      "ComparisonResponseV1",
      "HealthResponseV1",
      "JournalCheckV1",
      "JournalResponseV1",
      "MonitorCheckListResponseV1",
      "MonitorCheckV1",
      "MonitorCreateRequestV1",
      "MonitorDeleteRequestV1",
      "MonitorDetailV1",
      "MonitorListResponseV1",
      "MonitorSummaryV1",
      "MonitorUpdateRequestV1",
      "NotificationEventV1",
      "NotificationFeedV1",
      "PreviewRequestV1",
      "PreviewResponseV1",
      "TelegramStateV1",
      "VersionResponseV1",
    ]);
    expect(document.components.schemas.PreviewRequestV1).toMatchObject({
      required: ["url", "targetSelectors", "exclusionSelectors"],
      properties: {
        targetSelectors: {
          type: "array",
          minItems: 1,
          description: expect.stringContaining("каждый селектор обязан найти"),
        },
        exclusionSelectors: {
          type: "array",
          description: expect.stringContaining("порядок селекторов не влияет"),
        },
      },
    });
    expect(document.components.schemas.PreviewResponseV1).toMatchObject({
      properties: {
        targetCount: {
          description: expect.stringContaining("уникальном объединении"),
        },
        targets: {
          description: expect.stringContaining("глобальном порядке DOM"),
        },
      },
    });

    for (const [path, pathItem] of Object.entries(document.paths)) {
      for (const method of Object.keys(pathItem)) {
        const actual = await server.inject({
          method: method.toUpperCase() as "GET" | "POST",
          url: path,
          headers: localHeaders(),
          ...(method === "post" ? { payload: {} } : {}),
        });
        expect(
          actual.statusCode,
          `${method.toUpperCase()} ${path} must be an actual route`,
        ).not.toBe(404);
      }
    }
  });

  it("returns version and safe typed errors in the documented envelope", async () => {
    const server = await context.applicationServer();
    server.get("/api/test-error", { schema: { hide: true } }, async () => {
      throw new Error("sensitive internal detail");
    });

    const version = await server.inject({
      method: "GET",
      url: "/api/version",
      headers: localHeaders(),
    });
    const notFound = await server.inject({
      method: "GET",
      url: "/api/missing",
      headers: localHeaders(),
    });
    const internalError = await server.inject({
      method: "GET",
      url: "/api/test-error",
      headers: localHeaders(),
    });

    expect(version.statusCode).toBe(200);
    expect(version.json()).toEqual({
      application: "website-change-monitor",
      apiVersion: "v1",
      version: "0.1.0",
    });
    expect(notFound.statusCode).toBe(404);
    expect(notFound.json()).toEqual({
      error: {
        code: "not_found",
        message: "Запрошенная операция не найдена.",
      },
    });
    expect(internalError.statusCode).toBe(500);
    expect(internalError.json()).toEqual({
      error: {
        code: "internal_error",
        message: "Внутренняя ошибка приложения.",
      },
    });
    expect(internalError.body).not.toContain("sensitive internal detail");
    expect(internalError.body).not.toContain("stack");
  });

});

function localHeaders() {
  return { host: "127.0.0.1:43117" };
}
