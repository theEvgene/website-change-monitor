import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createMonitorService } from "../src/server/application/monitor-service.js";
import type { PageProbe } from "../src/server/application/page-probe.js";
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
});
