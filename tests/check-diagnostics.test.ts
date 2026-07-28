import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import BetterSqlite3 from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createMonitorService } from "../src/server/application/monitor-service.js";
import type { PageProbe } from "../src/server/application/page-probe.js";
import { buildHttpServer } from "../src/server/http/server.js";
import { openApplicationDatabase } from "../src/server/persistence/database.js";
import { createHttpTestContext } from "./support/http-test-context.js";
import {
  simplePagePreviewTargets,
  successfulPageProbeResult,
} from "./support/page-probe.js";

describe("Check Diagnostics HTTP workflow", () => {
  const context = createHttpTestContext();
  const headers = { host: "127.0.0.1:43117" };

  afterEach(async () => {
    await context.cleanup();
  });

  it("captures a safe failed-Check diagnostic and exposes it by checkId", async () => {
    const baseline = successfulPageProbeResult(
      "https://example.com/catalog",
      [{ selector: ".card", matchCount: 1 }],
      simplePagePreviewTargets("Product"),
    );
    const preview = vi
      .fn<PageProbe["preview"]>()
      .mockResolvedValueOnce(baseline)
      .mockResolvedValueOnce({
        ok: false,
        code: "http_error",
        message: "Страница вернула ошибку HTTP.",
        stage: "navigation",
        finalUrl:
          "https://account:secret@example.com/sign-in?token=private#details",
        httpStatus: 503,
        timings: {
          totalMs: 1_250,
          navigationMs: 1_000,
          targetMs: 100,
          scrollMs: 50,
          stabilityMs: 75,
          extractionMs: 25,
        },
        field: "targetSelectors",
        index: 0,
      });
    const server = await context.applicationServer({
      pageProbe: { preview },
    });

    const created = await server.inject({
      method: "POST",
      url: "/api/monitors",
      headers,
      payload: {
        name: "Catalog",
        url: "https://example.com/catalog",
        targetSelectors: [".card"],
        exclusionSelectors: [],
        intervalHours: 6,
      },
    });
    expect(created.statusCode).toBe(201);
    const checkId = created.json<{ history: Array<{ id: number }> }>()
      .history[0]!.id;

    const response = await server.inject({
      method: "GET",
      url: `/api/checks/${checkId}/diagnostics`,
      headers,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      checkId,
      availability: "available",
      diagnostic: {
        checkId,
        recordedAt: expect.any(String),
        stage: "navigation",
        finalUrl: "https://example.com/sign-in",
        httpStatus: 503,
        totalMs: 1_250,
        navigationMs: 1_000,
        targetMs: 100,
        scrollMs: 50,
        stabilityMs: 75,
        extractionMs: 25,
        selectorField: "targetSelectors",
        selectorIndex: 0,
      },
    });
    expect(response.body).not.toContain("secret");
    expect(response.body).not.toContain("private");
  });

  it("distinguishes a successful Check and an unknown checkId", async () => {
    const baseline = successfulPageProbeResult(
      "https://example.com/catalog",
      [{ selector: ".card", matchCount: 1 }],
      simplePagePreviewTargets("Product"),
    );
    const server = await context.applicationServer({
      pageProbe: { preview: vi.fn().mockResolvedValue(baseline) },
    });
    const created = await server.inject({
      method: "POST",
      url: "/api/monitors",
      headers,
      payload: {
        name: "Catalog",
        url: "https://example.com/catalog",
        targetSelectors: [".card"],
        exclusionSelectors: [],
        intervalHours: 6,
      },
    });
    const checkId = created.json<{ history: Array<{ id: number }> }>()
      .history[0]!.id;

    const successful = await server.inject({
      method: "GET",
      url: `/api/checks/${checkId}/diagnostics`,
      headers,
    });
    expect(successful.json()).toEqual({
      checkId,
      availability: "not_applicable",
      diagnostic: null,
    });

    const unknown = await server.inject({
      method: "GET",
      url: "/api/checks/999999/diagnostics",
      headers,
    });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toEqual({
      error: {
        code: "not_found",
        message: "Проверка не найдена.",
      },
    });
  });

  it("keeps the failed Check and returns unavailable when diagnostic persistence fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "check-diagnostic-failure-"));
    const database = openApplicationDatabase({ rootDirectory: root });
    const events: Array<{ event: string; values?: Record<string, unknown> }> = [];
    const baseline = successfulPageProbeResult(
      "https://example.com/catalog",
      [{ selector: ".card", matchCount: 1 }],
      simplePagePreviewTargets("Product"),
    );
    const failure = {
      ok: false as const,
      code: "navigation_timeout" as const,
      message: "Страница не ответила.",
      stage: "navigation" as const,
      timings: {
        totalMs: 60_000,
        navigationMs: 60_000,
        targetMs: 0,
        scrollMs: 0,
        stabilityMs: 0,
        extractionMs: 0,
      },
    };
    const preview = vi
      .fn<PageProbe["preview"]>()
      .mockResolvedValueOnce(baseline)
      .mockResolvedValueOnce(failure);
    const persistDiagnostic =
      database.monitors.recordCheckDiagnostic.bind(database.monitors);
    database.monitors.recordCheckDiagnostic = () => {
      throw new Error("forced diagnostic failure");
    };
    const server = buildHttpServer({
      database,
      version: "0.1.0",
      port: 43118,
      pageProbe: { preview },
      logger: {
        write(event, values) {
          events.push({ event, ...(values === undefined ? {} : { values }) });
        },
      },
    });
    const localHeaders = { host: "127.0.0.1:43118" };

    try {
      const created = await server.inject({
        method: "POST",
        url: "/api/monitors",
        headers: localHeaders,
        payload: {
          name: "Catalog",
          url: "https://example.com/catalog",
          targetSelectors: [".card"],
          exclusionSelectors: [],
          intervalHours: 6,
        },
      });
      const check = created.json<{
        history: Array<{ id: number; result: string }>;
      }>().history[0]!;
      expect(check.result).toBe("error");

      const diagnostic = await server.inject({
        method: "GET",
        url: `/api/checks/${check.id}/diagnostics`,
        headers: localHeaders,
      });
      expect(diagnostic.json()).toEqual({
        checkId: check.id,
        availability: "unavailable",
        diagnostic: null,
      });
      expect(events).toContainEqual({
        event: "check_diagnostic_failed",
        values: {
          checkId: check.id,
          stage: "persistence",
          message: "Check diagnostic was unavailable.",
        },
      });

      database.monitors.recordCheckDiagnostic = persistDiagnostic;
      persistDiagnostic(check.id, {
        recordedAt: new Date().toISOString(),
        stage: "navigation",
        finalUrl:
          "https://account:secret@example.com/path?token=private#fragment",
        totalMs: 10,
      });
      const sanitized = await server.inject({
        method: "GET",
        url: `/api/checks/${check.id}/diagnostics`,
        headers: localHeaders,
      });
      expect(sanitized.json()).toMatchObject({
        availability: "available",
        diagnostic: { finalUrl: "https://example.com/path" },
      });
      expect(sanitized.body).not.toContain("secret");
      expect(sanitized.body).not.toContain("private");
    } finally {
      await server.close();
      database.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("isolates projection and fallback-logging failures from retry scheduling", async () => {
    const root = await mkdtemp(join(tmpdir(), "check-diagnostic-projection-"));
    const database = openApplicationDatabase({ rootDirectory: root });
    const baseline = successfulPageProbeResult(
      "https://example.com/catalog",
      [{ selector: ".card", matchCount: 1 }],
      simplePagePreviewTargets("Product"),
    );
    const preview = vi
      .fn<PageProbe["preview"]>()
      .mockResolvedValueOnce(baseline)
      .mockResolvedValueOnce({
        ok: false,
        code: "navigation_timeout",
        message: "Страница не ответила.",
        stage: "navigation",
        timings: {
          totalMs: Number.NaN,
          navigationMs: 0,
          targetMs: 0,
          scrollMs: 0,
          stabilityMs: 0,
          extractionMs: 0,
        },
      });
    const server = buildHttpServer({
      database,
      version: "0.1.0",
      port: 43119,
      pageProbe: { preview },
      logger: {
        write() {
          throw new Error("forced logger failure");
        },
      },
    });
    const localHeaders = { host: "127.0.0.1:43119" };

    try {
      const created = await server.inject({
        method: "POST",
        url: "/api/monitors",
        headers: localHeaders,
        payload: {
          name: "Catalog",
          url: "https://example.com/catalog",
          targetSelectors: [".card"],
          exclusionSelectors: [],
          intervalHours: 6,
        },
      });
      const monitor = created.json<{
        history: Array<{ id: number; result: string }>;
        activeIntent: { kind: string; state: string };
      }>();
      expect(monitor.history[0]!.result).toBe("error");
      expect(monitor.activeIntent).toMatchObject({
        kind: "retry",
        state: "queued",
      });
      const diagnostic = await server.inject({
        method: "GET",
        url: `/api/checks/${monitor.history[0]!.id}/diagnostics`,
        headers: localHeaders,
      });
      expect(diagnostic.json()).toMatchObject({
        availability: "unavailable",
        diagnostic: null,
      });
    } finally {
      await server.close();
      database.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("persists no diagnostics for baseline, no-change, or change results", async () => {
    const root = await mkdtemp(join(tmpdir(), "successful-check-diagnostics-"));
    const database = openApplicationDatabase({ rootDirectory: root });
    const baseline = successfulPageProbeResult(
      "https://example.com/catalog",
      [{ selector: ".card", matchCount: 1 }],
      simplePagePreviewTargets("A"),
    );
    const changed = successfulPageProbeResult(
      "https://example.com/catalog",
      [{ selector: ".card", matchCount: 1 }],
      simplePagePreviewTargets("B"),
    );
    const preview = vi
      .fn<PageProbe["preview"]>()
      .mockResolvedValueOnce(baseline)
      .mockResolvedValueOnce(baseline)
      .mockResolvedValueOnce(baseline)
      .mockResolvedValueOnce(changed);
    const service = createMonitorService({
      database,
      pageProbe: { preview },
    });

    try {
      const monitor = await service.createMonitor({
        name: "Catalog",
        url: "https://example.com/catalog",
        targetSelectors: [".card"],
        exclusionSelectors: [],
        intervalHours: 6,
      });
      await service.requestManualCheck(monitor.id);
      const completed = await service.requestManualCheck(monitor.id);
      expect(completed!.history.map((check) => check.result)).toEqual([
        "change",
        "no_change",
        "baseline",
      ]);
      for (const check of completed!.history) {
        database.monitors.recordCheckDiagnostic(check.id, {
          recordedAt: new Date().toISOString(),
          stage: "application",
          totalMs: 1,
        });
      }
      const inspection = new BetterSqlite3(database.path, { readonly: true });
      try {
        expect(
          inspection.prepare(
            "SELECT COUNT(*) count FROM check_diagnostics",
          ).get(),
        ).toEqual({ count: 0 });
      } finally {
        inspection.close();
      }
    } finally {
      database.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps final notifications and worker progress when projection and logging fail", async () => {
    const root = await mkdtemp(join(tmpdir(), "diagnostic-worker-isolation-"));
    const database = openApplicationDatabase({ rootDirectory: root });
    const baseline = successfulPageProbeResult(
      "https://example.com/catalog",
      [{ selector: ".card", matchCount: 1 }],
      simplePagePreviewTargets("A"),
    );
    const invalidFailure = {
      ok: false as const,
      code: "navigation_timeout" as const,
      message: "Страница не ответила.",
      stage: "navigation" as const,
      timings: {
        totalMs: Number.NaN,
        navigationMs: 0,
        targetMs: 0,
        scrollMs: 0,
        stabilityMs: 0,
        extractionMs: 0,
      },
    };
    const preview = vi
      .fn<PageProbe["preview"]>()
      .mockResolvedValueOnce(baseline)
      .mockResolvedValueOnce(baseline)
      .mockResolvedValueOnce(invalidFailure)
      .mockResolvedValueOnce(invalidFailure)
      .mockResolvedValueOnce(baseline);
    let now = new Date("2026-07-29T08:00:00.000Z");
    const service = createMonitorService({
      database,
      pageProbe: { preview },
      clock: { now: () => now },
      logger: {
        write() {
          throw new Error("forced logger failure");
        },
      },
    });

    try {
      const monitor = await service.createMonitor({
        name: "Catalog",
        url: "https://example.com/catalog",
        targetSelectors: [".card"],
        exclusionSelectors: [],
        intervalHours: 6,
      });
      await service.requestManualCheck(monitor.id);
      now = new Date("2026-07-29T08:01:00.000Z");
      await service.runAvailableChecks();

      expect(service.listNotifications().items).toEqual([
        expect.objectContaining({
          kind: "check_failed_final",
          monitorName: "Catalog",
        }),
      ]);

      const progressed = await service.requestManualCheck(monitor.id);
      expect(progressed!.history[0]).toMatchObject({
        result: "no_change",
      });
      expect(progressed!.history.slice(1, 3)).toEqual([
        expect.objectContaining({ result: "error", isFinalError: true }),
        expect.objectContaining({ result: "error", isFinalError: false }),
      ]);
    } finally {
      database.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not block startup recovery when interrupted-Check diagnostics cannot be inserted", async () => {
    const root = await mkdtemp(join(tmpdir(), "diagnostic-recovery-isolation-"));
    const database = openApplicationDatabase({ rootDirectory: root });
    const monitorId = database.monitors.createMonitor({
      name: "Catalog",
      url: "https://example.com/catalog",
      targetSelectors: [".card"],
      exclusionSelectors: [],
      intervalHours: 6,
    }, "2026-07-29T08:00:00.000Z");
    expect(
      database.monitors.claimNextCheck("2026-07-29T08:00:00.000Z"),
    ).toBeDefined();
    database.close();

    const reopened = openApplicationDatabase({ rootDirectory: root });
    const sabotage = new BetterSqlite3(reopened.path);
    sabotage.exec(`
      CREATE TRIGGER reject_check_diagnostics
      BEFORE INSERT ON check_diagnostics
      BEGIN
        SELECT RAISE(ABORT, 'forced diagnostic failure');
      END;
    `);
    sabotage.close();
    const service = createMonitorService({
      database: reopened,
      pageProbe: { preview: vi.fn() },
      clock: { now: () => new Date("2026-07-29T08:05:00.000Z") },
    });

    try {
      await expect(service.runAvailableChecks()).resolves.toBeUndefined();
      const recovered = service.getMonitor(monitorId)!;
      expect(recovered).toMatchObject({
        activeIntent: { kind: "retry", state: "queued" },
        history: [{
          result: "error",
          errorCode: "application_shutdown",
        }],
      });
      expect(
        service.getCheckDiagnostic(recovered.history[0]!.id),
      ).toMatchObject({
        availability: "unavailable",
        diagnostic: null,
      });
    } finally {
      reopened.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
