import type { FastifySchema } from "fastify";

import { pageProbeErrorCodes } from "../application/page-probe.js";

export const applicationId = "website-change-monitor";
export const apiVersion = "v1";

export const apiErrorCodesV1 = [
  "internal_error",
  "invalid_host",
  "invalid_origin",
  "invalid_request",
  "not_found",
  ...pageProbeErrorCodes,
  "unsupported_selector",
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

export const previewRequestSchemaV1 = {
  $id: "PreviewRequestV1",
  type: "object",
  additionalProperties: false,
  required: ["url", "targetSelector"],
  properties: {
    url: { type: "string", minLength: 1 },
    targetSelector: { type: "string", minLength: 1 },
  },
} as const;

export const previewResponseSchemaV1 = {
  $id: "PreviewResponseV1",
  type: "object",
  additionalProperties: false,
  required: ["finalUrl", "targetSelector", "matchCount"],
  properties: {
    finalUrl: { type: "string" },
    targetSelector: { type: "string" },
    matchCount: { type: "integer", minimum: 1 },
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

export const previewRouteSchema: FastifySchema = {
  operationId: "previewTarget",
  summary: "Предпросмотреть один Целевой селектор",
  body: { $ref: "PreviewRequestV1#" },
  response: {
    200: { $ref: "PreviewResponseV1#" },
    400: { $ref: "ApiErrorV1#" },
    422: { $ref: "ApiErrorV1#" },
    502: { $ref: "ApiErrorV1#" },
    504: { $ref: "ApiErrorV1#" },
    ...commonErrors,
  },
};
