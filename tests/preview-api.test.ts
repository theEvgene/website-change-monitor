import { afterEach, describe, expect, it, vi } from "vitest";

import type { PageProbe } from "../src/server/application/page-probe.js";
import { createHttpTestContext } from "./support/http-test-context.js";
import { successfulPageProbeResult } from "./support/page-probe.js";

describe("observation scope preview API", () => {
  const context = createHttpTestContext();

  afterEach(async () => {
    await context.cleanup();
  });

  it("returns per-selector counts and the DOM-ordered unique target area", async () => {
    const preview = vi
      .fn<PageProbe["preview"]>()
      .mockResolvedValue(
        successfulPageProbeResult(
          "https://example.com/catalog",
          [
            { selector: ".title", matchCount: 1 },
            { selector: ".product-card", matchCount: 2 },
          ],
          [
            {
              elements: [
                { namespace: "http://www.w3.org/1999/xhtml", name: "h1", childElementCount: 0 },
              ],
              visibleText: "Каталог",
            },
            {
              elements: [
                { namespace: "http://www.w3.org/1999/xhtml", name: "article", childElementCount: 0 },
              ],
              visibleText: "Товар A",
            },
            {
              elements: [
                { namespace: "http://www.w3.org/1999/xhtml", name: "article", childElementCount: 0 },
              ],
              visibleText: "Товар B",
            },
          ],
        ),
      );
    const server = await context.applicationServer({ pageProbe: { preview } });

    const response = await server.inject({
      method: "POST",
      url: "/api/preview",
      headers: { host: "127.0.0.1:43117" },
      payload: {
        url: "https://example.com/start",
        targetSelectors: [".title", ".product-card"],
        exclusionSelectors: [".price"],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      finalUrl: "https://example.com/catalog",
      targetMatches: [
        { selector: ".title", matchCount: 1 },
        { selector: ".product-card", matchCount: 2 },
      ],
      exclusionSelectors: [".price"],
      targetCount: 3,
      targets: [
        {
          elements: [
            { namespace: "http://www.w3.org/1999/xhtml", name: "h1", childElementCount: 0 },
          ],
          visibleText: "Каталог",
        },
        {
          elements: [
            { namespace: "http://www.w3.org/1999/xhtml", name: "article", childElementCount: 0 },
          ],
          visibleText: "Товар A",
        },
        {
          elements: [
            { namespace: "http://www.w3.org/1999/xhtml", name: "article", childElementCount: 0 },
          ],
          visibleText: "Товар B",
        },
      ],
    });
    expect(preview).toHaveBeenCalledWith({
      url: "https://example.com/start",
      targetSelectors: [".title", ".product-card"],
      exclusionSelectors: [".price"],
    });
  });

  it.each([
    ["ftp://example.com/file", ".target", "invalid_url"],
    ["https://user:secret@example.com", ".target", "invalid_url"],
    ["https://example.com", "xpath=//div", "unsupported_selector"],
    ["https://example.com", "", "invalid_selector"],
    ["https://example.com", " ", "invalid_selector"],
  ])(
    "rejects invalid input before external page access",
    async (url, targetSelector, expectedCode) => {
      const preview = vi.fn<PageProbe["preview"]>();
      const server = await context.applicationServer({
        pageProbe: { preview },
      });

      const response = await server.inject({
        method: "POST",
        url: "/api/preview",
        headers: { host: "127.0.0.1:43117" },
        payload: {
          url,
          targetSelectors: [targetSelector],
          exclusionSelectors: [],
        },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        error: { code: expectedCode },
      });
      expect(preview).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["targetSelectors", [".card", " .card "], [], 1],
    ["exclusionSelectors", [".card"], [".price", " .price "], 1],
  ] as const)(
    "rejects duplicate selectors in %s at the duplicated field",
    async (field, targetSelectors, exclusionSelectors, index) => {
      const preview = vi.fn<PageProbe["preview"]>();
      const server = await context.applicationServer({ pageProbe: { preview } });

      const response = await server.inject({
        method: "POST",
        url: "/api/preview",
        headers: { host: "127.0.0.1:43117" },
        payload: {
          url: "https://example.com",
          targetSelectors,
          exclusionSelectors,
        },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({
        error: {
          code: "duplicate_selector",
          message: "Такой селектор уже добавлен.",
          field,
          index,
        },
      });
      expect(preview).not.toHaveBeenCalled();
    },
  );

  it("returns the target field that has no page matches", async () => {
    const preview = vi.fn<PageProbe["preview"]>().mockResolvedValue({
      ok: false,
      code: "target_not_found",
      message: "Целевой селектор 2 не нашёл элементов.",
      field: "targetSelectors",
      index: 1,
      stage: "extraction",
      finalUrl: "https://example.com",
      httpStatus: 200,
      timings: {
        totalMs: 10,
        navigationMs: 4,
        targetMs: 2,
        scrollMs: 1,
        stabilityMs: 2,
        extractionMs: 1,
      },
    });
    const server = await context.applicationServer({ pageProbe: { preview } });

    const response = await server.inject({
      method: "POST",
      url: "/api/preview",
      headers: { host: "127.0.0.1:43117" },
      payload: {
        url: "https://example.com",
        targetSelectors: [".card", ".missing"],
        exclusionSelectors: [],
      },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toEqual({
      error: {
        code: "target_not_found",
        message: "Целевой селектор 2 не нашёл элементов.",
        field: "targetSelectors",
        index: 1,
      },
    });
  });

  it("returns a typed request error for a malformed JSON shape", async () => {
    const server = await context.applicationServer();

    const response = await server.inject({
      method: "POST",
      url: "/api/preview",
      headers: { host: "127.0.0.1:43117" },
      payload: { url: "https://example.com" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: {
        code: "invalid_request",
        message: "Тело запроса не соответствует HTTP-контракту.",
      },
    });
  });
});
