import { useEffect, useState } from "react";

import { PreviewPanel } from "./PreviewPanel.js";
import { MonitorsWorkspace } from "./MonitorsWorkspace.js";
import { JournalWorkspace } from "./JournalWorkspace.js";
import { NotificationsWorkspace } from "./NotificationsWorkspace.js";

interface HealthResponse {
  application: "website-change-monitor";
  status: "ready" | "degraded";
  version: string;
  database: {
    status: "ready";
    schemaVersion: number;
  };
  telegram: {
    status: "available" | "unavailable";
    reason: string | null;
  };
}

interface VersionResponse {
  application: "website-change-monitor";
  apiVersion: "v1";
  version: string;
}

type HealthState =
  | { kind: "loading" }
  | { kind: "loaded"; health: HealthResponse; version: VersionResponse }
  | { kind: "failed" };

export function App() {
  const [state, setState] = useState<HealthState>({ kind: "loading" });
  const [monitorRefresh, setMonitorRefresh] = useState(0);
  const [notifyWhenUnchanged, setNotifyWhenUnchanged] = useState(false);
  const [notificationSettingsReady, setNotificationSettingsReady] = useState(false);
  const [notificationSettingsBusy, setNotificationSettingsBusy] = useState(false);
  const [activeSection, setActiveSection] = useState<"monitors" | "journal" | "notifications">(sectionFromLocation);
  const [selectedCheckId, setSelectedCheckId] = useState<number | undefined>(() => checkFromLocation());
  const [showMonitorDialog, setShowMonitorDialog] = useState(false);
  const [monitorDialogDirty, setMonitorDialogDirty] = useState(false);
  const [showStatusDialog, setShowStatusDialog] = useState(false);
  const [showSettingsDialog, setShowSettingsDialog] = useState(false);

  useEffect(() => {
    const controller = new AbortController();

    const requestOptions = {
      headers: { accept: "application/json" },
      signal: controller.signal,
    };

    void Promise.all([
      fetch("/api/health", requestOptions).then(async (response) => {
        if (!response.ok) {
          throw new Error(`Health request failed: ${response.status}`);
        }
        return (await response.json()) as HealthResponse;
      }),
      fetch("/api/version", requestOptions).then(async (response) => {
        if (!response.ok) {
          throw new Error(`Version request failed: ${response.status}`);
        }
        return (await response.json()) as VersionResponse;
      }),
    ])
      .then(([health, version]) =>
        setState({ kind: "loaded", health, version }),
      )
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") {
          return;
        }
        setState({ kind: "failed" });
      });

    return () => controller.abort();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/settings/notifications", { headers: { accept: "application/json" }, signal: controller.signal })
      .then(async (response) => response.ok ? await response.json() as { notifyWhenUnchanged?: unknown } : undefined)
      .then((settings) => {
        if (typeof settings?.notifyWhenUnchanged === "boolean") setNotifyWhenUnchanged(settings.notifyWhenUnchanged);
        setNotificationSettingsReady(true);
      })
      .catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === "AbortError")) setNotificationSettingsReady(true);
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const navigate = () => { setActiveSection(sectionFromLocation()); setSelectedCheckId(checkFromLocation()); };
    window.addEventListener("popstate", navigate);
    return () => window.removeEventListener("popstate", navigate);
  }, []);

  useEffect(() => {
    const refresh = () => {
      void fetch("/api/telegram", { headers: { accept: "application/json" } })
        .then(async (response) => response.ok ? await response.json() as HealthResponse["telegram"] : undefined)
        .then((telegram) => {
          if (telegram === undefined) return;
          setState((current) => current.kind === "loaded"
            ? { ...current, health: { ...current.health, status: telegram.status === "available" ? "ready" : "degraded", telegram } }
            : current);
        })
        .catch(() => undefined);
    };
    const timer = window.setInterval(refresh, 5_000);
    return () => window.clearInterval(timer);
  }, []);

  const systemStatus = systemStatusPresentation(state);

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="topbar-primary">
          <h1>Website Change Monitor</h1>
          <nav className="top-navigation" aria-label="Основная навигация">
            <button type="button" aria-current={activeSection === "monitors" ? "page" : undefined} onClick={() => setActiveSection("monitors")}>Мониторы</button>
            <button type="button" aria-current={activeSection === "journal" ? "page" : undefined} onClick={() => setActiveSection("journal")}>Журнал</button>
            <button type="button" aria-current={activeSection === "notifications" ? "page" : undefined} onClick={() => setActiveSection("notifications")}>Уведомления</button>
          </nav>
        </div>
        <div className="topbar-actions">
          <button className={`system-status system-status--${systemStatus.tone}`} type="button" aria-label={systemStatus.ariaLabel} title={systemStatus.hint} onClick={() => setShowStatusDialog(true)}>
            <span aria-hidden="true" />
            {systemStatus.shortLabel}
          </button>
          <button className="add-monitor-button" type="button" onClick={() => { setMonitorDialogDirty(false); setShowMonitorDialog(true); }}>Добавить монитор</button>
          <button className="settings-button" type="button" aria-label="Настройки" title="Настройки" onClick={() => setShowSettingsDialog(true)}><span aria-hidden="true">⚙</span></button>
        </div>
      </header>

      <main>
        {activeSection === "monitors" ? <MonitorsWorkspace refreshToken={monitorRefresh} /> : null}
        {activeSection === "journal" ? <JournalWorkspace selectedCheckId={selectedCheckId} /> : null}
        <NotificationsWorkspace centerVisible={activeSection === "notifications"} selectedCheckId={selectedCheckId} onOpenJournal={(checkId) => navigateTo("journal", checkId)} />
      </main>

      {showMonitorDialog ? (
        <div className="app-modal-backdrop" onClick={(event) => { if (event.target === event.currentTarget) requestMonitorDialogClose(); }}>
          <div className="app-modal-dialog app-modal-dialog--wide" role="dialog" aria-modal="true" aria-labelledby="preview-title">
            <button className="modal-close" type="button" aria-label="Закрыть добавление монитора" onClick={requestMonitorDialogClose}>Закрыть</button>
            <PreviewPanel onDirtyChange={setMonitorDialogDirty} onMonitorCreated={() => { setMonitorRefresh((value) => value + 1); setShowMonitorDialog(false); }} />
          </div>
        </div>
      ) : null}
      {showStatusDialog ? (
        <SystemStatusDialog state={state} onClose={() => setShowStatusDialog(false)} onRecheckTelegram={() => void recheckTelegram()} />
      ) : null}
      {showSettingsDialog ? (
        <SettingsDialog
          notifyWhenUnchanged={notifyWhenUnchanged}
          disabled={!notificationSettingsReady || notificationSettingsBusy}
          onChange={(value) => void changeNotificationSetting(value)}
          onClose={() => setShowSettingsDialog(false)}
        />
      ) : null}
    </div>
  );

  function navigateTo(section: "journal" | "notifications", checkId: number) {
    window.history.pushState({}, "", `/?section=${section}&check=${checkId}`);
    setActiveSection(section); setSelectedCheckId(checkId);
  }

  async function recheckTelegram() {
    const response = await fetch("/api/telegram/recheck", { method: "POST", headers: { accept: "application/json" } });
    if (!response.ok || state.kind !== "loaded") return;
    const telegram = await response.json() as HealthResponse["telegram"];
    setState({ ...state, health: { ...state.health, status: telegram.status === "available" ? "ready" : "degraded", telegram } });
  }

  async function changeNotificationSetting(value: boolean) {
    setNotificationSettingsBusy(true);
    try {
      const response = await fetch("/api/settings/notifications", {
        method: "PUT", headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({ notifyWhenUnchanged: value }),
      });
      if (!response.ok) return;
      const settings = await response.json() as { notifyWhenUnchanged: boolean };
      setNotifyWhenUnchanged(settings.notifyWhenUnchanged);
    } finally { setNotificationSettingsBusy(false); }
  }

  function requestMonitorDialogClose() {
    if (monitorDialogDirty && !window.confirm("Внесённые изменения не сохранены и будут потеряны. Закрыть окно?")) return;
    setShowMonitorDialog(false);
    setMonitorDialogDirty(false);
  }
}

