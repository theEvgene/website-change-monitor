import type {
  PagePreview,
  PageProbeFailure,
  PageProbeObservedTimings,
  PageProbeSelectorField,
  PageProbeStage,
} from "./page-probe.js";
import {
  normalizeCheckDiagnostic,
  type CheckDiagnosticInput,
} from "../domain/check-diagnostic.js";

export function diagnosticFromProbeFailure(
  failure: PageProbeFailure,
  recordedAt: string,
): CheckDiagnosticInput {
  return diagnosticFromObservedValues(
    failure.stage,
    failure.timings,
    recordedAt,
    failure.finalUrl,
    failure.httpStatus,
    failure.field,
    failure.index,
  );
}

export function diagnosticFromSnapshotFailure(
  preview: PagePreview,
  recordedAt: string,
): CheckDiagnosticInput {
  return diagnosticFromObservedValues(
    "snapshot",
    preview.timings,
    recordedAt,
    preview.finalUrl,
    preview.httpStatus,
  );
}

function diagnosticFromObservedValues(
  stage: PageProbeStage | "snapshot",
  timings: PageProbeObservedTimings,
  recordedAt: string,
  finalUrl?: string,
  httpStatus?: number,
  selectorField?: PageProbeSelectorField,
  selectorIndex?: number,
): CheckDiagnosticInput {
  return normalizeCheckDiagnostic({
    recordedAt,
    stage,
    totalMs: timings.totalMs,
    ...defined("finalUrl", finalUrl),
    ...defined("httpStatus", httpStatus),
    navigationMs: timings.navigationMs,
    targetMs: timings.targetMs,
    scrollMs: timings.scrollMs,
    stabilityMs: timings.stabilityMs,
    extractionMs: timings.extractionMs,
    ...defined("selectorField", selectorField),
    ...defined("selectorIndex", selectorIndex),
  });
}

function defined<Key extends string, Value>(
  key: Key,
  value: Value | undefined,
): { [Property in Key]?: Value } {
  return value === undefined
    ? {}
    : { [key]: value } as { [Property in Key]?: Value };
}
