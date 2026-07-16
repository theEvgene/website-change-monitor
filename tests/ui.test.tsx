// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App } from "../src/ui/App.js";

describe("startup UI", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows the health reported by the local application", async () => {
    const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL) => {
      if (input === "/api/version") {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              application: "website-change-monitor",
              apiVersion: "v1",
              version: "0.1.0",
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        );
      }

      return Promise.resolve(
        new Response(
          JSON.stringify({
            application: "website-change-monitor",
            status: "degraded",
            version: "health-endpoint-version",
            database: { status: "ready", schemaVersion: 1 },
            telegram: { status: "unavailable", reason: "not_configured" },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);

    expect(await screen.findByText("Приложение работает с ограничениями")).toBeVisible();
    expect(screen.getByText("SQLite готова · схема 1")).toBeVisible();
    expect(screen.getByText("Telegram пока не настроен")).toBeVisible();
    expect(screen.getByText("Версия 0.1.0")).toBeVisible();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/health",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/version",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });
});
