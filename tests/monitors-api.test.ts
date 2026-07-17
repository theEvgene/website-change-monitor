import { afterEach, describe, expect, it, vi } from "vitest";

import type { PageProbe } from "../src/server/application/page-probe.js";
import { createHttpTestContext } from "./support/http-test-context.js";
import {
  simplePagePreviewTargets,
  successfulPageProbeResult,
} from "./support/page-probe.js";

describe("Monitors HTTP API", () => {
  const context = createHttpTestContext();

  afterEach(async () => context.cleanup());

  it("creates and reads a Monitor with its Baseline Check", async () => {
    const preview = vi
      .fn<PageProbe["preview"]>()
      .mockResolvedValue(
        successfulPageProbeResult(
          "https://example.com/catalog",
          [{ selector: ".card", matchCount: 2 }],
          simplePagePreviewTargets("Карточка A", "Карточка B"),
        ),
      );
    const server = await context.applicationServer({ pageProbe: { preview } });

    const createdResponse = await server.inject({
      method: "POST",
      url: "/api/monitors",
      headers: { host: "127.0.0.1:43117" },
      payload: {
        name: "Каталог",
        url: "https://example.com/catalog",
        targetSelectors: [".card"],
        exclusionSelectors: [".price"],
        intervalHours: 12,
      },
    });

    expect(createdResponse.statusCode).toBe(201);
    const created = createdResponse.json();
    expect(created).toMatchObject({
      id: expect.any(Number),
      name: "Каталог",
      targetSelectors: [".card"],
      exclusionSelectors: [".price"],
      intervalHours: 12,
      scopeRevision: 1,
      nextCheckAt: expect.any(String),
      activeIntent: {
        kind: "scheduled",
        state: "queued",
        dueAt: expect.any(String),
      },
      history: [
        {
          status: "succeeded",
          result: "baseline",
          snapshot: {
            id: expect.any(Number),
            formatVersion: 1,
            sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
          },
        },
      ],
    });
    expect(created.history[0].snapshot).not.toHaveProperty("canonicalJson");
    expect(preview).toHaveBeenCalledTimes(2);

    const listResponse = await server.inject({
      method: "GET",
      url: "/api/monitors",
      headers: { host: "127.0.0.1:43117" },
    });
    expect(listResponse.statusCode).toBe(200);
    expect(listResponse.json()).toEqual([
      expect.objectContaining({
        id: created.id,
        name: "Каталог",
        latestCheckResult: "baseline",
      }),
    ]);

    const detailResponse = await server.inject({
      method: "GET",
      url: `/api/monitors/${created.id}`,
      headers: { host: "127.0.0.1:43117" },
    });
    expect(detailResponse.statusCode).toBe(200);
    expect(detailResponse.json()).toEqual(created);

    const checksResponse = await server.inject({
      method: "GET",
      url: `/api/monitors/${created.id}/checks`,
      headers: { host: "127.0.0.1:43117" },
    });
    expect(checksResponse.statusCode).toBe(200);
    expect(checksResponse.json()).toEqual(created.history);

    const queueResponse = await server.inject({
      method: "GET",
      url: "/api/check-intents",
      headers: { host: "127.0.0.1:43117" },
    });
    expect(queueResponse.statusCode).toBe(200);
    expect(queueResponse.json()).toEqual([
      expect.objectContaining({
        monitorId: created.id,
        monitorName: "Каталог",
        kind: "scheduled",
        state: "queued",
        dueAt: created.nextCheckAt,
      }),
    ]);
  });

  it("runs a manual Check through the documented Monitor API", async () => {
    const baseline = successfulPageProbeResult(
      "https://example.com/catalog",
      [{ selector: ".card", matchCount: 1 }],
      simplePagePreviewTargets("Product A"),
    );
    const changed = successfulPageProbeResult(
      "https://example.com/catalog",
      [{ selector: ".card", matchCount: 1 }],
      simplePagePreviewTargets("Product B"),
    );
    const preview = vi
      .fn<PageProbe["preview"]>()
      .mockResolvedValueOnce(baseline)
      .mockResolvedValueOnce(baseline)
      .mockResolvedValueOnce(changed)
      .mockResolvedValueOnce(changed);
    const server = await context.applicationServer({ pageProbe: { preview } });
    const created = await server.inject({
      method: "POST",
      url: "/api/monitors",
      headers: { host: "127.0.0.1:43117" },
      payload: {
        name: "Catalog",
        url: "https://example.com/catalog",
        targetSelectors: [".card"],
        exclusionSelectors: [],
        intervalHours: 12,
      },
    });
    const monitorId = created.json<{ id: number }>().id;

    const checked = await server.inject({
      method: "POST",
      url: `/api/monitors/${monitorId}/checks`,
      headers: { host: "127.0.0.1:43117" },
    });

    expect(checked.statusCode).toBe(200);
    expect(checked.json()).toMatchObject({
      id: monitorId,
      history: [
        {
          kind: "manual",
          result: "change",
          beforeSnapshotId: expect.any(Number),
          afterSnapshotId: expect.any(Number),
        },
        { result: "baseline" },
      ],
    });
    const changedCheckId = checked.json<{ history: Array<{ id: number }> }>()
      .history[0]!.id;

    const journal = await server.inject({
      method: "GET",
      url: "/api/checks",
      headers: { host: "127.0.0.1:43117" },
    });
    expect(journal.statusCode).toBe(200);
    expect(journal.json()).toEqual([
      expect.objectContaining({
        id: changedCheckId,
        monitorId,
        monitorName: "Catalog",
        kind: "manual",
        result: "change",
      }),
      expect.objectContaining({
        monitorId,
        result: "baseline",
      }),
    ]);

    const comparison = await server.inject({
      method: "GET",
      url: `/api/checks/${changedCheckId}/comparison`,
      headers: { host: "127.0.0.1:43117" },
    });
    expect(comparison.statusCode).toBe(200);
    expect(comparison.json()).toMatchObject({
      checkId: changedCheckId,
      monitorId,
      monitorName: "Catalog",
      complete: true,
      targets: [
        {
          kind: "replace",
          text: [
            { kind: "replace", before: "Product A", after: "Product B" },
          ],
        },
      ],
    });

    const unchanged = await server.inject({
      method: "POST",
      url: `/api/monitors/${monitorId}/checks`,
      headers: { host: "127.0.0.1:43117" },
    });
    expect(unchanged.statusCode).toBe(200);
    expect(unchanged.json()).toMatchObject({
      history: [
        {
          kind: "manual",
          result: "no_change",
          snapshot: null,
        },
        { result: "change" },
        { result: "baseline" },
      ],
    });
  });
});
