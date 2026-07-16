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
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            application: "website-change-monitor",
            status: "degraded",
            version: "0.1.0",
            database: { status: "ready", schemaVersion: 1 },
            telegram: { status: "unavailable", reason: "not_configured" },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );

    render(<App />);

    expect(await screen.findByText("Приложение работает с ограничениями")).toBeVisible();
    expect(screen.getByText("SQLite готова · схема 1")).toBeVisible();
    expect(screen.getByText("Telegram пока не настроен")).toBeVisible();
    expect(screen.getByText("Версия 0.1.0")).toBeVisible();
  });
});
