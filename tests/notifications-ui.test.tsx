// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { NotificationsWorkspace } from "../src/ui/NotificationsWorkspace.js";

class FakeEventSource {
  static latest: FakeEventSource;
  readonly listeners = new Map<string, (event: MessageEvent<string>) => void>();
  constructor(readonly url: string) { FakeEventSource.latest = this; }
  addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
    this.listeners.set(type, listener as (event: MessageEvent<string>) => void);
  }
  close = vi.fn();
  emit(value: unknown, type = "notification") { this.listeners.get(type)?.(new MessageEvent(type, { data: JSON.stringify(value) })); }
}

const first = {
  id: 1, kind: "change_detected", centerVisible: true, monitorId: 7, monitorName: "Каталог",
  url: "https://example.com/catalog",
  scopeRevision: 1, checkId: 10, chainCheckId: 10,
  title: "Обнаружено изменение", body: "Монитор «Каталог»: страница изменилась.",
  observedAt: "2026-07-17T10:00:00.000Z", targetPath: "/?section=notifications&check=10",
  dedupeKey: "change:10",
  telegram: { state: "delivered", failureReason: null },
} as const;

describe("Notifications UI", () => {
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.history.replaceState({}, "", "/"); Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" }); });

  it("loads the high-water mark, asks permission only by button, and deduplicates SSE replay", async () => {
    const requestPermission = vi.fn().mockResolvedValue("granted");
    vi.stubGlobal("Notification", class { static permission = "default"; static requestPermission = requestPermission; });
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ highWaterMark: 1, items: [first] })));
    render(<NotificationsWorkspace centerVisible selectedCheckId={undefined} onOpenJournal={vi.fn()} />);

    expect(await screen.findByText("Монитор «Каталог»: страница изменилась.")).toBeVisible();
    await waitFor(() => expect(FakeEventSource.latest.url).toBe("/api/notifications/stream?after=1"));
    expect(requestPermission).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Включить уведомления браузера" }));
    await waitFor(() => expect(requestPermission).toHaveBeenCalledOnce());

    const replay = { ...first, id: 2, checkId: 11, chainCheckId: 11, dedupeKey: "change:11", body: "Пропущенное событие" };
    FakeEventSource.latest.emit(replay, "replay");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    const second = { ...replay, id: 3, checkId: 12, chainCheckId: 12, dedupeKey: "change:12", body: "Новое событие" };
    FakeEventSource.latest.emit(second); FakeEventSource.latest.emit(second);
    expect(await screen.findByRole("status")).toHaveTextContent("Новое событие");
    expect(screen.getAllByRole("row")).toHaveLength(4);
    const control = { ...second, id: 4, kind: "control_check_ok", centerVisible: false, checkId: 13, chainCheckId: 13, dedupeKey: "control:13", title: "Проверка завершена без изменений", body: "Изменений не обнаружено" };
    FakeEventSource.latest.emit(control);
    expect(await screen.findByRole("status")).toHaveTextContent("Изменений не обнаружено");
    expect(screen.getAllByRole("row")).toHaveLength(4);
    FakeEventSource.latest.emit({ ...second, telegram: { state: "temporary", failureReason: "Telegram недоступен." } }, "delivery");
    expect(await screen.findByText("Telegram недоступен.")).toBeVisible();
    expect(screen.getAllByText("Не отправлено")).toHaveLength(1);
  });

  it("uses one tagged system notification for a background event", async () => {
    const constructed = vi.fn();
    class FakeNotification {
      static permission = "granted";
      static requestPermission = vi.fn();
      static latest: FakeNotification;
      onclick: (() => void) | null = null;
      close = vi.fn();
      constructor(title: string, options?: NotificationOptions) { FakeNotification.latest = this; constructed(title, options); }
    }
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    const comparison = { checkId: 10, monitorId: 7, monitorName: "Каталог", beforeSnapshotId: 1, afterSnapshotId: 2, complete: true, targets: [] };
    vi.stubGlobal("Notification", FakeNotification);
    vi.spyOn(window, "focus").mockImplementation(() => undefined);
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal("fetch", vi.fn().mockImplementation((input: RequestInfo | URL) => Promise.resolve(input === "/api/notifications" ? Response.json({ highWaterMark: 0, items: [] }) : Response.json(comparison))));
    const view = render(<NotificationsWorkspace centerVisible selectedCheckId={undefined} onOpenJournal={vi.fn()} />);
    await waitFor(() => expect(FakeEventSource.latest.url).toContain("after=0"));
    FakeEventSource.latest.emit(first); FakeEventSource.latest.emit(first);
    await waitFor(() => expect(constructed).toHaveBeenCalledOnce());
    expect(constructed).toHaveBeenCalledWith("Обнаружено изменение", expect.objectContaining({ tag: "website-change-monitor-1" }));
    FakeNotification.latest.onclick?.();
    expect(window.location.search).toBe("?section=notifications&check=10");
    view.rerender(<NotificationsWorkspace centerVisible selectedCheckId={10} onOpenJournal={vi.fn()} />);
    expect(await screen.findByRole("dialog", { name: "Сравнение" })).toBeVisible();
  });

  it("shows denied permission and navigates each event to its context", async () => {
    class DeniedNotification { static permission = "denied"; static requestPermission = vi.fn(); }
    const openJournal = vi.fn();
    const failure = { ...first, id: 2, kind: "check_failed_final", checkId: 12, chainCheckId: 11, title: "Проверка завершилась ошибкой", body: "Ошибка", dedupeKey: "final-error:11", targetPath: "/?section=journal&check=12" };
    const comparison = { checkId: 10, monitorId: 7, monitorName: "Каталог", beforeSnapshotId: 1, afterSnapshotId: 2, complete: true, targets: [] };
    const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL) => Promise.resolve(
      input === "/api/notifications" ? Response.json({ highWaterMark: 2, items: [first, failure] }) : Response.json(comparison),
    ));
    vi.stubGlobal("Notification", DeniedNotification); vi.stubGlobal("EventSource", FakeEventSource); vi.stubGlobal("fetch", fetchMock);
    render(<NotificationsWorkspace centerVisible selectedCheckId={undefined} onOpenJournal={openJournal} />);
    expect(await screen.findByText("Уведомления браузера запрещены в настройках.")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Открыть Сравнение" }));
    expect(await screen.findByRole("dialog", { name: "Сравнение" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Открыть Проверку" }));
    expect(openJournal).toHaveBeenCalledWith(12);
    expect(DeniedNotification.requestPermission).not.toHaveBeenCalled();
    DeniedNotification.permission = "default";
    fireEvent.focus(window);
    expect(await screen.findByRole("button", { name: "Включить уведомления браузера" })).toBeVisible();
  });
});
