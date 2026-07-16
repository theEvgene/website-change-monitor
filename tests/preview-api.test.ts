import { afterEach, describe, expect, it, vi } from "vitest";

import type { PageProbe } from "../src/server/application/page-probe.js";
import { createHttpTestContext } from "./support/http-test-context.js";
import { successfulPageProbeResult } from "./support/page-probe.js";

describe("single target preview API", () => {
  const context = createHttpTestContext();

  afterEach(async () => {
    await context.cleanup();
  });

  it("returns the real final URL and target match count", async () => {
    const preview = vi
      .fn<PageProbe["preview"]>()
      .mockResolvedValue(
        successfulPageProbeResult("https://example.com/catalog", 3),
      );
    const server = await context.applicationServer({ pageProbe: { preview } });

    const response = await server.inject({
      method: "POST",
      url: "/api/preview",
      headers: { host: "127.0.0.1:43117" },
      payload: {
        url: "https://example.com/start",
        targetSelector: ".product-card",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      finalUrl: "https://example.com/catalog",
      targetSelector: ".product-card",
      matchCount: 3,
    });
    expect(preview).toHaveBeenCalledWith({
      url: "https://example.com/start",
      targetSelector: ".product-card",
    });
  });

  it.each([
    ["ftp://example.com/file", ".target", "invalid_url"],
    ["https://user:secret@example.com", ".target", "invalid_url"],
    ["https://example.com", "xpath=//div", "unsupported_selector"],
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
        payload: { url, targetSelector },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        error: { code: expectedCode },
      });
      expect(preview).not.toHaveBeenCalled();
    },
  );

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