function SystemStatusDialog({
  state,
  onClose,
  onRecheckTelegram,
}: {
  state: HealthState;
  onClose: () => void;
  onRecheckTelegram: () => void;
}) {
  return (
    <div className="app-modal-backdrop" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="app-modal-dialog status-dialog" role="dialog" aria-modal="true" aria-labelledby="system-status-title">
        <header className="modal-header">
          <div className="status-dialog-title">
            <h2 id="system-status-title">Состояние системы</h2>
            {state.kind === "loaded" ? <span className="version">v{state.version.version}</span> : null}
          </div>
          <button className="modal-close" type="button" onClick={onClose}>Закрыть</button>
        </header>
        {state.kind === "loading" ? <p>Получаем состояние компонентов…</p> : null}
        {state.kind === "failed" ? <p role="alert">Не удалось получить состояние приложения. Обновите страницу или запустите <code>npm run doctor</code>.</p> : null}
        {state.kind === "loaded" ? (
          <div className="component-grid">
            <article className="component-card">
              <span className="component-dot component-dot--ready" />
              <div>
                <h3>Хранилище</h3>
                <p>SQLite готова · схема {state.health.database.schemaVersion}</p>
              </div>
            </article>
            <article className="component-card">
              <span className={`component-dot ${state.health.telegram.status === "available" ? "component-dot--ready" : "component-dot--warning"}`} />
              <div>
                <h3>Канал уведомлений</h3>
                <p>{state.health.telegram.status === "available" ? "Telegram доступен" : "Telegram пока не настроен"}</p>
                {state.health.telegram.status === "unavailable" ? (
                  <>
                    <small>{state.health.telegram.reason ?? "Канал не настроен."}</small>
                    <button className="secondary-button" type="button" onClick={onRecheckTelegram}>Проверить снова</button>
                  </>
                ) : null}
              </div>
            </article>
          </div>
        ) : null}
      </section>
    </div>
  );
}

