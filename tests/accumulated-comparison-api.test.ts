import { afterEach, describe, expect, it, vi } from "vitest";

import type { PageProbe } from "../src/server/application/page-probe.js";
import { createHttpTestContext } from "./support/http-test-context.js";
import { simplePagePreviewTargets, successfulPageProbeResult } from "./support/page-probe.js";

describe("accumulated Snapshot comparison API", () => {
  const context = createHttpTestContext();
  afterEach(async () => context.cleanup());

  it("keeps adjacent compatibility and compares any eligible earlier retained Snapshot directly", async () => {
    const result = (text: string) => successfulPageProbeResult(
      "https://example.com/catalog",
      [{ selector: ".card", matchCount: 1 }],
      simplePagePreviewTargets(text),
    );
    const preview = vi.fn<PageProbe["preview"]>();
    for (const text of ["A", "A", "A\nTransient", "A"]) {
      preview.mockResolvedValueOnce(result(text));
    }
    const server = await context.applicationServer({ pageProbe: { preview } });
    const headers = { host: "127.0.0.1:43117" };
    const created = await server.inject({
      method: "POST", url: "/api/monitors", headers,
      payload: { name: "Catalog", url: "https://example.com/catalog", targetSelectors: [".card"], exclusionSelectors: [], intervalHours: 12 },
    });
    const monitorId = created.json<{ id: number }>().id;
    await server.inject({ method: "POST", url: `/api/monitors/${monitorId}/checks`, headers });
    const finalResponse = await server.inject({ method: "POST", url: `/api/monitors/${monitorId}/checks`, headers });
    const history = finalResponse.json<{ history: Array<{ id: number; result: string; beforeSnapshotId: number | null; afterSnapshotId: number | null }> }>().history;
    const finalCheck = history[0]!;
    const middle = history[1]!.afterSnapshotId!;
    const baseline = history[2]!.afterSnapshotId!;

    const adjacent = await server.inject({ method: "GET", url: `/api/checks/${finalCheck.id}/comparison`, headers });
    expect(adjacent.statusCode).toBe(200);
    expect(adjacent.json()).toMatchObject({ beforeSnapshotId: middle, afterSnapshotId: finalCheck.afterSnapshotId });

    const accumulated = await server.inject({ method: "GET", url: `/api/checks/${finalCheck.id}/comparison?initialSnapshotId=${baseline}`, headers });
    expect(accumulated.statusCode).toBe(200);
    expect(accumulated.json()).toMatchObject({
      beforeSnapshotId: baseline,
      afterSnapshotId: finalCheck.afterSnapshotId,
      beforeCreatedAt: expect.any(String),
      afterCreatedAt: expect.any(String),
      eligibleBeforeSnapshots: [{ id: middle, createdAt: expect.any(String) }, { id: baseline, createdAt: expect.any(String) }],
    });
    expect(accumulated.json<{ targets: Array<{ kind: string }> }>().targets.every((target) => target.kind === "equal")).toBe(true);

    preview.mockResolvedValue(result("Other"));
    const other = await server.inject({
      method: "POST", url: "/api/monitors", headers,
      payload: { name: "Other", url: "https://example.com/catalog", targetSelectors: [".card"], exclusionSelectors: [], intervalHours: 12 },
    });
    const otherSnapshotId = other.json<{ history: Array<{ afterSnapshotId: number }> }>().history[0]!.afterSnapshotId;
    const crossMonitor = await server.inject({ method: "GET", url: `/api/checks/${finalCheck.id}/comparison?initialSnapshotId=${otherSnapshotId}`, headers });
    expect(crossMonitor.statusCode).toBe(400);

    preview.mockResolvedValue(result("Reset"));
    const reset = await server.inject({
      method: "PUT", url: `/api/monitors/${monitorId}`, headers,
      payload: { name: "Catalog", url: "https://example.com/catalog", targetSelectors: [".changed"], exclusionSelectors: [], intervalHours: 12, resetHistory: true },
    });
    expect(reset.statusCode).toBe(200);
    preview.mockResolvedValue(result("Reset changed"));
    const changedScope = await server.inject({ method: "POST", url: `/api/monitors/${monitorId}/checks`, headers });
    const changedScopeCheck = changedScope.json<{ history: Array<{ id: number; afterSnapshotId: number }> }>().history[0]!;
    const changedScopeCheckId = changedScopeCheck.id;
    const staleScope = await server.inject({ method: "GET", url: `/api/checks/${changedScopeCheckId}/comparison?initialSnapshotId=${baseline}`, headers });
    expect(staleScope.statusCode).toBe(400);
    for (const invalidId of [999999, changedScopeCheck.afterSnapshotId]) {
      const invalid = await server.inject({ method: "GET", url: `/api/checks/${changedScopeCheckId}/comparison?initialSnapshotId=${invalidId}`, headers });
      expect(invalid.statusCode).toBe(400);
      expect(invalid.json()).toMatchObject({ error: { code: "invalid_request" } });
    }
  });
});