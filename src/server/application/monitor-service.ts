import { createHash } from "node:crypto";

import type {
  ApplicationDatabase,
} from "../persistence/database.js";
import type {
  CreateMonitorRecord,
  CheckIntentRecord,
  JournalCheckRecord,
  MonitorRecord,
  MonitorSummaryRecord,
} from "../persistence/monitor-store.js";
import type { PagePreview, PageProbe } from "./page-probe.js";
import { PageProbeError } from "./page-probe.js";
import {
  PreviewInputError,
  previewPage,
  validatePreviewInput,
} from "./preview-page.js";
import {
  compareSnapshots,
  type SnapshotComparison,
} from "./snapshot-comparison.js";

export interface Clock {
  now(): Date;
}

export interface CreateMonitorInput {
  name: string;
  url: string;
  targetSelectors: string[];
  exclusionSelectors: string[];
  intervalHours: number;
}

export type MonitorView = MonitorRecord;
export type MonitorSummary = MonitorSummaryRecord;

export type MonitorInputErrorCode =
  | "invalid_monitor_name"
  | "invalid_interval";

export class MonitorInputError extends Error {
  constructor(
    readonly code: MonitorInputErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "MonitorInputError";
  }
}

export class SnapshotError extends Error {
  constructor(
    readonly code: "snapshot_invalid" | "snapshot_too_large",
    message: string,
  ) {
    super(message);
    this.name = "SnapshotError";
  }
}

export interface MonitorService {
  createMonitor(input: CreateMonitorInput): Promise<MonitorView>;
  requestManualCheck(id: number): Promise<MonitorView | undefined>;
  listMonitors(): MonitorSummary[];
  listJournal(): JournalCheckRecord[];
  listActiveIntents(): CheckIntentRecord[];
  getComparison(id: number):
    | (SnapshotComparison & {
        checkId: number;
        monitorId: number;
        monitorName: string;
        beforeSnapshotId: number;
        afterSnapshotId: number;
      })
    | undefined;
  getMonitor(id: number): MonitorView | undefined;
  runAvailableChecks(): Promise<void>;
}

const intervalHours = new Set([6, 12, 24, 48, 72]);
const snapshotLimits = {
  targets: 1_000,
  elements: 50_000,
  depth: 256,
  textLines: 20_000,
  bytes: 8 * 1024 * 1024,
} as const;

export function createMonitorService(options: {
  database: ApplicationDatabase;
  pageProbe: PageProbe;
  clock?: Clock;
}): MonitorService {
  const clock = options.clock ?? { now: () => new Date() };
  let workerTail: Promise<void> = Promise.resolve();
  let recoverOverdue = true;
  let consecutiveManualChecks = 0;

  async function drainChecks(): Promise<void> {
    const now = clock.now().toISOString();
    options.database.monitors.reconcileSchedule(now, recoverOverdue);
    recoverOverdue = false;
    for (;;) {
      const claimed = options.database.monitors.claimNextCheck(
        clock.now().toISOString(),
        consecutiveManualChecks >= 3,
      );
      if (claimed === undefined) {
        return;
      }
      consecutiveManualChecks =
        claimed.kind === "manual" ? consecutiveManualChecks + 1 : 0;
      const result = await options.pageProbe.preview({
        url: claimed.url,
        targetSelectors: claimed.targetSelectors,
        exclusionSelectors: claimed.exclusionSelectors,
      });
      const completedAt = clock.now();
      const nextCheckAt = new Date(
        completedAt.getTime() + claimed.intervalHours * 60 * 60 * 1_000,
      ).toISOString();
      if (!result.ok) {
        options.database.monitors.failCheck(
          claimed,
          { code: result.code, message: result.message },
          completedAt.toISOString(),
          nextCheckAt,
        );
        continue;
      }
      try {
        const snapshot = createSnapshot(result.preview);
        if (claimed.currentSnapshot === null) {
          options.database.monitors.completeBaseline(
            claimed,
            snapshot,
            completedAt.toISOString(),
            nextCheckAt,
          );
        } else {
          if (claimed.currentSnapshot.formatVersion !== snapshot.formatVersion) {
            throw new SnapshotError(
              "snapshot_invalid",
              "Версия сохранённого Снимка не поддерживается.",
            );
          }
          if (
            Buffer.from(claimed.currentSnapshot.canonicalJson, "utf8").equals(
              Buffer.from(snapshot.canonicalJson, "utf8"),
            )
          ) {
            options.database.monitors.completeNoChange(
              claimed,
              completedAt.toISOString(),
              nextCheckAt,
            );
          } else {
            options.database.monitors.completeChange(
              claimed,
              snapshot,
              completedAt.toISOString(),
              nextCheckAt,
            );
          }
        }
      } catch (error: unknown) {
        const failure =
          error instanceof SnapshotError
            ? error
            : new SnapshotError(
                "snapshot_invalid",
                "Не удалось сформировать Базовый снимок.",
              );
        options.database.monitors.failCheck(
          claimed,
          { code: failure.code, message: failure.message },
          completedAt.toISOString(),
          nextCheckAt,
        );
      }
    }
  }

  function runAvailableChecks(): Promise<void> {
    const run = workerTail.then(drainChecks);
    workerTail = run.catch(() => undefined);
    return run;
  }

  return {
    async createMonitor(input) {
      const validated = validateMonitorInput(input);
      await previewPage(validated, options.pageProbe);
      const monitorId = options.database.monitors.createMonitor(
        validated,
        clock.now().toISOString(),
      );
      await runAvailableChecks();
      const monitor = options.database.monitors.getMonitor(monitorId);
      if (monitor === undefined) {
        throw new Error("Created Monitor is missing");
      }
      return monitor;
    },
    async requestManualCheck(id) {
      const enqueued = options.database.monitors.enqueueManualCheck(
        id,
        clock.now().toISOString(),
      );
      if (enqueued === undefined) {
        return undefined;
      }
      await runAvailableChecks();
      return options.database.monitors.getMonitor(id);
    },
    listMonitors: () => options.database.monitors.listMonitors(),
    listJournal: () => options.database.monitors.listJournal(),
    listActiveIntents: () => options.database.monitors.listActiveIntents(),
    getComparison(id) {
      const pair = options.database.monitors.getComparison(id);
      if (pair === undefined) return undefined;
      const comparison = compareSnapshots(
        pair.beforeCanonicalJson,
        pair.afterCanonicalJson,
      );
      return {
        checkId: pair.checkId,
        monitorId: pair.monitorId,
        monitorName: pair.monitorName,
        beforeSnapshotId: pair.beforeSnapshotId,
        afterSnapshotId: pair.afterSnapshotId,
        ...comparison,
      };
    },
    getMonitor: (id) => options.database.monitors.getMonitor(id),
    runAvailableChecks,
  };
}