function SettingsDialog({
  notifyWhenUnchanged,
  disabled,
  onChange,
  onClose,
}: {
  notifyWhenUnchanged: boolean;
  disabled: boolean;
  onChange: (value: boolean) => void;
  onClose: () => void;
}) {
  return (
    <div className="app-modal-backdrop" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="app-modal-dialog settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <header className="modal-header">
          <h2 id="settings-title">Настройки</h2>
          <button className="modal-close" type="button" onClick={onClose}>Закрыть</button>
        </header>
        <label className="notification-switch settings-option">
          <span>Уведомлять при отсутствии изменений</span>
          <input role="switch" type="checkbox" checked={notifyWhenUnchanged} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
        </label>
      </section>
    </div>
  );
}

function systemStatusPresentation(state: HealthState): {
  tone: "ready" | "warning" | "danger" | "loading";
  ariaLabel: string;
  shortLabel: string;
  hint: string;
} {
  if (state.kind === "loading") {
    return { tone: "loading", ariaLabel: "Состояние системы загружается", shortLabel: "Проверяем", hint: "Получаем состояние локальных компонентов" };
  }
  if (state.kind === "failed") {
    return { tone: "danger", ariaLabel: "Система недоступна", shortLabel: "Ошибка", hint: "Не удалось получить состояние приложения через локальный API" };
  }
  if (state.health.status === "ready") {
    return { tone: "ready", ariaLabel: "Система работает", shortLabel: "Система готова", hint: "SQLite и Telegram доступны" };
  }
  return {
    tone: "warning",
    ariaLabel: "Система работает с ограничениями",
    shortLabel: "Есть ограничения",
    hint: `Telegram недоступен: ${state.health.telegram.reason ?? "канал не настроен"}`,
  };
}

function sectionFromLocation(): "monitors" | "journal" | "notifications" {
  const section = new URLSearchParams(window.location.search).get("section");
  return section === "journal" || section === "notifications" ? section : "monitors";
}

function checkFromLocation(): number | undefined {
  const value = Number(new URLSearchParams(window.location.search).get("check"));
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}
