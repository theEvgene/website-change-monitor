import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";

import type { ApplicationDatabase } from "../persistence/database.js";

const applicationId = "website-change-monitor";

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
        error: {
          code: "invalid_host",
          message: "Запрос адресован недопустимому локальному узлу.",
        },
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
        error: {
          code: "invalid_origin",
          message: "Источник запроса не совпадает с локальным приложением.",
        },
      });
      return reply;
    }
  });

  server.get("/api/health", async () => {
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

  if (options.staticRoot !== undefined) {
    void server.register(fastifyStatic, {
      root: options.staticRoot,
      index: ["index.html"],
    });
  }

  return server;
}
