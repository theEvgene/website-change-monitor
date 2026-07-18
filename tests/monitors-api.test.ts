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
      paused: false,
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
          isFinalError: false,
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

    const pausedResponse = await server.inject({
      method: "POST",
      url: `/api/monitors/${created.id}/pause`,
      headers: { host: "127.0.0.1:43117" },
    });
    expect(pausedResponse.statusCode).toBe(200);
    expect(pausedResponse.json()).toMatchObject({ id: created.id, paused: true });

    const resumedResponse = await server.inject({
      method: "POST",
      url: `/api/monitors/${created.id}/resume`,
      headers: { host: "127.0.0.1:43117" },
    });
    expect(resumedResponse.statusCode).toBe(200);
    expect(resumedResponse.json()).toMatchObject({ id: created.id, paused: false });
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

    const notifications = await server.inject({
      method: "GET", url: "/api/notifications", headers: { host: "127.0.0.1:43117" },
    });
    expect(notifications.statusCode).toBe(200);
    expect(notifications.json()).toMatchObject({
      highWaterMark: 1,
      items: [{ id: 1, kind: "change_detected", checkId: changedCheckId, monitorName: "Catalog" }],
    });
    const replayCursor = await server.inject({
      method: "GET", url: "/api/notifications?after=1", headers: { host: "127.0.0.1:43117" },
    });
    expect(replayCursor.json()).toEqual({ highWaterMark: 1, items: [] });

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

  it("updates, filters, resets scope explicitly, and deletes with the Monitor name", async () => {
    const preview = vi.fn<PageProbe["preview"]>().mockResolvedValue(
      successfulPageProbeResult("https://example.com/a", [{ selector: ".a", matchCount: 1 }], simplePagePreviewTargets("A")),
    );
    const server = await context.applicationServer({ pageProbe: { preview } });
    const create = async (name: string, labels: string[]) => (await server.inject({ method: "POST", url: "/api/monitors", headers: { host: "127.0.0.1:43117" }, payload: { name, url: "https://example.com/a", targetSelectors: [".a", ".b"], exclusionSelectors: [".noise"], intervalHours: 12, labels } })).json();
    const first = await create("First", ["work", "shared", "Новости", "Straße"]);
    const second = await create("Second", ["shared", "новости", "STRASSE"]);

    const reorganized = await server.inject({ method: "PUT", url: `/api/monitors/${first.id}`, headers: { host: "127.0.0.1:43117" }, payload: { name: "Renamed", url: first.url, targetSelectors: [".b", ".a"], exclusionSelectors: [".noise"], intervalHours: 24, labels: ["shared", "important", "Новости", "Straße"] } });
    expect(reorganized.statusCode).toBe(200);
    expect(reorganized.json()).toMatchObject({ name: "Renamed", scopeRevision: 1, targetSelectors: [".b", ".a"], labels: ["important", "shared", "Straße", "Новости"], history: first.history });

    const filtered = await server.inject({ method: "GET", url: "/api/monitors?label=important", headers: { host: "127.0.0.1:43117" } });
    expect(filtered.json()).toEqual([expect.objectContaining({ id: first.id })]);
    const unicodeShared = await server.inject({ method: "GET", url: `/api/monitors?label=${encodeURIComponent("НОВОСТИ")}`, headers: { host: "127.0.0.1:43117" } });
    expect(unicodeShared.json()).toEqual([expect.objectContaining({ id: first.id }), expect.objectContaining({ id: second.id })]);
    const foldedShared = await server.inject({ method: "GET", url: "/api/monitors?label=strasse", headers: { host: "127.0.0.1:43117" } });
    expect(foldedShared.json()).toEqual([expect.objectContaining({ id: first.id }), expect.objectContaining({ id: second.id })]);

    const unconfirmed = await server.inject({ method: "PUT", url: `/api/monitors/${first.id}`, headers: { host: "127.0.0.1:43117" }, payload: { name: "Renamed", url: "https://example.com/changed", targetSelectors: [".b", ".a"], exclusionSelectors: [".noise"], intervalHours: 24, labels: ["important"] } });
    expect(unconfirmed.statusCode).toBe(409);
    expect(unconfirmed.json()).toMatchObject({ error: { code: "scope_reset_required" } });

    const reset = await server.inject({ method: "PUT", url: `/api/monitors/${first.id}`, headers: { host: "127.0.0.1:43117" }, payload: { name: "Renamed", url: "https://example.com/changed", targetSelectors: [".b", ".a"], exclusionSelectors: [".noise"], intervalHours: 24, labels: ["important"], resetHistory: true } });
    expect(reset.statusCode).toBe(200);
    expect(reset.json()).toMatchObject({ scopeRevision: 2, history: [{ result: "baseline" }] });

    expect((await server.inject({ method: "DELETE", url: `/api/monitors/${first.id}`, headers: { host: "127.0.0.1:43117" }, payload: { confirmName: "wrong" } })).statusCode).toBe(400);
    expect((await server.inject({ method: "DELETE", url: `/api/monitors/${first.id}`, headers: { host: "127.0.0.1:43117" }, payload: { confirmName: "Renamed" } })).statusCode).toBe(204);
    const shared = await server.inject({ method: "GET", url: "/api/monitors?label=shared", headers: { host: "127.0.0.1:43117" } });
    expect(shared.json()).toEqual([expect.objectContaining({ id: second.id })]);
    const journal = await server.inject({ method: "GET", url: "/api/checks", headers: { host: "127.0.0.1:43117" } });
    expect(journal.json()).not.toEqual(expect.arrayContaining([expect.objectContaining({ monitorId: first.id })]));
  });

  it.each([
    ["URL", {}, { url: "https://example.com/b" }],
    ["добавление Целевого селектора", {}, { targetSelectors: [".a", ".b"] }],
    ["удаление Целевого селектора", { targetSelectors: [".a", ".b"] }, { targetSelectors: [".a"] }],
    ["изменение Целевого селектора", {}, { targetSelectors: [".changed"] }],
    ["добавление Селектора исключения", {}, { exclusionSelectors: [".noise"] }],
    ["удаление Селектора исключения", { exclusionSelectors: [".noise"] }, { exclusionSelectors: [] }],
    ["изменение Селектора исключения", { exclusionSelectors: [".noise"] }, { exclusionSelectors: [".other"] }],
  ])("requires and performs an atomic reset for %s", async (_name, initial, change) => {
    const preview = vi.fn<PageProbe["preview"]>().mockResolvedValue(successfulPageProbeResult("https://example.com/a", [{ selector: ".a", matchCount: 1 }], simplePagePreviewTargets("A")));
    const server = await context.applicationServer({ pageProbe: { preview } });
    const base = { name: "Scope", url: "https://example.com/a", targetSelectors: [".a"], exclusionSelectors: [], intervalHours: 12, labels: [], ...initial };
    const created = (await server.inject({ method: "POST", url: "/api/monitors", headers: { host: "127.0.0.1:43117" }, payload: base })).json();
    const changed = { ...base, ...change };
    expect((await server.inject({ method: "PUT", url: `/api/monitors/${created.id}`, headers: { host: "127.0.0.1:43117" }, payload: changed })).statusCode).toBe(409);
    const reset = await server.inject({ method: "PUT", url: `/api/monitors/${created.id}`, headers: { host: "127.0.0.1:43117" }, payload: { ...changed, resetHistory: true } });
    expect(reset.json()).toMatchObject({ scopeRevision: 2, history: [{ result: "baseline" }] });
  });
});