function validateMonitorInput(input: CreateMonitorInput): CreateMonitorRecord {
  const name = input.name.trim();
  if (name === "") {
    throw new MonitorInputError(
      "invalid_monitor_name",
      "Введите имя Монитора.",
    );
  }
  if (!intervalHours.has(input.intervalHours)) {
    throw new MonitorInputError(
      "invalid_interval",
      "Выберите Интервал проверки 6, 12, 24, 48 или 72 часа.",
    );
  }
  const previewInput = validatePreviewInput(input);
  return {
    name,
    ...previewInput,
    intervalHours: input.intervalHours as CreateMonitorRecord["intervalHours"],
  };
}

function createSnapshot(preview: PagePreview): {
  formatVersion: number;
  sha256: string;
  canonicalJson: string;
} {
  if (preview.targets.length === 0) {
    throw new SnapshotError(
      "snapshot_invalid",
      "Целевая область не может быть пустой.",
    );
  }
  if (preview.targets.length > snapshotLimits.targets) {
    throw tooLarge();
  }
  let elementCount = 0;
  let textLineCount = 0;
  const targets = preview.targets.map((target) => {
    elementCount += target.elements.length;
    if (elementCount > snapshotLimits.elements) {
      throw tooLarge();
    }
    validateElementTree(target.elements);
    const visibleText = normalizeText(target.visibleText);
    textLineCount += visibleText === "" ? 0 : 1 + countNewlines(visibleText);
    if (textLineCount > snapshotLimits.textLines) {
      throw tooLarge();
    }
    return {
      elements: target.elements.map((element) => {
        assertWellFormed(element.name);
        if (element.namespace !== null) {
          assertWellFormed(element.namespace);
        }
        return {
          namespace: element.namespace,
          name: element.name,
          childElementCount: element.childElementCount,
        };
      }),
      visibleText,
    };
  });
  const canonicalJson = canonicalize({ formatVersion: 1, targets });
  const bytes = Buffer.from(canonicalJson, "utf8");
  if (bytes.byteLength > snapshotLimits.bytes) {
    throw tooLarge();
  }
  return {
    formatVersion: 1,
    canonicalJson,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

function validateElementTree(
  elements: PagePreview["targets"][number]["elements"],
): void {
  if (elements.length === 0) {
    throw new SnapshotError(
      "snapshot_invalid",
      "Структура цели не может быть пустой.",
    );
  }
  const remainingChildren: number[] = [];
  for (const [index, element] of elements.entries()) {
    while (remainingChildren.at(-1) === 0) {
      remainingChildren.pop();
    }
    if (index > 0) {
      if (remainingChildren.length === 0) {
        throw invalidTree();
      }
      remainingChildren[remainingChildren.length - 1]! -= 1;
    }
    const depth = remainingChildren.length + 1;
    if (depth > snapshotLimits.depth) {
      throw tooLarge();
    }
    if (
      !Number.isSafeInteger(element.childElementCount) ||
      element.childElementCount < 0
    ) {
      throw invalidTree();
    }
    remainingChildren.push(element.childElementCount);
  }
  while (remainingChildren.at(-1) === 0) {
    remainingChildren.pop();
  }
  if (remainingChildren.length !== 0) {
    throw invalidTree();
  }
}

function normalizeText(value: string): string {
  assertWellFormed(value);
  return value.replace(/\r\n?|\u2028|\u2029/gu, "\n").normalize("NFC");
}

function assertWellFormed(value: string): void {
  if (!value.isWellFormed()) {
    throw new SnapshotError(
      "snapshot_invalid",
      "Текст страницы содержит некорректный Unicode.",
    );
  }
}

function countNewlines(value: string): number {
  let count = 0;
  for (const character of value) {
    if (character === "\n") {
      count += 1;
    }
  }
  return count;
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new SnapshotError("snapshot_invalid", "Снимок содержит неверное число.");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`)
      .join(",")}}`;
  }
  throw new SnapshotError("snapshot_invalid", "Снимок содержит неверное значение.");
}

function tooLarge(): SnapshotError {
  return new SnapshotError(
    "snapshot_too_large",
    "Снимок превышает допустимый размер.",
  );
}

function invalidTree(): SnapshotError {
  return new SnapshotError(
    "snapshot_invalid",
    "Структура цели не является корректным preorder-деревом.",
  );
}
