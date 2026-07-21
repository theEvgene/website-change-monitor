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
  "invalid_monitor_name",
  "invalid_interval",
  "scope_reset_required",
  "delete_confirmation_required",
  "snapshot_invalid",
  "snapshot_too_large",
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
      properties: { status: { enum: ["available", "unavailable"], type: "string" }, reason: { type: ["string", "null"] } },
    },
  },
} as const;

export const telegramStateSchemaV1 = {
  $id: "TelegramStateV1", type: "object", additionalProperties: false,
  required: ["status", "reason"], properties: {
    status: { enum: ["available", "unavailable"], type: "string" },
    reason: { type: ["string", "null"] },
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

export const monitorCreateRequestSchemaV1 = {
  $id: "MonitorCreateRequestV1",
  type: "object",
  additionalProperties: false,
  required: [
    "name",
    "url",
    "targetSelectors",
    "exclusionSelectors",
    "intervalHours",
  ],
  properties: {
    name: { type: "string", minLength: 1 },
    url: { type: "string", minLength: 1 },
    targetSelectors: {
      type: "array",
      minItems: 1,
      items: { type: "string" },
    },
    exclusionSelectors: {
      type: "array",
      items: { type: "string" },
    },
    intervalHours: { enum: [6, 12, 24, 48, 72], type: "integer" },
    labels: { type: "array", items: { type: "string", minLength: 1 }, uniqueItems: true },
  },
} as const;

export const monitorUpdateRequestSchemaV1 = {
  ...monitorCreateRequestSchemaV1,
  $id: "MonitorUpdateRequestV1",
  properties: { ...monitorCreateRequestSchemaV1.properties, resetHistory: { type: "boolean" } },
} as const;

export const monitorDeleteRequestSchemaV1 = {
  $id: "MonitorDeleteRequestV1", type: "object", additionalProperties: false,
  required: ["confirmName"], properties: { confirmName: { type: "string" } },
} as const;

const snapshotMetadataProperties = {
  id: { type: "integer", minimum: 1 },
  formatVersion: { const: 1, type: "integer" },
  sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
} as const;

const telegramDeliveryObjectSchema = {
  type: "object", additionalProperties: false, required: ["state", "failureReason"], properties: {
    state: { enum: ["pending", "sending", "delivered", "unavailable", "permanent", "temporary", "timeout", "abandoned"], type: "string" },
    failureReason: { type: ["string", "null"] },
  },
} as const;
const telegramDeliverySchema = {
  anyOf: [telegramDeliveryObjectSchema, { type: "null" }],
} as const;

const checkProperties = {
  id: { type: "integer", minimum: 1 },
  kind: {
    enum: ["scheduled", "overdue", "manual", "retry"],
    type: "string",
  },
  status: { enum: ["running", "succeeded", "failed"], type: "string" },
  result: {
    enum: ["baseline", "no_change", "change", "error", null],
    type: ["string", "null"],
  },
  startedAt: { type: "string", format: "date-time" },
  completedAt: { type: ["string", "null"], format: "date-time" },
  errorCode: { type: ["string", "null"] },
  errorMessage: { type: ["string", "null"] },
  beforeSnapshotId: { type: ["integer", "null"], minimum: 1 },
  afterSnapshotId: { type: ["integer", "null"], minimum: 1 },
  isFinalError: { type: "boolean" },
  telegram: telegramDeliverySchema,
  snapshot: {
    anyOf: [
      {
        type: "object",
        additionalProperties: false,
        required: ["id", "formatVersion", "sha256"],
        properties: snapshotMetadataProperties,
      },
      { type: "null" },
    ],
  },
} as const;

export const monitorCheckSchemaV1 = {
  $id: "MonitorCheckV1",
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "kind",
    "status",
    "result",
    "startedAt",
    "completedAt",
    "errorCode",
    "errorMessage",
    "beforeSnapshotId",
    "afterSnapshotId",
    "isFinalError",
    "snapshot",
    "telegram",
  ],
  properties: checkProperties,
} as const;

export const checkIntentSchemaV1 = {
  $id: "CheckIntentV1",
  type: "object",
  additionalProperties: false,
  required: [
    "id", "monitorId", "monitorName", "scopeRevision", "kind", "state",
    "dueAt", "createdAt", "startedAt", "finishedAt",
  ],
  properties: {
    id: { type: "integer", minimum: 1 },
    monitorId: { type: "integer", minimum: 1 },
    monitorName: { type: "string" },
    scopeRevision: { type: "integer", minimum: 1 },
    kind: checkProperties.kind,
    state: { enum: ["queued", "running"], type: "string" },
    dueAt: { type: "string", format: "date-time" },
    createdAt: { type: "string", format: "date-time" },
    startedAt: { type: ["string", "null"], format: "date-time" },
    finishedAt: { type: ["string", "null"], format: "date-time" },
  },
} as const;

export const checkIntentListResponseSchemaV1 = {
  $id: "CheckIntentListResponseV1",
  type: "array",
  items: { $ref: "CheckIntentV1#" },
} as const;

export const notificationEventSchemaV1 = {
  $id: "NotificationEventV1", type: "object", additionalProperties: false,
  required: ["id", "kind", "centerVisible", "monitorId", "monitorName", "url", "scopeRevision", "checkId", "chainCheckId", "title", "body", "observedAt", "targetPath", "dedupeKey", "telegram"],
  properties: {
    id: { type: "integer", minimum: 1 },
    kind: { enum: ["change_detected", "check_failed_final", "control_check_ok"], type: "string" },
    centerVisible: { type: "boolean" },
    monitorId: { type: "integer", minimum: 1 }, monitorName: { type: "string" },
    url: { type: "string" },
    scopeRevision: { type: "integer", minimum: 1 }, checkId: { type: "integer", minimum: 1 },
    chainCheckId: { type: "integer", minimum: 1 }, title: { type: "string" }, body: { type: "string" },
    observedAt: { type: "string", format: "date-time" }, targetPath: { type: "string" }, dedupeKey: { type: "string" },
    telegram: telegramDeliveryObjectSchema,
  },
} as const;

export const notificationFeedSchemaV1 = {
  $id: "NotificationFeedV1", type: "object", additionalProperties: false,
  required: ["highWaterMark", "items"], properties: {
    highWaterMark: { type: "integer", minimum: 0 },
    items: { type: "array", items: { $ref: "NotificationEventV1#" } },
  },
} as const;

const activeIntentSchema = {
  anyOf: [{ $ref: "CheckIntentV1#" }, { type: "null" }],
} as const;

const monitorSummaryProperties = {
  id: { type: "integer", minimum: 1 },
  name: { type: "string" },
  url: { type: "string" },
  intervalHours: { enum: [6, 12, 24, 48, 72], type: "integer" },
  scopeRevision: { type: "integer", minimum: 1 },
  nextCheckAt: { type: ["string", "null"], format: "date-time" },
  latestCheckResult: {
    enum: ["baseline", "no_change", "change", "error", null],
    type: ["string", "null"],
  },
  paused: { type: "boolean" },
  activeIntent: activeIntentSchema,
  labels: { type: "array", items: { type: "string" } },
} as const;

export const monitorSummarySchemaV1 = {
  $id: "MonitorSummaryV1",
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "name",
    "url",
    "intervalHours",
    "scopeRevision",
    "nextCheckAt",
    "latestCheckResult",
    "paused",
    "activeIntent",
    "labels",
  ],
  properties: monitorSummaryProperties,
} as const;

