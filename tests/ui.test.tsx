// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
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

  it("saves a previewed Monitor and shows its Baseline in the table and right History", async () => {
    const created = {
      id: 7,
      name: "Каталог",
      url: "https://example.com/catalog",
      targetSelectors: [".card"],
      exclusionSelectors: [],
      intervalHours: 24,
      scopeRevision: 1,
      nextCheckAt: "2026-07-18T08:00:00.000Z",
      history: [
        {
          id: 11,
          kind: "scheduled",
          status: "succeeded",
          result: "baseline",
          startedAt: "2026-07-17T08:00:00.000Z",
          completedAt: "2026-07-17T08:00:01.000Z",
          errorCode: null,
          errorMessage: null,
          snapshot: {
            id: 3,
            formatVersion: 1,
            sha256: "a".repeat(64),
          },
        },
      ],
    };
    let saved = false;
    let manualRequested = false;
    const fetchMock = vi.fn().mockImplementation(
      (input: RequestInfo | URL, init?: RequestInit) => {
        if (input === "/api/version") {
          return Promise.resolve(
            Response.json({
              application: "website-change-monitor",
              apiVersion: "v1",
              version: "0.1.0",
            }),
          );
        }
        if (input === "/api/health") {
          return Promise.resolve(
            Response.json({
              application: "website-change-monitor",
              status: "degraded",
              version: "0.1.0",
              database: { status: "ready", schemaVersion: 2 },
              telegram: { status: "unavailable", reason: "not_configured" },
            }),
          );
        }
        if (input === "/api/preview") {
          return Promise.resolve(
            Response.json({
              finalUrl: created.url,
              targetMatches: [{ selector: ".card", matchCount: 1 }],
              exclusionSelectors: [],
              targetCount: 1,
              targets: [{ elements: [], visibleText: "Карточка" }],
            }),
          );
        }
        if (input === "/api/monitors" && init?.method === "POST") {
          saved = true;
          return Promise.resolve(Response.json(created, { status: 201 }));
        }
        if (input === "/api/monitors") {
          return Promise.resolve(
            Response.json(
              saved
                ? [
                    {
                      id: created.id,
                      name: created.name,
                      url: created.url,
                      intervalHours: created.intervalHours,
                      scopeRevision: 1,
                      nextCheckAt: created.nextCheckAt,
                      latestCheckResult: "baseline",
                    },
                  ]
                : [],
            ),
          );
        }
        if (input === "/api/monitors/7/checks" && init?.method === "POST") {
          manualRequested = true;
          return Promise.resolve(
            Response.json({
              ...created,
              nextCheckAt: "2026-07-18T09:00:00.000Z",
              history: [
                {
                  ...created.history[0],
                  id: 12,
                  kind: "manual",
                  result: "no_change",
                  startedAt: "2026-07-17T09:00:00.000Z",
                  completedAt: "2026-07-17T09:00:01.000Z",
                  beforeSnapshotId: 3,
                  afterSnapshotId: 3,
                  snapshot: null,
                },
                created.history[0],
              ],
            }),
          );
        }
        if (input === "/api/monitors/7") {
          return Promise.resolve(Response.json(created));
        }
        throw new Error(`Unexpected request: ${String(input)}`);
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);

    fireEvent.change(await screen.findByLabelText("URL страницы"), {
      target: { value: created.url },
    });
    fireEvent.change(
      screen.getByLabelText("Целевой CSS-селектор 1"),
      { target: { value: ".card" } },
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Предпросмотреть" }),
    );
    expect(
      await screen.findByText("Уникальных элементов: 1"),
    ).toBeVisible();

    fireEvent.change(screen.getByLabelText("Имя Монитора"), {
      target: { value: created.name },
    });
    fireEvent.change(screen.getByLabelText("Интервал проверки"), {
      target: { value: "24" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Сохранить Монитор" }),
    );

    expect(await screen.findByRole("cell", { name: "Каталог" })).toBeVisible();
    const historyPanel = screen.getByText("История Монитора").closest("aside");
    expect(historyPanel).not.toBeNull();
    expect(
      await within(historyPanel!).findByText("Базовый снимок"),
    ).toBeVisible();
    expect(within(historyPanel!).getByText(/Следующая Проверка:/u)).toBeVisible();
    fireEvent.click(
      within(historyPanel!).getByRole("button", { name: "Запустить сейчас" }),
    );
    expect(
      await within(historyPanel!).findByText("Ручная проверка · Без изменений"),
    ).toBeVisible();
    expect(manualRequested).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/monitors",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          name: "Каталог",
          url: created.url,
          targetSelectors: [".card"],
          exclusionSelectors: [],
          intervalHours: 24,
        }),
      }),
    );
  });
});
