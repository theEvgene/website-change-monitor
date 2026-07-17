import fastifyStatic from "@fastify/static";
import fastifySwagger from "@fastify/swagger";
import Fastify, { type FastifyInstance } from "fastify";

import { PageProbeError, type PageProbe } from "../application/page-probe.js";
import {
  createMonitorService,
  MonitorInputError,
  type MonitorView,
} from "../application/monitor-service.js";
import { previewPage, PreviewInputError } from "../application/preview-page.js";
import type { ApplicationDatabase } from "../persistence/database.js";
import {
  apiError,
  apiErrorSchemaV1,
  apiVersion,
  applicationId,
  createMonitorRouteSchema,
  getMonitorRouteSchema,
  healthResponseSchemaV1,
  healthRouteSchema,
  listMonitorChecksRouteSchema,
  listMonitorsRouteSchema,
  monitorCheckListResponseSchemaV1,
  monitorCheckSchemaV1,
  monitorCreateRequestSchemaV1,
  monitorDetailSchemaV1,
  monitorListResponseSchemaV1,
  monitorSummarySchemaV1,
  previewRequestSchemaV1,
  previewResponseSchemaV1,
  previewRouteSchema,
  versionResponseSchemaV1,
  versionRouteSchema,
} from "./contract.js";

export interface BuildHttpServerOptions {
  database: ApplicationDatabase;
  version: string;
  port: number;
  pageProbe?: PageProbe;
  staticRoot?: string;
}