export const monitorListResponseSchemaV1 = {
  $id: "MonitorListResponseV1",
  type: "array",
  items: { $ref: "MonitorSummaryV1#" },
} as const;

export const monitorDetailSchemaV1 = {
  $id: "MonitorDetailV1",
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "name",
    "url",
    "targetSelectors",
    "exclusionSelectors",
    "intervalHours",
    "scopeRevision",
    "nextCheckAt",
    "paused",
    "activeIntent",
    "history",
    "labels",
  ],
  properties: {
    id: monitorSummaryProperties.id,
    name: monitorSummaryProperties.name,
    url: monitorSummaryProperties.url,
    targetSelectors: { type: "array", items: { type: "string" } },
    exclusionSelectors: { type: "array", items: { type: "string" } },
    labels: monitorSummaryProperties.labels,
    intervalHours: monitorSummaryProperties.intervalHours,
    scopeRevision: monitorSummaryProperties.scopeRevision,
    nextCheckAt: monitorSummaryProperties.nextCheckAt,
    paused: monitorSummaryProperties.paused,
    activeIntent: monitorSummaryProperties.activeIntent,
    history: { type: "array", items: { $ref: "MonitorCheckV1#" } },
  },
} as const;

export const monitorCheckListResponseSchemaV1 = {
  $id: "MonitorCheckListResponseV1",
  type: "array",
  items: { $ref: "MonitorCheckV1#" },
} as const;

