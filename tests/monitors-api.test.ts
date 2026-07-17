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
  });
});
