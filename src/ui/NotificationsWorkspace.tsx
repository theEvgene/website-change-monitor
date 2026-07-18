import { useEffect, useRef, useState } from "react";

import { ComparisonModal, loadComparison, type ComparisonResponse } from "./ComparisonModal.js";
import { telegramDeliveryLabel, type TelegramDeliveryView } from "./telegram-delivery.js";

interface NotificationEvent {
  id: number;
  kind: "change_detected" | "check_failed_final" | "control_check_ok";
  centerVisible: boolean;
  monitorId: number;
  monitorName: string;
  scopeRevision: number;
  checkId: number;
  chainCheckId: number;
  title: string;
  body: string;
  observedAt: string;
  targetPath: string;
  dedupeKey: string;
  telegram: TelegramDeliveryView;
}

interface NotificationFeed { highWaterMark: number; items: NotificationEvent[] }

export function NotificationsWorkspace({ centerVisible, selectedCheckId, onOpenJournal }: { centerVisible: boolean; selectedCheckId: number | undefined; onOpenJournal: (checkId: number) => void }) {
  const [items, setItems] = useState<NotificationEvent[]>([]);
  const [toast, setToast] = useState<NotificationEvent | null>(null);
  const [comparison, setComparison] = useState<ComparisonResponse | null>(null);
  const [permission, setPermission] = useState<NotificationPermission | "unsupported">(
    notificationPermission(),
  );
  const popupSeen = useRef(new Set<number>());

  useEffect(() => {
    const controller = new AbortController();
    let source: EventSource | undefined;
    void Promise.resolve().then(() => fetch("/api/notifications", { headers: { accept: "application/json" }, signal: controller.signal }))
      .then(async (response) => {
        if (!response.ok) throw new Error(`Notification feed failed: ${response.status}`);
        return await response.json() as NotificationFeed;
      })
      .then((feed) => {
        setItems(feed.items.filter((event) => event.centerVisible));
        feed.items.forEach((event) => popupSeen.current.add(event.id));
        if (typeof EventSource === "undefined") return;
        source = new EventSource(`/api/notifications/stream?after=${feed.highWaterMark}`);
        source.addEventListener("replay", (message) => append(JSON.parse((message as MessageEvent<string>).data) as NotificationEvent, false));
        source.addEventListener("reset", (message) => {
          const reset = JSON.parse((message as MessageEvent<string>).data) as NotificationFeed;
          setItems(reset.items.filter((event) => event.centerVisible)); reset.items.forEach((event) => popupSeen.current.add(event.id));
        });
        source.addEventListener("notification", (message) => {
          const event = JSON.parse((message as MessageEvent<string>).data) as NotificationEvent;
          append(event, true);
        });
        source.addEventListener("delivery", (message) => {
          const event = JSON.parse((message as MessageEvent<string>).data) as NotificationEvent;
          setItems((current) => current.map((item) => item.id === event.id ? event : item));
        });
      })
      .catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === "AbortError")) setItems([]);
      });
    return () => { controller.abort(); source?.close(); };
  }, []);

  useEffect(() => {
    const refresh = () => setPermission(notificationPermission());
    window.addEventListener("focus", refresh); document.addEventListener("visibilitychange", refresh);
    return () => { window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", refresh); };
  }, []);

  useEffect(() => {
    if (centerVisible && selectedCheckId !== undefined) void openComparison(selectedCheckId);
  }, [centerVisible, selectedCheckId]);

  return <><section className="journal-panel" aria-label="Уведомления" hidden={!centerVisible}>
    <div className="notifications-toolbar">
      <div>{permissionLabel(permission)} {permission === "default" ? <button type="button" onClick={() => void requestPermission()}>Включить уведомления браузера</button> : null}</div>
    </div>
    {items.length === 0 ? <p className="muted">Уведомлений пока нет.</p> : <table className="dense-table">
      <thead><tr><th>Время</th><th>Монитор</th><th>Событие</th><th>Telegram</th><th>Действие</th></tr></thead>
      <tbody>{[...items].reverse().map((event) => <tr key={event.id}>
        <td>{new Intl.DateTimeFormat("ru-RU", { dateStyle: "short", timeStyle: "short" }).format(new Date(event.observedAt))}</td>
        <td>{event.monitorName}</td><td><strong>{event.title}</strong><br />{event.body}</td>
        <td>{telegramDeliveryLabel(event.telegram.state)}{event.telegram.failureReason === null ? null : <small>{event.telegram.failureReason}</small>}</td>
        <td>{event.kind === "change_detected"
          ? <button className="table-link" type="button" onClick={() => void openComparison(event.checkId)}>Открыть сравнение</button>
          : <button className="table-link" type="button" onClick={() => onOpenJournal(event.checkId)}>Открыть проверку</button>}</td>
      </tr>)}</tbody>
    </table>}
    {comparison === null ? null : <ComparisonModal comparison={comparison} onClose={() => setComparison(null)} />}
  </section>{toast === null ? null : <div className="status-panel" role="status"><strong>{toast.title}</strong><p>{toast.body}</p><button type="button" onClick={() => setToast(null)}>Закрыть</button></div>}</>;

  function append(event: NotificationEvent, live: boolean) {
    if (event.centerVisible) setItems((current) => current.some((item) => item.id === event.id) ? current : [...current, event]);
    if (!live || popupSeen.current.has(event.id)) { popupSeen.current.add(event.id); return; }
    popupSeen.current.add(event.id); deliverBrowserNotification(event, setToast);
  }

  async function requestPermission() {
    if (typeof Notification === "undefined") return;
    setPermission(await Notification.requestPermission());
  }

  async function openComparison(checkId: number) {
    const loaded = await loadComparison(checkId);
    if (loaded !== null) setComparison(loaded);
  }
}

function deliverBrowserNotification(event: NotificationEvent, showToast: (event: NotificationEvent) => void): void {
  if (document.visibilityState === "visible" || notificationPermission() !== "granted") {
    showToast(event); return;
  }
  try {
    const notification = new Notification(event.title, { body: event.body, tag: `website-change-monitor-${event.id}` });
    notification.onclick = () => {
      window.focus(); window.history.pushState({}, "", event.targetPath);
      window.dispatchEvent(new PopStateEvent("popstate")); notification.close();
    };
  } catch { showToast(event); }
}

function notificationPermission(): NotificationPermission | "unsupported" {
  if (typeof Notification === "undefined" || (window.isSecureContext === false)) return "unsupported";
  return Notification.permission;
}

function permissionLabel(permission: NotificationPermission | "unsupported"): string {
  if (permission === "granted") return "Уведомления браузера разрешены.";
  if (permission === "denied") return "Уведомления браузера запрещены в настройках.";
  if (permission === "unsupported") return "Уведомления браузера не поддерживаются.";
  return "Разрешение браузера ещё не запрошено.";
}
