import fastifyStatic from "@fastify/static";
import fastifySwagger from "@fastify/swagger";
import Fastify, { type FastifyInstance } from "fastify";

import type { ApplicationDatabase } from "../persistence/database.js";
import {
  apiError,
  apiErrorSchemaV1,
  apiVersion,
  applicationId,
  healthResponseSchemaV1,
  healthRouteSchema,
  versionResponseSchemaV1,
  versionRouteSchema,
} from "./contract.js";

export interface BuildHttpServerOptions {
  database: ApplicationDatabase;
  version: string;
  port: number;
  staticRoot?: string;
}

export function buildHttpServer(
  options: BuildHttpServerOptions,
): FastifyInstance {
  const server = Fastify({ logger: false, trustProxy: false });

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

  server.setErrorHandler(async (_error, _request, reply) => {
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
