import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import BetterSqlite3 from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createMonitorService } from "../src/server/application/monitor-service.js";
import type {
  PageProbe,
  PageProbeResult,
} from "../src/server/application/page-probe.js";
import {
  openApplicationDatabase,
  type ApplicationDatabase,
} from "../src/server/persistence/database.js";
import {
  simplePagePreviewTargets,
  successfulPageProbeResult,
} from "./support/page-probe.js";

const rootElement = {
  namespace: "http://www.w3.org/1999/xhtml",
  name: "div",
  childElementCount: 0,
};

describe("Monitor use case", () => {
  const roots: string[] = [];
  const databases: ApplicationDatabase[] = [];

  afterEach(async () => {
    for (const database of databases.splice(0)) {
      database.close();
    }
    for (const root of roots.splice(0)) {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("saves a Monitor, completes its first Check as a Baseline, and survives restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "website-change-monitor-"));
    roots.push(root);
    const database = openApplicationDatabase({ rootDirectory: root });
    databases.push(database);
    const preview = vi
      .fn<PageProbe["preview"]>()
      .mockResolvedValue(
        successfulPageProbeResult(
          "https://example.com/catalog",
          [
            { selector: ".heading", matchCount: 1 },
            { selector: ".card", matchCount: 2 },
          ],
          [
            {
              elements: [
                {
                  namespace: "http://www.w3.org/1999/xhtml",
                  name: "h1",
                  childElementCount: 0,
                },
              ],
              visibleText: "  Каталог\r\nтоваров  ",
            },
            ...simplePagePreviewTargets("Карточка A", "Карточка B"),
          ],
        ),
      );
    const clock = { now: () => new Date("2026-07-17T08:00:00.000Z") };
    const service = createMonitorService({
      database,
      pageProbe: { preview },
      clock,
    });

    const monitor = await service.createMonitor({
      name: "Каталог",
      url: "https://example.com/catalog",
      targetSelectors: [".heading", ".card"],
      exclusionSelectors: [".price"],
      intervalHours: 6,
    });

    expect(preview).toHaveBeenCalledTimes(2);
    expect(monitor).toMatchObject({
      name: "Каталог",
      url: "https://example.com/catalog",
      targetSelectors: [".heading", ".card"],
      exclusionSelectors: [".price"],
      intervalHours: 6,
      scopeRevision: 1,
      nextCheckAt: "2026-07-17T14:00:00.000Z",
      history: [
        {
          kind: "scheduled",
          status: "succeeded",
          result: "baseline",
          snapshot: {
            formatVersion: 1,
            sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
            canonicalJson:
              '{"formatVersion":1,"targets":[{"elements":[{"childElementCount":0,"name":"h1","namespace":"http://www.w3.org/1999/xhtml"}],"visibleText":"  Каталог\\nтоваров  "},{"elements":[{"childElementCount":0,"name":"div","namespace":"http://www.w3.org/1999/xhtml"}],"visibleText":"Карточка A"},{"elements":[{"childElementCount":0,"name":"div","namespace":"http://www.w3.org/1999/xhtml"}],"visibleText":"Карточка B"}]}'
          },
        },
      ],
    });

    database.close();
    databases.splice(databases.indexOf(database), 1);
    const reopened = openApplicationDatabase({ rootDirectory: root });
    databases.push(reopened);
    const restarted = createMonitorService({
      database: reopened,
      pageProbe: { preview },
      clock,
    });

    expect(restarted.listMonitors()).toEqual([
      expect.objectContaining({
        id: monitor.id,
        name: "Каталог",
        latestCheckResult: "baseline",
        nextCheckAt: "2026-07-17T14:00:00.000Z",
      }),
    ]);
    expect(restarted.getMonitor(monitor.id)).toEqual(monitor);
  });

  it("resumes a queued initial CheckIntent after reopening the database", async () => {
    const root = await mkdtemp(join(tmpdir(), "website-change-monitor-"));
    roots.push(root);
    const database = openApplicationDatabase({ rootDirectory: root });
    const monitorId = database.monitors.createMonitor(
      {
        name: "Catalog",
        url: "https://example.com/catalog",
        targetSelectors: [".card"],
        exclusionSelectors: [],
        intervalHours: 6,
      },
      "2026-07-17T08:00:00.000Z",
    );
    database.close();

    const reopened = openApplicationDatabase({ rootDirectory: root });
    databases.push(reopened);
    const preview = vi.fn<PageProbe["preview"]>().mockResolvedValue(
      successfulPageProbeResult(
        "https://example.com/catalog",
        [{ selector: ".card", matchCount: 1 }],
        simplePagePreviewTargets("Product"),
      ),
    );
    const restarted = createMonitorService({
      database: reopened,
      pageProbe: { preview },
      clock: { now: () => new Date("2026-07-17T08:01:00.000Z") },
    });

    await restarted.runAvailableChecks();

    expect(restarted.getMonitor(monitorId)).toMatchObject({
      nextCheckAt: "2026-07-17T14:01:00.000Z",
      history: [
        {
          status: "succeeded",
          result: "baseline",
          snapshot: { formatVersion: 1 },
        },
      ],
    });
  });

  it("records manual no-change and Change results without duplicating unchanged Snapshots", async () => {
    const root = await mkdtemp(join(tmpdir(), "website-change-monitor-"));
    roots.push(root);
    const database = openApplicationDatabase({ rootDirectory: root });
    databases.push(database);
    const observed = (text: string) =>
      successfulPageProbeResult(
        "https://example.com/catalog",
        [{ selector: ".card", matchCount: 1 }],
        simplePagePreviewTargets(text),
      );
    const preview = vi
      .fn<PageProbe["preview"]>()
      .mockResolvedValueOnce(observed("Product A"))
      .mockResolvedValueOnce(observed("Product A"))
      .mockResolvedValueOnce(observed("Product A"))
      .mockResolvedValueOnce(observed("Product B"));
    let now = new Date("2026-07-17T08:00:00.000Z");
    const service = createMonitorService({
      database,
      pageProbe: { preview },
      clock: { now: () => now },
    });
    const created = await service.createMonitor({
      name: "Catalog",
      url: "https://example.com/catalog",
      targetSelectors: [".card"],
      exclusionSelectors: [],
      intervalHours: 6,
    });

    now = new Date("2026-07-17T09:00:00.000Z");
    await service.requestManualCheck(created.id);
    now = new Date("2026-07-17T10:00:00.000Z");
    const changed = await service.requestManualCheck(created.id);

    expect(changed).toMatchObject({
      nextCheckAt: "2026-07-17T16:00:00.000Z",
      history: [
        {
          kind: "manual",
          result: "change",
          beforeSnapshotId: 1,
          afterSnapshotId: 2,
          snapshot: { id: 2 },
        },
        {
          kind: "manual",
          result: "no_change",
          beforeSnapshotId: 1,
          afterSnapshotId: 1,
          snapshot: null,
        },
        {
          kind: "scheduled",
          result: "baseline",
          beforeSnapshotId: null,
          afterSnapshotId: 1,
          snapshot: { id: 1 },
        },
      ],
    });
    expect(preview).toHaveBeenCalledTimes(4);
  });

  it.each([
    ["addition", ["A", "B", "C"]],
    ["deletion", ["A"]],
    ["reordering", ["B", "A"]],
    ["visible text", ["A changed", "B"]],
  ])("records target %s as a Change", async (_case, changedTexts) => {
    const root = await mkdtemp(join(tmpdir(), "website-change-monitor-"));
    roots.push(root);
    const database = openApplicationDatabase({ rootDirectory: root });
    databases.push(database);
    const observed = (texts: string[]) =>
      successfulPageProbeResult(
        "https://example.com/catalog",
        [{ selector: ".card", matchCount: texts.length }],
        simplePagePreviewTargets(...texts),
      );
    const baseline = observed(["A", "B"]);
    const preview = vi
      .fn<PageProbe["preview"]>()
      .mockResolvedValueOnce(baseline)
      .mockResolvedValueOnce(baseline)
      .mockResolvedValueOnce(observed(changedTexts));
    const service = createMonitorService({ database, pageProbe: { preview } });
    const monitor = await service.createMonitor({
      name: "Catalog",
      url: "https://example.com/catalog",
      targetSelectors: [".card"],
      exclusionSelectors: [],
      intervalHours: 6,
    });

    const result = await service.requestManualCheck(monitor.id);

    expect(result?.history[0]).toMatchObject({
      result: "change",
      beforeSnapshotId: 1,
      afterSnapshotId: 2,
    });
  });

  it("coalesces concurrent manual requests into one durable Check", async () => {
    const root = await mkdtemp(join(tmpdir(), "website-change-monitor-"));
    roots.push(root);
    const database = openApplicationDatabase({ rootDirectory: root });
    databases.push(database);
    const observed = successfulPageProbeResult(
      "https://example.com/catalog",
      [{ selector: ".card", matchCount: 1 }],
      simplePagePreviewTargets("Product"),
    );
    let releaseManual!: (value: PageProbeResult) => void;
    let markStarted!: () => void;
    const manualStarted = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const pendingManual = new Promise<PageProbeResult>((resolve) => {
      releaseManual = resolve;
    });
    const preview = vi
      .fn<PageProbe["preview"]>()
      .mockResolvedValueOnce(observed)
      .mockResolvedValueOnce(observed)
      .mockImplementationOnce(async () => {
        markStarted();
        return pendingManual;
      });
    const service = createMonitorService({ database, pageProbe: { preview } });
    const monitor = await service.createMonitor({
      name: "Catalog",
      url: "https://example.com/catalog",
      targetSelectors: [".card"],
      exclusionSelectors: [],
      intervalHours: 6,
    });

    const first = service.requestManualCheck(monitor.id);
    await manualStarted;
    const duplicate = service.requestManualCheck(monitor.id);
    releaseManual(observed);
    const [firstResult, duplicateResult] = await Promise.all([first, duplicate]);

    expect(firstResult?.history).toHaveLength(2);
    expect(duplicateResult?.history).toHaveLength(2);
    expect(firstResult?.history[0]).toMatchObject({
      kind: "manual",
      result: "no_change",
    });
    expect(preview).toHaveBeenCalledTimes(3);
  });

  it("keeps the successful baseline after an invalid manual Snapshot", async () => {
    const root = await mkdtemp(join(tmpdir(), "website-change-monitor-"));
    roots.push(root);
    const database = openApplicationDatabase({ rootDirectory: root });
    databases.push(database);
    const baseline = successfulPageProbeResult(
      "https://example.com/catalog",
      [{ selector: ".card", matchCount: 1 }],
      simplePagePreviewTargets("Product"),
    );
    const invalid = successfulPageProbeResult(
      "https://example.com/catalog",
      [{ selector: ".card", matchCount: 1 }],
      [],
    );
    const preview = vi
      .fn<PageProbe["preview"]>()
      .mockResolvedValueOnce(baseline)
      .mockResolvedValueOnce(baseline)
      .mockResolvedValueOnce(invalid)
      .mockResolvedValueOnce(baseline);
    const service = createMonitorService({ database, pageProbe: { preview } });
    const monitor = await service.createMonitor({
      name: "Catalog",
      url: "https://example.com/catalog",
      targetSelectors: [".card"],
      exclusionSelectors: [],
      intervalHours: 6,
    });

    await service.requestManualCheck(monitor.id);
    const recovered = await service.requestManualCheck(monitor.id);

    expect(recovered?.history).toEqual([
      expect.objectContaining({
        result: "no_change",
        beforeSnapshotId: 1,
        afterSnapshotId: 1,
      }),
      expect.objectContaining({
        result: "error",
        errorCode: "snapshot_invalid",
        snapshot: null,
      }),
      expect.objectContaining({
        result: "baseline",
        snapshot: expect.objectContaining({ id: 1 }),
      }),
    ]);
  });

  it("rolls back a partially completed Change transaction and keeps the previous baseline", async () => {
    const root = await mkdtemp(join(tmpdir(), "website-change-monitor-"));
    roots.push(root);
    const database = openApplicationDatabase({ rootDirectory: root });
    databases.push(database);
    const observed = (text: string) =>
      successfulPageProbeResult(
        "https://example.com/catalog",
        [{ selector: ".card", matchCount: 1 }],
        simplePagePreviewTargets(text),
      );
    const baseline = observed("Product A");
    const preview = vi
      .fn<PageProbe["preview"]>()
      .mockResolvedValueOnce(baseline)
      .mockResolvedValueOnce(baseline)
      .mockResolvedValueOnce(observed("Product B"))
      .mockResolvedValueOnce(baseline);
    const service = createMonitorService({ database, pageProbe: { preview } });
    const monitor = await service.createMonitor({
      name: "Catalog",
      url: "https://example.com/catalog",
      targetSelectors: [".card"],
      exclusionSelectors: [],
      intervalHours: 6,
    });
    const sabotage = new BetterSqlite3(database.path);
    sabotage.exec(`
      CREATE TRIGGER reject_new_current_snapshot
      BEFORE UPDATE OF current_snapshot_id ON monitors
      WHEN NEW.current_snapshot_id <> OLD.current_snapshot_id
      BEGIN
        SELECT RAISE(ABORT, 'forced transaction failure');
      END;
    `);

    await service.requestManualCheck(monitor.id);
    sabotage.exec("DROP TRIGGER reject_new_current_snapshot");
    sabotage.close();
    const recovered = await service.requestManualCheck(monitor.id);

    expect(recovered?.history).toEqual([
      expect.objectContaining({
        result: "no_change",
        beforeSnapshotId: 1,
        afterSnapshotId: 1,
      }),
      expect.objectContaining({
        result: "error",
        errorCode: "snapshot_invalid",
        beforeSnapshotId: null,
        afterSnapshotId: null,
        snapshot: null,
      }),
      expect.objectContaining({
        result: "baseline",
        afterSnapshotId: 1,
        snapshot: expect.objectContaining({ id: 1 }),
      }),
    ]);
  });

  it.each([
    [
      "targets",
      () => Array.from({ length: 1_001 }, () => ({ elements: [rootElement], visibleText: "x" })),
    ],
    [
      "elements",
      () => [{
        elements: [
          { ...rootElement, childElementCount: 50_000 },
          ...Array.from({ length: 50_000 }, () => rootElement),
        ],
        visibleText: "x",
      }],
    ],
    [
      "depth",
      () => [{
        elements: [
          ...Array.from({ length: 256 }, () => ({ ...rootElement, childElementCount: 1 })),
          rootElement,
        ],
        visibleText: "x",
      }],
    ],
    [
      "text lines",
      () => [{ elements: [rootElement], visibleText: "x\n".repeat(20_000) }],
    ],
    [
      "bytes",
      () => [{ elements: [rootElement], visibleText: "x".repeat(8 * 1024 * 1024) }],
    ],
  ])("rejects a snapshot over the %s limit without storing a partial snapshot", async (_name, targets) => {
    const root = await mkdtemp(join(tmpdir(), "website-change-monitor-"));
    roots.push(root);
    const database = openApplicationDatabase({ rootDirectory: root });
    databases.push(database);
    const valid = successfulPageProbeResult(
      "https://example.com/catalog",
      [{ selector: ".card", matchCount: 1 }],
      simplePagePreviewTargets("valid"),
    );
    const preview = vi
      .fn<PageProbe["preview"]>()
      .mockResolvedValueOnce(valid)
      .mockResolvedValueOnce(
        successfulPageProbeResult(
          "https://example.com/catalog",
          [{ selector: ".card", matchCount: 1 }],
          targets(),
        ),
      );
    const service = createMonitorService({ database, pageProbe: { preview } });

    const monitor = await service.createMonitor({
      name: "Catalog",
      url: "https://example.com/catalog",
      targetSelectors: [".card"],
      exclusionSelectors: [],
      intervalHours: 6,
    });

    expect(monitor.history).toEqual([
      expect.objectContaining({
        status: "failed",
        result: "error",
        errorCode: "snapshot_too_large",
        snapshot: null,
      }),
    ]);
  });

  it("runs a due scheduled Check and computes the next deadline from its completion", async () => {
    const root = await mkdtemp(join(tmpdir(), "website-change-monitor-"));
    roots.push(root);
    const database = openApplicationDatabase({ rootDirectory: root });
    databases.push(database);
    const observed = successfulPageProbeResult(
      "https://example.com/catalog",
      [{ selector: ".card", matchCount: 1 }],
      simplePagePreviewTargets("Product"),
    );
    const preview = vi.fn<PageProbe["preview"]>().mockResolvedValue(observed);
    let now = new Date("2026-07-17T08:00:00.000Z");
    const service = createMonitorService({
      database,
      pageProbe: { preview },
      clock: { now: () => now },
    });
    const monitor = await service.createMonitor({
      name: "Catalog", url: "https://example.com/catalog",
      targetSelectors: [".card"], exclusionSelectors: [], intervalHours: 6,
    });

    now = new Date("2026-07-17T14:03:00.000Z");
    await service.runAvailableChecks();

    expect(service.getMonitor(monitor.id)).toMatchObject({
      nextCheckAt: "2026-07-17T20:03:00.000Z",
      history: [
        { kind: "scheduled", result: "no_change" },
        { kind: "scheduled", result: "baseline" },
      ],
    });
  });

  it.each([
    [6, "2026-07-17T14:00:00.000Z"],
    [12, "2026-07-17T20:00:00.000Z"],
    [24, "2026-07-18T08:00:00.000Z"],
    [48, "2026-07-19T08:00:00.000Z"],
    [72, "2026-07-20T08:00:00.000Z"],
  ] as const)("persists the %s-hour deadline as %s", async (interval, expected) => {
    const root = await mkdtemp(join(tmpdir(), "website-change-monitor-"));
    roots.push(root);
    const database = openApplicationDatabase({ rootDirectory: root });
    databases.push(database);
    const observed = successfulPageProbeResult(
      "https://example.com/catalog",
      [{ selector: ".card", matchCount: 1 }],
      simplePagePreviewTargets("Product"),
    );
    const service = createMonitorService({
      database, pageProbe: { preview: async () => observed },
      clock: { now: () => new Date("2026-07-17T08:00:00.000Z") },
    });

    const monitor = await service.createMonitor({
      name: "Catalog", url: "https://example.com/catalog",
      targetSelectors: [".card"], exclusionSelectors: [], intervalHours: interval,
    });

    expect(monitor.nextCheckAt).toBe(expected);
    expect(monitor.activeIntent).toMatchObject({ kind: "scheduled", dueAt: expected });
  });

  it("coalesces a manual click on the ordinary deadline into one Check", async () => {
    const root = await mkdtemp(join(tmpdir(), "website-change-monitor-"));
    roots.push(root);
    const database = openApplicationDatabase({ rootDirectory: root });
    databases.push(database);
    const observed = successfulPageProbeResult(
      "https://example.com/catalog",
      [{ selector: ".card", matchCount: 1 }],
      simplePagePreviewTargets("Product"),
    );
    const preview = vi.fn<PageProbe["preview"]>().mockResolvedValue(observed);
    let now = new Date("2026-07-17T08:00:00.000Z");
    const service = createMonitorService({
      database, pageProbe: { preview }, clock: { now: () => now },
    });
    const monitor = await service.createMonitor({
      name: "Catalog", url: "https://example.com/catalog",
      targetSelectors: [".card"], exclusionSelectors: [], intervalHours: 6,
    });

    now = new Date("2026-07-17T14:00:00.000Z");
    await service.requestManualCheck(monitor.id);
    await service.runAvailableChecks();

    expect(service.getMonitor(monitor.id)?.history.map((check) => check.kind)).toEqual([
      "manual", "scheduled",
    ]);
    expect(preview).toHaveBeenCalledTimes(3);
  });

  it("collapses downtime into one overdue Check and keeps the next schedule durable", async () => {
    const root = await mkdtemp(join(tmpdir(), "website-change-monitor-"));
    roots.push(root);
    const database = openApplicationDatabase({ rootDirectory: root });
    const observed = successfulPageProbeResult(
      "https://example.com/catalog",
      [{ selector: ".card", matchCount: 1 }],
      simplePagePreviewTargets("Product"),
    );
    const preview = vi.fn<PageProbe["preview"]>().mockResolvedValue(observed);
    let now = new Date("2026-07-17T08:00:00.000Z");
    const first = createMonitorService({
      database, pageProbe: { preview }, clock: { now: () => now },
    });
    const monitor = await first.createMonitor({
      name: "Catalog", url: "https://example.com/catalog",
      targetSelectors: [".card"], exclusionSelectors: [], intervalHours: 6,
    });
    database.close();

    now = new Date("2026-07-17T14:00:00.000Z");
    const reopened = openApplicationDatabase({ rootDirectory: root });
    databases.push(reopened);
    const restarted = createMonitorService({
      database: reopened, pageProbe: { preview }, clock: { now: () => now },
    });
    await restarted.runAvailableChecks();
    await restarted.runAvailableChecks();

    expect(restarted.getMonitor(monitor.id)).toMatchObject({
      nextCheckAt: "2026-07-17T20:00:00.000Z",
      history: [
        { kind: "overdue", result: "no_change" },
        { kind: "scheduled", result: "baseline" },
      ],
    });
    expect(preview).toHaveBeenCalledTimes(3);
  });

  it("serves three manuals, then automatic work, with one PageProbe at a time", async () => {
    const root = await mkdtemp(join(tmpdir(), "website-change-monitor-"));
    roots.push(root);
    const database = openApplicationDatabase({ rootDirectory: root });
    databases.push(database);
    const now = "2026-07-17T08:00:00.000Z";
    for (const name of ["A", "B", "C", "D"]) {
      const monitorId = database.monitors.createMonitor({
        name, url: `https://example.com/${name}`,
        targetSelectors: ["main"], exclusionSelectors: [], intervalHours: 6,
      }, now);
      database.monitors.enqueueManualCheck(monitorId, now);
    }
    let active = 0;
    let maximumActive = 0;
    const preview = vi.fn<PageProbe["preview"]>().mockImplementation(async (input) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await Promise.resolve();
      active -= 1;
      return successfulPageProbeResult(
        input.url, [{ selector: "main", matchCount: 1 }],
        simplePagePreviewTargets("Product"),
      );
    });
    const service = createMonitorService({
      database, pageProbe: { preview }, clock: { now: () => new Date(now) },
    });

    await service.runAvailableChecks();

    expect(service.listJournal().map((check) => check.kind).reverse()).toEqual([
      "manual", "manual", "manual", "scheduled", "manual",
    ]);
    expect(maximumActive).toBe(1);
  });

  it("keeps serving manuals after the fairness threshold when no automatic work is due", async () => {
    const root = await mkdtemp(join(tmpdir(), "website-change-monitor-"));
    roots.push(root);
    const database = openApplicationDatabase({ rootDirectory: root });
    databases.push(database);
    const now = "2026-07-17T08:00:00.000Z";
    const future = "2026-07-18T08:00:00.000Z";
    for (const name of ["A", "B", "C", "D"]) {
      const monitorId = database.monitors.createMonitor({
        name, url: `https://example.com/${name}`,
        targetSelectors: ["main"], exclusionSelectors: [], intervalHours: 6,
      }, future);
      database.monitors.enqueueManualCheck(monitorId, now);
    }
    const preview = vi.fn<PageProbe["preview"]>().mockImplementation(async (input) =>
      successfulPageProbeResult(
        input.url, [{ selector: "main", matchCount: 1 }],
        simplePagePreviewTargets("Product"),
      ),
    );
    const service = createMonitorService({
      database, pageProbe: { preview }, clock: { now: () => new Date(now) },
    });

    await service.runAvailableChecks();

    expect(service.listJournal().map((check) => check.kind)).toEqual([
      "manual", "manual", "manual", "manual",
    ]);
    expect(database.monitors.listActiveIntents()).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "manual" })]),
    );
  });
});