export function buildHttpServer(
  options: BuildHttpServerOptions,
): FastifyInstance {
  const server = Fastify({ logger: false, trustProxy: false });
  const pageProbe = options.pageProbe ?? unavailablePageProbe;
  const monitors = createMonitorService({
    database: options.database,
    pageProbe,
  });

  server.addHook("onRequest", async (request, reply) => {
    const allowedHosts = new Set([
      `127.0.0.1:${options.port}`,
      `localhost:${options.port}`,
    ]);
    if (!request.headers.host || !allowedHosts.has(request.headers.host)) {
      await reply.code(421).send({
        ...apiError(
          "invalid_host",
          "Запрос адресован недопустимому локальному узлу.",
        ),
      });
      return reply;
    }

    const origin = request.headers.origin;
    if (
      origin !== undefined &&
      origin !== `http://127.0.0.1:${options.port}` &&
      origin !== `http://localhost:${options.port}`
    ) {
      await reply.code(403).send({
        ...apiError(
          "invalid_origin",
          "Источник запроса не совпадает с локальным приложением.",
        ),
      });
      return reply;
    }
  });

  server.setNotFoundHandler(async (_request, reply) => {
    await reply
      .code(404)
      .send(apiError("not_found", "Запрошенная операция не найдена."));
  });

  server.setErrorHandler(async (error, _request, reply) => {
    if (isBadRequestError(error)) {
      await reply
        .code(400)
        .send(
          apiError(
            "invalid_request",
            "Тело запроса не соответствует HTTP-контракту.",
          ),
        );
      return;
    }
    await reply
      .code(500)
      .send(apiError("internal_error", "Внутренняя ошибка приложения."));
  });

  void server.register(async (apiServer) => {
    await apiServer.register(fastifySwagger, {
      openapi: {
        openapi: "3.1.0",
        info: {
          title: "Website Change Monitor API",
          description:
            "Единый локальный HTTP API для React-интерфейса и автоматизации.",
          version: options.version,
        },
        servers: [{ url: `http://127.0.0.1:${options.port}` }],
      },
      refResolver: {
        buildLocalReference(json) {
          return String(json.$id);
        },
      },
    });

    apiServer.addSchema(apiErrorSchemaV1);
    apiServer.addSchema(healthResponseSchemaV1);
    apiServer.addSchema(versionResponseSchemaV1);
    apiServer.addSchema(previewRequestSchemaV1);
    apiServer.addSchema(previewResponseSchemaV1);
    apiServer.addSchema(monitorCreateRequestSchemaV1);
    apiServer.addSchema(monitorCheckSchemaV1);
    apiServer.addSchema(monitorSummarySchemaV1);
    apiServer.addSchema(monitorListResponseSchemaV1);
    apiServer.addSchema(monitorDetailSchemaV1);
    apiServer.addSchema(monitorCheckListResponseSchemaV1);

    apiServer.get("/api/health", { schema: healthRouteSchema }, async () => {
      const database = options.database.diagnostics();
      return {
        application: applicationId,
        status: "degraded" as const,
        version: options.version,
        database: {
          status: database.status,
          schemaVersion: database.schemaVersion,
        },
        telegram: {
          status: "unavailable" as const,
          reason: "not_configured" as const,
        },
      };
    });

    apiServer.get("/api/version", { schema: versionRouteSchema }, async () => ({
      application: applicationId,
      apiVersion,
      version: options.version,
    }));

    apiServer.post<{
      Body: {
        url: string;
        targetSelectors: string[];
        exclusionSelectors: string[];
      };
    }>(
      "/api/preview",
      { schema: previewRouteSchema },
      async (request, reply) => {
        try {
          return await previewPage(
            request.body,
            pageProbe,
          );
        } catch (error: unknown) {
          if (error instanceof PreviewInputError) {
            return reply.code(400).send(
              apiError(error.code, error.message, {
                ...(error.field === undefined ? {} : { field: error.field }),
                ...(error.index === undefined ? {} : { index: error.index }),
              }),
            );
          }
          if (error instanceof PageProbeError) {
            return reply
              .code(pageProbeStatus(error.code))
              .send(
                apiError(error.code, error.message, {
                  ...(error.field === undefined ? {} : { field: error.field }),
                  ...(error.index === undefined ? {} : { index: error.index }),
                }),
              );
          }
          throw error;
        }
      },
    );

    apiServer.post<{
      Body: {
        name: string;
        url: string;
        targetSelectors: string[];
        exclusionSelectors: string[];
        intervalHours: number;
      };
    }>(
      "/api/monitors",
      { schema: createMonitorRouteSchema },
      async (request, reply) => {
        try {
          const monitor = await monitors.createMonitor(request.body);
          return reply.code(201).send(publicMonitor(monitor));
        } catch (error: unknown) {
          if (error instanceof MonitorInputError) {
            return reply.code(400).send(apiError(error.code, error.message));
          }
          if (error instanceof PreviewInputError) {
            return reply.code(400).send(
              apiError(error.code, error.message, {
                ...(error.field === undefined ? {} : { field: error.field }),
                ...(error.index === undefined ? {} : { index: error.index }),
              }),
            );
          }
          if (error instanceof PageProbeError) {
            return reply
              .code(pageProbeStatus(error.code))
              .send(apiError(error.code, error.message));
          }
          throw error;
        }
      },
    );

    apiServer.get(
      "/api/monitors",
      { schema: listMonitorsRouteSchema },
      async () => monitors.listMonitors(),
    );

    apiServer.get<{ Params: { monitorId: number } }>(
      "/api/monitors/:monitorId",
      { schema: getMonitorRouteSchema },
      async (request, reply) => {
        const monitor = monitors.getMonitor(request.params.monitorId);
        if (monitor === undefined) {
          return reply
            .code(404)
            .send(apiError("not_found", "Монитор не найден."));
        }
        return publicMonitor(monitor);
      },
    );

    apiServer.get<{ Params: { monitorId: number } }>(
      "/api/monitors/:monitorId/checks",
      { schema: listMonitorChecksRouteSchema },
      async (request, reply) => {
        const monitor = monitors.getMonitor(request.params.monitorId);
        if (monitor === undefined) {
          return reply
            .code(404)
            .send(apiError("not_found", "Монитор не найден."));
        }
        return publicMonitor(monitor).history;
      },
    );

    apiServer.get(
      "/openapi.json",
      { schema: { hide: true } },
      async (_request, reply) => reply.send(apiServer.swagger()),
    );
  });

  if (options.staticRoot !== undefined) {
    void server.register(fastifyStatic, {
      root: options.staticRoot,
      index: ["index.html"],
    });
  }

  return server;
}

function publicMonitor(monitor: MonitorView) {
  return {
    ...monitor,
    history: monitor.history.map((check) => ({
      ...check,
      snapshot:
        check.snapshot === null
          ? null
          : {
              id: check.snapshot.id,
              formatVersion: check.snapshot.formatVersion,
              sha256: check.snapshot.sha256,
            },
    })),
  };
}

const unavailablePageProbe: PageProbe = {
  async preview() {
    return {
      ok: false,
      code: "browser_failed",
      message: "Chromium недоступен для исследования страницы.",
      stage: "setup",
      timings: {
        totalMs: 0,
        navigationMs: 0,
        targetMs: 0,
        scrollMs: 0,
        stabilityMs: 0,
        extractionMs: 0,
      },
    };
  },
};

function pageProbeStatus(code: PageProbeError["code"]): 400 | 422 | 502 | 504 {
  if (code === "invalid_url" || code === "invalid_selector") {
    return 400;
  }
  if (code === "check_deadline_exceeded" || code === "navigation_timeout") {
    return 504;
  }
  if (
    code === "target_not_found" ||
    code === "target_not_visible" ||
    code === "target_area_too_large" ||
    code === "target_disappeared" ||
    code === "content_unstable"
  ) {
    return 422;
  }
  return 502;
}

function isBadRequestError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (("validation" in error && error.validation !== undefined) ||
      ("statusCode" in error && error.statusCode === 400))
  );
}
