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
  "duplicate_selector",
  "unsupported_selector",
] as const;
export type ApiErrorCodeV1 = (typeof apiErrorCodesV1)[number];

export interface ApiErrorV1 {
  error: {
    code: ApiErrorCodeV1;
    message: string;
    field?: "targetSelectors" | "exclusionSelectors";
    index?: number;
  };
}

export function apiError(
  code: ApiErrorCodeV1,
  message: string,
  location?: {
    field?: "targetSelectors" | "exclusionSelectors";
    index?: number;
  },
): ApiErrorV1 {
  return {
    error: {
      code,
      message,
      ...(location?.field === undefined ? {} : { field: location.field }),
      ...(location?.index === undefined ? {} : { index: location.index }),
    },
  };
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
        field: {
          enum: ["targetSelectors", "exclusionSelectors"],
          type: "string",
        },
        index: { type: "integer", minimum: 0 },
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
  required: ["url", "targetSelectors", "exclusionSelectors"],
  properties: {
    url: { type: "string", minLength: 1 },
    targetSelectors: {
      type: "array",
      minItems: 1,
      description:
        "Непустой набор стандартных CSS-селекторов light DOM. Значения нормализуются по краям, точные дубли запрещены, и каждый селектор обязан найти совпадение.",
      items: { type: "string" },
    },
    exclusionSelectors: {
      type: "array",
      description:
        "Набор стандартных CSS-селекторов поддеревьев, удаляемых внутри каждого элемента Целевой области; порядок селекторов не влияет на результат.",
      items: { type: "string" },
    },
  },
} as const;

export const previewResponseSchemaV1 = {
  $id: "PreviewResponseV1",
  type: "object",
  additionalProperties: false,
  required: [
    "finalUrl",
    "targetMatches",
    "exclusionSelectors",
    "targetCount",
    "targets",
  ],
  properties: {
    finalUrl: { type: "string" },
    targetMatches: {
      type: "array",
      minItems: 1,
      description:
        "Число совпадений каждого Целевого селектора в порядке полей запроса.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["selector", "matchCount"],
        properties: {
          selector: { type: "string" },
          matchCount: { type: "integer", minimum: 1 },
        },
      },
    },
    exclusionSelectors: {
      type: "array",
      items: { type: "string" },
    },
    targetCount: {
      type: "integer",
      minimum: 1,
      description:
        "Количество элементов в уникальном объединении Целевых селекторов после устранения дублей по идентичности DOM-узла.",
    },
    targets: {
      type: "array",
      minItems: 1,
      description:
        "Элементы Целевой области в глобальном порядке DOM независимо от порядка Целевых селекторов в запросе.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["elements", "visibleText"],
        properties: {
          elements: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["namespace", "name", "childElementCount"],
              properties: {
                namespace: { type: ["string", "null"] },
                name: { type: "string" },
                childElementCount: { type: "integer", minimum: 0 },
              },
            },
          },
          visibleText: { type: "string" },
        },
      },
    },
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
  operationId: "previewObservationScope",
  summary: "Предпросмотреть Область наблюдения",
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
