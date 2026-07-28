import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import BetterSqlite3 from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createMonitorService } from "../src/server/application/monitor-service.js";
import { buildHttpServer } from "../src/server/http/server.js";
import {
  defaultNotificationPolicy,
  type MonitorStore,
} from "../src/server/persistence/monitor-store.js";
import {
  openApplicationDatabase,
  type ApplicationDatabase,
} from "../src/server/persistence/database.js";

describe("Check Diagnostic retention", () => {
  const roots: string[] = [];
  const databases: ApplicationDatabase[] = [];

  afterEach(async () => {
    for (const database of databases.splice(0)) database.close();
    for (const root of roots.splice(0)) {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("deletes only diagnostics older than 14 days and repeats after 24 hours", async () => {
    const { database } = await fixture();
    const now = new Date("2026-07-29T12:00:00.000Z");
    const expiredId = failedDiagnostic(
      database.monitors,
      "Expired",
      "2026-07-15T11:59:59.999Z",
    );
    const boundaryId = failedDiagnostic(
      database.monitors,
      "Boundary",
      "2026-07-15T12:00:00.000Z",
    );
    let current = now;
    const service = createMonitorService({
      database,
      pageProbe: { preview: vi.fn() },
      clock: { now: () => current },
    });

    await service.runAvailableChecks();

    expect(service.getCheckDiagnostic(expiredId)).toEqual({
      checkId: expiredId,
      availability: "expired",
      diagnostic: null,
    });
    expect(service.getCheckDiagnostic(boundaryId)).toMatchObject({
      availability: "available",
    });

    current = new Date("2026-07-30T11:59:59.999Z");
    await service.runAvailableChecks();
    expect(service.getCheckDiagnostic(boundaryId)).toMatchObject({
      availability: "available",
    });

    current = new Date("2026-07-30T12:00:00.000Z");
    await service.runAvailableChecks();
    expect(service.getCheckDiagnostic(boundaryId)).toEqual({
      checkId: boundaryId,
      availability: "expired",
      diagnostic: null,
    });
  });

  it("does not block startup and retries cleanup after a bounded failure", async () => {
    const { database } = await fixture();
    const checkId = failedDiagnostic(
      database.monitors,
      "Retry cleanup",
      "2026-07-01T12:00:00.000Z",
    );
    const sabotage = new BetterSqlite3(database.path);
    sabotage.exec(`
      CREATE TRIGGER reject_diagnostic_cleanup
      BEFORE DELETE ON check_diagnostics
      BEGIN
        SELECT RAISE(ABORT, 'forced cleanup failure');
      END;
    `);
    sabotage.close();
    const events: Array<{ event: string; values?: Record<string, unknown> }> = [];
    let current = new Date("2026-07-29T12:00:00.000Z");
    const service = createMonitorService({
      database,
      pageProbe: { preview: vi.fn() },
      clock: { now: () => current },
      logger: {
        write(event, values) {
          events.push({ event, ...(values === undefined ? {} : { values }) });
        },
      },
    });

    await expect(service.runAvailableChecks()).resolves.toBeUndefined();
    expect(service.getCheckDiagnostic(checkId)).toMatchObject({
      availability: "available",
    });
    expect(events).toEqual([{
      event: "check_diagnostic_cleanup_failed",
      values: {
        stage: "persistence",
        message: "Expired Check diagnostics were not deleted.",
      },
    }]);

    const repair = new BetterSqlite3(database.path);
    repair.exec("DROP TRIGGER reject_diagnostic_cleanup");
    repair.close();
    await service.runAvailableChecks();
    expect(service.getCheckDiagnostic(checkId)).toEqual({
      checkId,
      availability: "expired",
      diagnostic: null,
    });
  });

  it("exposes an expired diagnostic through the local HTTP contract", async () => {
    const { database } = await fixture();
    const checkId = failedDiagnostic(
      database.monitors,
      "Expired endpoint",
      "2026-07-01T12:00:00.000Z",
    );
    const server = buildHttpServer({
      database,
      version: "0.1.0",
      port: 43120,
      workerIntervalMs: 24 * 60 * 60 * 1_000,
    });

    try {
      const response = await server.inject({
        method: "GET",
        url: `/api/checks/${checkId}/diagnostics`,
        headers: { host: "127.0.0.1:43120" },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        checkId,
        availability: "expired",
        diagnostic: null,
      });
    } finally {
      await server.close();
    }
  });

  async function fixture() {
    const root = await mkdtemp(join(tmpdir(), "check-diagnostic-retention-"));
    roots.push(root);
    const database = openApplicationDatabase({ rootDirectory: root });
    databases.push(database);
    return { root, database };
  }
});

function failedDiagnostic(
  store: MonitorStore,
  monitorName: string,
  recordedAt: string,
): number {
  const monitorId = store.createMonitor({
    name: monitorName,
    url: "https://example.com",
    targetSelectors: ["body"],
    exclusionSelectors: [],
    intervalHours: 6,
  }, recordedAt);
  const claimed = store.claimNextCheck(recordedAt)!;
  store.failCheck(
    claimed,
    { code: "navigation_timeout", message: "Страница не ответила." },
    recordedAt,
    new Date(new Date(recordedAt).getTime() + 6 * 60 * 60 * 1_000)
      .toISOString(),
    defaultNotificationPolicy,
  );
  store.recordCheckDiagnostic(claimed.checkId, {
    recordedAt,
    stage: "navigation",
    totalMs: 1,
  });
  store.setPaused(monitorId, true, recordedAt);
  return claimed.checkId;
}
