// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App } from "../src/ui/App.js";

describe("startup UI", () => {
  afterEach(() => {
    cleanup();
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

  it("previews repeatable target and exclusion selectors through the public API", async () => {
    const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL) => {
      if (input === "/api/version") {
        return Promise.resolve(
          Response.json({
            application: "website-change-monitor",
            apiVersion: "v1",
            version: "0.1.0",
          }),
        );
      }
      if (input === "/api/preview") {
        return Promise.resolve(
          Response.json({
            finalUrl: "https://example.com/catalog",
            targetMatches: [
              { selector: ".page-title", matchCount: 1 },
              { selector: ".product-card", matchCount: 2 },
            ],
            exclusionSelectors: [".price"],
            targetCount: 3,
            targets: [
              { elements: [], visibleText: "Каталог" },
              { elements: [], visibleText: "Товар A" },
              { elements: [], visibleText: "Товар B" },
            ],
          }),
        );
      }
      return Promise.resolve(
        Response.json({
          application: "website-change-monitor",
          status: "degraded",
          version: "0.1.0",
          database: { status: "ready", schemaVersion: 1 },
          telegram: { status: "unavailable", reason: "not_configured" },
        }),
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);

    fireEvent.change(await screen.findByLabelText("URL страницы"), {
      target: { value: "https://example.com/start" },
    });
    fireEvent.change(screen.getByLabelText("Целевой CSS-селектор 1"), {
      target: { value: ".page-title" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Добавить Целевой селектор" }),
    );
    fireEvent.change(screen.getByLabelText("Целевой CSS-селектор 2"), {
      target: { value: ".product-card" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Добавить Селектор исключения" }),
    );
    fireEvent.change(screen.getByLabelText("CSS-селектор исключения 1"), {
      target: { value: ".price" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Предпросмотреть" }));

    expect(await screen.findByText("Уникальных элементов: 3")).toBeVisible();
    expect(screen.getByText(".page-title: 1")).toBeVisible();
    expect(screen.getByText(".product-card: 2")).toBeVisible();
    expect(screen.getByText("Товар B")).toBeVisible();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/preview",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          url: "https://example.com/start",
          targetSelectors: [".page-title", ".product-card"],
          exclusionSelectors: [".price"],
        }),
      }),
    );
  });

  it("keeps one target field and reports duplicate selectors at the repeated field", async () => {
    const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL) => {
      if (input === "/api/version") {
        return Promise.resolve(
          Response.json({
            application: "website-change-monitor",
            apiVersion: "v1",
            version: "0.1.0",
          }),
        );
      }
      return Promise.resolve(
        Response.json({
          application: "website-change-monitor",
          status: "degraded",
          version: "0.1.0",
          database: { status: "ready", schemaVersion: 1 },
          telegram: { status: "unavailable", reason: "not_configured" },
        }),
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);

    expect(
      screen.queryByRole("button", {
        name: "Удалить: Целевой CSS-селектор 1",
      }),
    ).not.toBeInTheDocument();
    fireEvent.change(await screen.findByLabelText("URL страницы"), {
      target: { value: "https://example.com" },
    });
    fireEvent.change(screen.getByLabelText("Целевой CSS-селектор 1"), {
      target: { value: ".card" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Добавить Целевой селектор" }),
    );
    const duplicate = screen.getByLabelText("Целевой CSS-селектор 2");
    fireEvent.change(duplicate, { target: { value: " .card " } });
    fireEvent.click(screen.getByRole("button", { name: "Предпросмотреть" }));

    expect(duplicate).toHaveAttribute("aria-invalid", "true");
    expect(screen.getAllByText("Такой селектор уже добавлен.")).toHaveLength(2);
    expect(
      fetchMock.mock.calls.filter(([input]) => input === "/api/preview"),
    ).toHaveLength(0);

    fireEvent.click(
      screen.getByRole("button", {
        name: "Удалить: Целевой CSS-селектор 2",
      }),
    );
    expect(
      screen.queryByLabelText("Целевой CSS-селектор 2"),
    ).not.toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: "Добавить Селектор исключения" }),
    );
    expect(screen.getByLabelText("CSS-селектор исключения 1")).toBeVisible();
    fireEvent.click(
      screen.getByRole("button", {
        name: "Удалить: CSS-селектор исключения 1",
      }),
    );
    expect(
      screen.queryByLabelText("CSS-селектор исключения 1"),
    ).not.toBeInTheDocument();
  });
});