export const journalCheckSchemaV1 = {
  $id: "JournalCheckV1",
  type: "object",
  additionalProperties: false,
  required: [
    "id", "monitorId", "monitorName", "url", "kind", "status", "result",
    "startedAt", "completedAt", "errorCode", "errorMessage",
    "beforeSnapshotId", "afterSnapshotId",
    "isFinalError",
    "telegram",
  ],
  properties: {
    id: checkProperties.id,
    monitorId: { type: "integer", minimum: 1 },
    monitorName: { type: "string" },
    url: { type: "string", format: "uri" },
    kind: checkProperties.kind,
    status: checkProperties.status,
    result: checkProperties.result,
    startedAt: checkProperties.startedAt,
    completedAt: checkProperties.completedAt,
    errorCode: checkProperties.errorCode,
    errorMessage: checkProperties.errorMessage,
    beforeSnapshotId: checkProperties.beforeSnapshotId,
    afterSnapshotId: checkProperties.afterSnapshotId,
    isFinalError: checkProperties.isFinalError,
    telegram: checkProperties.telegram,
  },
} as const;

export const notificationSettingsSchemaV1 = {
  $id: "NotificationSettingsV1", type: "object", additionalProperties: false,
  required: ["notifyWhenUnchanged"], properties: { notifyWhenUnchanged: { type: "boolean" } },
} as const;

export const journalResponseSchemaV1 = {
  $id: "JournalResponseV1",
  type: "array",
  items: { $ref: "JournalCheckV1#" },
} as const;

const diffRowSchema = {
  type: "object",
  additionalProperties: false,
  required: ["kind", "before", "after"],
  properties: {
    kind: {
      enum: ["equal", "replace", "delete", "insert", "omitted"],
      type: "string",
    },
    before: { type: ["string", "null"] },
    after: { type: ["string", "null"] },
    omittedBefore: { type: "integer", minimum: 0 },
    omittedAfter: { type: "integer", minimum: 0 },
  },
} as const;

