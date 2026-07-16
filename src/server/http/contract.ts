import type { FastifySchema } from "fastify";

export const applicationId = "website-change-monitor";
export const apiVersion = "v1";

export const apiErrorCodesV1 = [
  "internal_error",
  "invalid_host",
  "invalid_origin",
  "not_found",
] as const;
export type ApiErrorCodeV1 = (typeof apiErrorCodesV1)[number];

export interface ApiErrorV1 {
  error: {
    code: ApiErrorCodeV1;
    message: string;
  };
}

export function apiError(code: ApiErrorCodeV1, message: string): ApiErrorV1 {
  return { error: { code, message } };
}

export const apiErrorSchemaV1 = {
  $id: "ApiErrorV1",
  type: "object",
  additionalProperties: false,
  required: ["error"],
  properties: {
    error: {
      type: "object",
      additionalProperties: false,
      required: ["code", "message"],
      properties: {
        code: { enum: apiErrorCodesV1, type: "string" },
        message: { type: "string" },
      },
    },
  },
} as const;

export const healthResponseSchemaV1 = {
  $id: "HealthResponseV1",
  type: "object",
  additionalProperties: false,
  required: ["application", "status", "version", "database", "telegram"],
  properties: {
    application: { const: applicationId, type: "string" },
    status: { enum: ["ready", "degraded"], type: "string" },
    version: { type: "string" },
    database: {
      type: "object",
      additionalProperties: false,
      required: ["status", "schemaVersion"],
      properties: {
        status: { const: "ready", type: "string" },
        schemaVersion: { type: "integer", minimum: 0 },
      },
    },
    telegram: {
      type: "object",
      additionalProperties: false,
      required: ["status", "reason"],
      properties: {
        status: { const: "unavailable", type: "string" },
        reason: { const: "not_configured", type: "string" },
      },
    },
  },
} as const;

export const versionResponseSchemaV1 = {
  $id: "VersionResponseV1",
  type: "object",
  additionalProperties: false,
  required: ["application", "apiVersion", "version"],
  properties: {
    application: { const: applicationId, type: "string" },
    apiVersion: { const: apiVersion, type: "string" },
    version: { type: "string" },
  },
} as const;

const commonErrors = {
  403: { $ref: "ApiErrorV1#" },
  421: { $ref: "ApiErrorV1#" },
  500: { $ref: "ApiErrorV1#" },
} as const;

export const healthRouteSchema: FastifySchema = {
  operationId: "getHealth",
  summary: "Получить состояние локального приложения",
  response: {
    200: { $ref: "HealthResponseV1#" },
    ...commonErrors,
  },
};

export const versionRouteSchema: FastifySchema = {
  operationId: "getVersion",
  summary: "Получить версии приложения и HTTP API",
  response: {
    200: { $ref: "VersionResponseV1#" },
    ...commonErrors,
  },
};
