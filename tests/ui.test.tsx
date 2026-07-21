// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
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
    const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
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

      if (input === "/api/telegram/recheck") {
        return Promise.resolve(Response.json({ status: "available", reason: null }));
      }
      if (input === "/api/settings/notifications") {
        return Promise.resolve(Response.json({ notifyWhenUnchanged: init?.method === "PUT" }));
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

    const systemStatus = await screen.findByRole("button", { name: "Система работает с ограничениями" });
    expect(systemStatus).toBeVisible();
    expect(screen.queryByText("SQLite готова · схема 1")).not.toBeInTheDocument();
    fireEvent.click(systemStatus);
    const statusDialog = screen.getByRole("dialog", { name: "Состояние системы" });
    expect(statusDialog).toHaveTextContent("SQLite готова · схема 1");
    expect(statusDialog).toHaveTextContent("Telegram пока не настроен");
    expect(statusDialog).toHaveTextContent("v0.1.0");
    expect(statusDialog).not.toHaveTextContent("Диагностика");
    fireEvent.click(screen.getByRole("button", { name: "Проверить снова" }));
    expect(await screen.findByText("Telegram доступен")).toBeVisible();
    fireEvent.click(within(statusDialog).getByRole("button", { name: "Закрыть" }));
    expect(screen.queryByRole("switch", { name: "Уведомлять при отсутствии изменений" })).not.toBeInTheDocument();
    const settingsButton = screen.getByRole("button", { name: "Настройки" });
    expect(settingsButton).toHaveAttribute("title", "Настройки");
    fireEvent.click(settingsButton);
    expect(screen.getByRole("dialog", { name: "Настройки" })).toBeVisible();
    const controlSwitch = await screen.findByRole("switch", { name: "Уведомлять при отсутствии изменений" });
    expect(controlSwitch).not.toBeChecked();
    fireEvent.click(controlSwitch);
    await waitFor(() => expect(controlSwitch).toBeChecked());
    expect(fetchMock).toHaveBeenCalledWith("/api/settings/notifications", expect.objectContaining({ method: "PUT", body: JSON.stringify({ notifyWhenUnchanged: true }) }));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/health",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/version",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("closes dialogs from the backdrop and protects an edited monitor form", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation((input: RequestInfo | URL) => Promise.resolve(
      input === "/api/settings/notifications"
        ? Response.json({ notifyWhenUnchanged: false })
        : input === "/api/version"
          ? Response.json({ application: "website-change-monitor", apiVersion: "v1", version: "0.1.0" })
          : Response.json({
              application: "website-change-monitor",
              status: "ready",
              version: "0.1.0",
              database: { status: "ready", schemaVersion: 1 },
              telegram: { status: "available", reason: null },
            }),
    )));
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const { container } = render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Добавить монитор" }));
    const monitorDialog = screen.getByRole("dialog", { name: "Проверить Область наблюдения" });
    fireEvent.click(within(monitorDialog).getByRole("button", { name: "Закрыть добавление монитора" }));
    expect(screen.queryByRole("dialog", { name: "Проверить Область наблюдения" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Добавить монитор" }));
    fireEvent.change(screen.getByRole("textbox", { name: "URL страницы" }), { target: { value: "https://example.com" } });
    const backdrop = container.querySelector(".app-modal-backdrop");
    expect(backdrop).not.toBeNull();
    fireEvent.click(backdrop!);
    expect(confirm).toHaveBeenCalledWith("Внесённые изменения не сохранены и будут потеряны. Закрыть окно?");
    expect(screen.getByRole("dialog", { name: "Проверить Область наблюдения" })).toBeVisible();

    confirm.mockReturnValue(true);
    fireEvent.click(backdrop!);
    expect(screen.queryByRole("dialog", { name: "Проверить Область наблюдения" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Система работает" }));
    const statusDialog = screen.getByRole("dialog", { name: "Состояние системы" });
    fireEvent.click(statusDialog);
    expect(statusDialog).toBeVisible();
    fireEvent.click(statusDialog.parentElement!);
    expect(screen.queryByRole("dialog", { name: "Состояние системы" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Настройки" }));
    const settingsDialog = screen.getByRole("dialog", { name: "Настройки" });
    fireEvent.click(settingsDialog);
    expect(settingsDialog).toBeVisible();
    fireEvent.click(settingsDialog.parentElement!);
    expect(screen.queryByRole("dialog", { name: "Настройки" })).not.toBeInTheDocument();
  });

  it("previews repeatable target and exclusion selectors through the public API", async () => {
    const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
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

    fireEvent.click(await screen.findByRole("button", { name: "Добавить монитор" }));
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

    fireEvent.click(await screen.findByRole("button", { name: "Добавить монитор" }));
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
      paused: false,
      nextCheckAt: "2026-07-18T08:00:00.000Z",
      activeIntent: {
        kind: "scheduled", state: "queued",
        dueAt: "2026-07-18T08:00:00.000Z",
      },
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
    let finishManualCheck!: () => void;
    const manualCheckGate = new Promise<void>((resolve) => { finishManualCheck = resolve; });
    let paused = false;
    let pauseFailures = 1;
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
        if (input === "/api/labels") return Promise.resolve(Response.json(["existing", "Новости"]));
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
                      activeIntent: created.activeIntent,
                      paused,
                    },
                  ]
                : [],
            ),
          );
        }
        if (input === "/api/monitors/7/checks" && init?.method === "POST") {
          manualRequested = true;
          return manualCheckGate.then(() =>
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
        if (input === "/api/monitors/7/pause" && init?.method === "POST") {
          if (pauseFailures > 0) {
            pauseFailures -= 1;
            return Promise.resolve(Response.json({}, { status: 500 }));
          }
          paused = true;
          return Promise.resolve(Response.json({ ...created, paused }));
        }
        if (input === "/api/monitors/7/resume" && init?.method === "POST") {
          paused = false;
          return Promise.resolve(Response.json({ ...created, paused }));
        }
        if (input === "/api/monitors/7") {
          return Promise.resolve(Response.json({ ...created, paused }));
        }
        if (input === "/api/settings/notifications") return Promise.resolve(Response.json({ notifyWhenUnchanged: false }));
        throw new Error(`Unexpected request: ${String(input)}`);
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Добавить монитор" }));
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
    const labelsInput = screen.getByRole("combobox", { name: "Метки" });
    fireEvent.focus(labelsInput);
    fireEvent.change(labelsInput, { target: { value: "EX" } });
    fireEvent.click(await screen.findByRole("button", { name: "Добавить метку existing" }));
    fireEvent.change(labelsInput, { target: { value: "Новая" } });
    fireEvent.keyDown(labelsInput, { key: "Enter" });
    expect(screen.getByRole("button", { name: "Удалить метку existing" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Удалить метку Новая" })).toBeVisible();
    fireEvent.click(
      screen.getByRole("button", { name: "Сохранить Монитор" }),
    );

    expect(await screen.findByRole("cell", { name: "Каталог" })).toBeVisible();
    const monitorsWorkspace = screen.getByRole("region", { name: "Мониторы" });
    expect(within(monitorsWorkspace).queryByRole("heading", { name: "Сохранённые Мониторы" })).not.toBeInTheDocument();
    expect(within(monitorsWorkspace).getByRole("combobox", { name: "Фильтр по метке" })).toBeVisible();
    expect(within(monitorsWorkspace).getByRole("columnheader", { name: "Последний результат" })).toBeVisible();
    expect(within(monitorsWorkspace).getByRole("columnheader", { name: "Состояние" })).toBeVisible();
    expect(within(monitorsWorkspace).getByRole("cell", { name: "Включён" })).toBeVisible();
    const historyPanel = screen.getByText("История Монитора").closest("aside");
    expect(historyPanel).not.toBeNull();
    expect(
      await within(historyPanel!).findByText("Базовый снимок"),
    ).toBeVisible();
    expect(within(historyPanel!).getByText(/Следующая Проверка:/u)).toBeVisible();
    expect(within(historyPanel!).getByText("Ожидает: Плановая проверка")).toBeVisible();
    fireEvent.click(within(historyPanel!).getByRole("button", { name: "Приостановить" }));
    expect(await within(historyPanel!).findByRole("alert")).toHaveTextContent("Не удалось приостановить");
    fireEvent.click(within(historyPanel!).getByRole("button", { name: "Приостановить" }));
    expect(await within(historyPanel!).findByText("Автоматические Проверки приостановлены")).toBeVisible();
    expect(within(monitorsWorkspace).getByRole("cell", { name: "Приостановлен" })).toBeVisible();
    fireEvent.click(within(historyPanel!).getByRole("button", { name: "Возобновить" }));
    expect(await within(historyPanel!).findByRole("button", { name: "Приостановить" })).toBeVisible();
    expect(within(monitorsWorkspace).getByRole("cell", { name: "Включён" })).toBeVisible();
    fireEvent.click(
      within(historyPanel!).getByRole("button", { name: "Запустить сейчас" }),
    );
    const loadingMonitorButton = within(historyPanel!).getByRole("button", { name: "Проверка выполняется…" });
    expect(loadingMonitorButton).toBeDisabled();
    expect(loadingMonitorButton.querySelector(".button-spinner")).not.toBeNull();
    finishManualCheck();
    expect(
      await within(historyPanel!).findByText("Ручная проверка · Без изменений"),
    ).toBeVisible();
    expect(await screen.findByRole("status")).toHaveTextContent("Проверка выполнена.");
    expect(within(historyPanel!).getByRole("button", { name: "Запустить сейчас" })).toBeEnabled();
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
          labels: ["existing", "Новая"],
        }),
      }),
    );
  });

  it("opens a Comparison from the Journal and returns to the same context", async () => {
    let finishManualCheck!: () => void;
    const manualCheckGate = new Promise<void>((resolve) => { finishManualCheck = resolve; });
    const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      if (input === "/api/version") {
        return Promise.resolve(Response.json({
          application: "website-change-monitor", apiVersion: "v1", version: "0.1.0",
        }));
      }
      if (input === "/api/health") {
        return Promise.resolve(Response.json({
          application: "website-change-monitor", status: "degraded", version: "0.1.0",
          database: { status: "ready", schemaVersion: 3 },
          telegram: { status: "unavailable", reason: "not_configured" },
        }));
      }
      if (input === "/api/monitors/7/checks" && init?.method === "POST") {
        return manualCheckGate.then(() => Response.json({ id: 7 }));
      }
      if (input === "/api/monitors") return Promise.resolve(Response.json([]));
      if (input === "/api/checks") {
        return Promise.resolve(Response.json([{
          id: 22, monitorId: 7, monitorName: "Catalog", kind: "manual",
          url: "https://example.com/catalog",
          status: "succeeded", result: "change",
          startedAt: "2026-07-17T09:00:00.000Z",
          completedAt: "2026-07-17T09:00:01.000Z",
          errorCode: null, errorMessage: null,
          beforeSnapshotId: 3, afterSnapshotId: 4,
        }, {
          id: 21, monitorId: 7, monitorName: "Catalog", kind: "scheduled",
          url: "https://example.com/catalog",
          status: "succeeded", result: "no_change",
          startedAt: "2026-07-17T08:00:00.000Z",
          completedAt: "2026-07-17T08:00:01.000Z",
          errorCode: null, errorMessage: null,
          beforeSnapshotId: 3, afterSnapshotId: 3,
          isFinalError: false,
        }, {
          id: 20, monitorId: 7, monitorName: "Catalog", kind: "retry",
          url: "https://example.com/catalog",
          status: "failed", result: "error",
          startedAt: "2026-07-17T07:00:00.000Z",
          completedAt: "2026-07-17T07:00:01.000Z",
          errorCode: "navigation_failed", errorMessage: "Ошибка навигации.",
          beforeSnapshotId: null, afterSnapshotId: null,
          isFinalError: true,
        }]));
      }
      if (input === "/api/checks/22/comparison") {
        return Promise.resolve(Response.json({
          checkId: 22, monitorId: 7, monitorName: "Catalog",
          beforeSnapshotId: 3, afterSnapshotId: 4, complete: true,
          targets: [{
            kind: "replace",
            structure: [{ kind: "equal", before: "html:div", after: "html:div" }],
            text: [
              { kind: "replace", before: "Old product", after: "New product" },
              { kind: "delete", before: "Removed product", after: null },
              { kind: "insert", before: null, after: "Added product" },
            ],
          }],
        }));
      }
      if (input === "/api/settings/notifications") return Promise.resolve(Response.json({ notifyWhenUnchanged: false }));
      throw new Error(`Unexpected request: ${String(input)}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Журнал" }));
    const journal = screen.getByRole("region", { name: "Журнал" });
    expect(within(journal).queryByRole("heading", { name: "Журнал" })).not.toBeInTheDocument();
    expect(within(journal).queryByText("Все проверки")).not.toBeInTheDocument();
    const resultFilter = within(journal).getByRole("combobox", { name: "Результат" });
    expect(resultFilter).toHaveValue("change");
    expect(await within(journal).findByRole("cell", { name: "Catalog" })).toBeVisible();
    expect(within(journal).queryByRole("cell", { name: "Окончательная ошибка" })).not.toBeInTheDocument();
    const monitorLinks = within(journal).getAllByRole("link", { name: "Catalog" });
    expect(monitorLinks[0]).toHaveAttribute("href", "https://example.com/catalog");
    expect(monitorLinks[0]).toHaveAttribute("target", "_blank");
    expect(monitorLinks[0]).toHaveAttribute("rel", "noopener noreferrer");
    const journalCheckButton = within(journal).getByRole("button", { name: "Запустить сейчас: Catalog" });
    fireEvent.click(journalCheckButton);
    const loadingJournalButton = within(journal).getByRole("button", { name: "Проверка выполняется: Catalog" });
    expect(loadingJournalButton).toBeDisabled();
    expect(loadingJournalButton.querySelector(".button-spinner")).not.toBeNull();
    finishManualCheck();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/monitors/7/checks", expect.objectContaining({ method: "POST" })));
    expect(await screen.findByRole("status")).toHaveTextContent("Проверка выполнена.");
    expect(within(journal).queryByText("Проверка выполнена.")).not.toBeInTheDocument();
    expect(within(journal).getByRole("button", { name: "Запустить сейчас: Catalog" })).toBeEnabled();

    fireEvent.change(resultFilter, { target: { value: "error" } });
    expect(within(journal).getByRole("cell", { name: "Окончательная ошибка" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Мониторы" }));
    fireEvent.click(screen.getByRole("button", { name: "Журнал" }));
    expect(within(screen.getByRole("region", { name: "Журнал" })).getByRole("combobox", { name: "Результат" })).toHaveValue("error");
    fireEvent.change(screen.getByRole("combobox", { name: "Результат" }), { target: { value: "change" } });
    await within(screen.getByRole("region", { name: "Журнал" })).findByRole("cell", { name: "Catalog" });

    const comparisonButtons = screen.getAllByRole("button", { name: "Открыть сравнение" });
    expect(comparisonButtons).toHaveLength(1);
    fireEvent.click(comparisonButtons[0]!);

    const dialog = await screen.findByRole("dialog", { name: "Сравнение" });
    expect(within(dialog).getByText("Old product")).toHaveClass("diff-before");
    expect(within(dialog).getByText("New product")).toHaveClass("diff-after");
    const deletedRow = within(dialog).getByText("Removed product").closest(".diff-row");
    const insertedRow = within(dialog).getByText("Added product").closest(".diff-row");
    expect(deletedRow?.querySelectorAll("pre")[0]).toHaveClass("diff-before");
    expect(deletedRow?.querySelectorAll("pre")[1]).not.toHaveClass("diff-after");
    expect(insertedRow?.querySelectorAll("pre")[0]).not.toHaveClass("diff-before");
    expect(insertedRow?.querySelectorAll("pre")[1]).toHaveClass("diff-after");
    expect(within(dialog).queryByText("html:div")).not.toBeInTheDocument();
    expect(within(dialog).queryByText(/Целевая область/u)).not.toBeInTheDocument();
    expect(within(dialog).queryByText(/Проверка #/u)).not.toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Закрыть" }));
    expect(screen.queryByRole("dialog", { name: "Сравнение" })).toBeNull();
    expect(screen.getAllByRole("cell", { name: "Catalog" })[0]).toBeVisible();
  });
});
