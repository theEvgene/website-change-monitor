export const checkDiagnosticStages = [
  "setup",
  "validation",
  "navigation",
  "target",
  "scroll",
  "stability",
  "extraction",
  "snapshot",
  "application",
] as const;

export type CheckDiagnosticStage = (typeof checkDiagnosticStages)[number];

export interface CheckDiagnosticInput {
  recordedAt: string;
  stage: CheckDiagnosticStage;
  finalUrl?: string;
  httpStatus?: number;
  totalMs: number;
  navigationMs?: number;
  targetMs?: number;
  scrollMs?: number;
  stabilityMs?: number;
  extractionMs?: number;
  selectorField?: "targetSelectors" | "exclusionSelectors";
  selectorIndex?: number;
}

const maximumTimingMs = 24 * 60 * 60 * 1_000;
const maximumUrlLength = 2_048;

export function normalizeCheckDiagnostic(
  input: CheckDiagnosticInput,
): CheckDiagnosticInput {
  if (!checkDiagnosticStages.includes(input.stage)) {
    throw new Error("Invalid diagnostic stage");
  }
  const recordedAt = new Date(input.recordedAt);
  if (
    !Number.isFinite(recordedAt.getTime()) ||
    recordedAt.toISOString() !== input.recordedAt
  ) {
    throw new Error("Invalid diagnostic timestamp");
  }
  const totalMs = requiredTiming(input.totalMs);
  const finalUrl = safeFinalUrl(input.finalUrl);
  const httpStatus = validHttpStatus(input.httpStatus)
    ? input.httpStatus
    : undefined;
  const selectorField =
    (input.selectorField === "targetSelectors" ||
      input.selectorField === "exclusionSelectors") &&
    Number.isSafeInteger(input.selectorIndex) &&
    input.selectorIndex! >= 0
      ? input.selectorField
      : undefined;
  const selectorIndex =
    selectorField === undefined ? undefined : input.selectorIndex;

  return {
    recordedAt: input.recordedAt,
    stage: input.stage,
    totalMs,
    ...optional("finalUrl", finalUrl),
    ...optional("httpStatus", httpStatus),
    ...optional("navigationMs", optionalTiming(input.navigationMs)),
    ...optional("targetMs", optionalTiming(input.targetMs)),
    ...optional("scrollMs", optionalTiming(input.scrollMs)),
    ...optional("stabilityMs", optionalTiming(input.stabilityMs)),
    ...optional("extractionMs", optionalTiming(input.extractionMs)),
    ...optional("selectorField", selectorField),
    ...optional("selectorIndex", selectorIndex),
  };
}

function requiredTiming(value: number): number {
  const normalized = optionalTiming(value);
  if (normalized === undefined) {
    throw new Error("Invalid total diagnostic timing");
  }
  return normalized;
}

function optionalTiming(value: number | undefined): number | undefined {
  return value !== undefined &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= maximumTimingMs
    ? value
    : undefined;
}

function validHttpStatus(value: number | undefined): value is number {
  return value !== undefined &&
    Number.isSafeInteger(value) &&
    value >= 100 &&
    value <= 599;
}

function safeFinalUrl(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    const sanitized = url.toString();
    return sanitized.length <= maximumUrlLength ? sanitized : undefined;
  } catch {
    return undefined;
  }
}

function optional<Key extends string, Value>(
  key: Key,
  value: Value | undefined,
): { [Property in Key]?: Value } {
  return value === undefined
    ? {}
    : { [key]: value } as { [Property in Key]?: Value };
}