export const comparisonResponseSchemaV1 = {
  $id: "ComparisonResponseV1",
  type: "object",
  additionalProperties: false,
  required: [
    "checkId", "monitorId", "monitorName", "beforeSnapshotId",
    "afterSnapshotId", "complete", "targets",
  ],
  properties: {
    checkId: { type: "integer", minimum: 1 },
    monitorId: { type: "integer", minimum: 1 },
    monitorName: { type: "string" },
    beforeSnapshotId: { type: "integer", minimum: 1 },
    afterSnapshotId: { type: "integer", minimum: 1 },
    complete: { type: "boolean" },
    targets: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "structure", "text"],
        properties: {
          kind: {
            enum: ["equal", "replace", "delete", "insert"],
            type: "string",
          },
          structure: { type: "array", items: diffRowSchema },
          text: { type: "array", items: diffRowSchema },
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

const monitorIdParams = {
  type: "object",
  additionalProperties: false,
  required: ["monitorId"],
  properties: {
    monitorId: { type: "integer", minimum: 1 },
  },
} as const;

const checkIdParams = {
  type: "object",
  additionalProperties: false,
  required: ["checkId"],
  properties: { checkId: { type: "integer", minimum: 1 } },
} as const;

export const createMonitorRouteSchema: FastifySchema = {
  operationId: "createMonitor",
  summary: "Создать Монитор и Базовый снимок",
  body: { $ref: "MonitorCreateRequestV1#" },
  response: {
    201: { $ref: "MonitorDetailV1#" },
    400: { $ref: "ApiErrorV1#" },
    422: { $ref: "ApiErrorV1#" },
    502: { $ref: "ApiErrorV1#" },
    504: { $ref: "ApiErrorV1#" },
    ...commonErrors,
  },
};

export const listMonitorsRouteSchema: FastifySchema = {
  operationId: "listMonitors",
  summary: "Получить Мониторы",
  querystring: { type: "object", additionalProperties: false, properties: { label: { type: "string" } } },
  response: {
    200: { $ref: "MonitorListResponseV1#" },
    ...commonErrors,
  },
};

export const updateMonitorRouteSchema: FastifySchema = {
  operationId: "updateMonitor", summary: "Изменить Монитор",
  params: monitorIdParams, body: { $ref: "MonitorUpdateRequestV1#" },
  response: { 200: { $ref: "MonitorDetailV1#" }, 400: { $ref: "ApiErrorV1#" }, 404: { $ref: "ApiErrorV1#" }, 409: { $ref: "ApiErrorV1#" }, 422: { $ref: "ApiErrorV1#" }, 502: { $ref: "ApiErrorV1#" }, 504: { $ref: "ApiErrorV1#" }, ...commonErrors },
};

export const deleteMonitorRouteSchema: FastifySchema = {
  operationId: "deleteMonitor", summary: "Удалить Монитор и его данные",
  params: monitorIdParams, body: { $ref: "MonitorDeleteRequestV1#" },
  response: { 204: { type: "null" }, 400: { $ref: "ApiErrorV1#" }, 404: { $ref: "ApiErrorV1#" }, ...commonErrors },
};

export const getMonitorRouteSchema: FastifySchema = {
  operationId: "getMonitor",
  summary: "Получить Монитор и его Историю",
  params: monitorIdParams,
  response: {
    200: { $ref: "MonitorDetailV1#" },
    404: { $ref: "ApiErrorV1#" },
    ...commonErrors,
  },
};

export const listMonitorChecksRouteSchema: FastifySchema = {
  operationId: "listMonitorChecks",
  summary: "Получить Проверки Монитора",
  params: monitorIdParams,
  response: {
    200: { $ref: "MonitorCheckListResponseV1#" },
    404: { $ref: "ApiErrorV1#" },
    ...commonErrors,
  },
};

export const requestManualCheckRouteSchema: FastifySchema = {
  operationId: "requestManualCheck",
  summary: "Запустить Ручную проверку Монитора",
  params: monitorIdParams,
  response: {
    200: { $ref: "MonitorDetailV1#" },
    404: { $ref: "ApiErrorV1#" },
    ...commonErrors,
  },
};

export const pauseMonitorRouteSchema: FastifySchema = {
  operationId: "pauseMonitor",
  summary: "Приостановить автоматические Проверки Монитора",
  params: monitorIdParams,
  response: {
    200: { $ref: "MonitorDetailV1#" },
    404: { $ref: "ApiErrorV1#" },
    ...commonErrors,
  },
};

export const resumeMonitorRouteSchema: FastifySchema = {
  operationId: "resumeMonitor",
  summary: "Возобновить автоматические Проверки Монитора",
  params: monitorIdParams,
  response: {
    200: { $ref: "MonitorDetailV1#" },
    404: { $ref: "ApiErrorV1#" },
    ...commonErrors,
  },
};

export const listJournalRouteSchema: FastifySchema = {
  operationId: "listJournal",
  summary: "Получить общий Журнал Проверок",
  response: {
    200: { $ref: "JournalResponseV1#" },
    ...commonErrors,
  },
};

export const listCheckIntentsRouteSchema: FastifySchema = {
  operationId: "listCheckIntents",
  summary: "Получить активную очередь Проверок",
  response: {
    200: { $ref: "CheckIntentListResponseV1#" },
    ...commonErrors,
  },
};

const notificationAfterQuery = { type: "object", additionalProperties: false, properties: { after: { type: "integer", minimum: 0 } } } as const;

export const listNotificationsRouteSchema: FastifySchema = {
  operationId: "listNotifications", summary: "Получить долговечные Уведомления после high-water mark",
  querystring: notificationAfterQuery,
  response: { 200: { $ref: "NotificationFeedV1#" }, ...commonErrors },
};

export const streamNotificationsRouteSchema: FastifySchema = {
  operationId: "streamNotifications", summary: "Подключиться к потоку новых Уведомлений",
  querystring: notificationAfterQuery,
  response: { 200: { type: "string", description: "Server-Sent Events с id и JSON data" }, 400: { $ref: "ApiErrorV1#" }, ...commonErrors },
};

export const getTelegramStateRouteSchema: FastifySchema = {
  operationId: "getTelegramState", summary: "Получить доступность Telegram",
  response: { 200: { $ref: "TelegramStateV1#" }, ...commonErrors },
};
export const recheckTelegramRouteSchema: FastifySchema = {
  operationId: "recheckTelegram", summary: "Повторно проверить доступность Telegram",
  response: { 200: { $ref: "TelegramStateV1#" }, ...commonErrors },
};
export const getNotificationSettingsRouteSchema: FastifySchema = {
  operationId: "getNotificationSettings", summary: "Получить настройки Уведомлений",
  response: { 200: { $ref: "NotificationSettingsV1#" }, ...commonErrors },
};
export const updateNotificationSettingsRouteSchema: FastifySchema = {
  operationId: "updateNotificationSettings", summary: "Изменить настройки Уведомлений",
  body: { $ref: "NotificationSettingsV1#" },
  response: { 200: { $ref: "NotificationSettingsV1#" }, 400: { $ref: "ApiErrorV1#" }, ...commonErrors },
};

export const getComparisonRouteSchema: FastifySchema = {
  operationId: "getComparison",
  summary: "Получить Сравнение пары Снимков Проверки",
  params: checkIdParams,
  response: {
    200: { $ref: "ComparisonResponseV1#" },
    404: { $ref: "ApiErrorV1#" },
    ...commonErrors,
  },
};
