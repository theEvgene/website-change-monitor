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
      "/api/health",
      "/api/version",
    ]);
    expect(document.paths["/api/health"]?.get?.operationId).toBe("getHealth");
    expect(document.paths["/api/version"]?.get?.operationId).toBe("getVersion");
    expect(Object.keys(document.components.schemas).sort()).toEqual([
      "ApiErrorV1",
      "HealthResponseV1",
      "VersionResponseV1",
    ]);

    for (const path of Object.keys(document.paths)) {
      const actual = await server.inject({
        method: "GET",
        url: path,
        headers: localHeaders(),
      });
      expect(actual.statusCode, `${path} must be an actual route`).not.toBe(404);
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
