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
    status: "unavailable";
    reason: "not_configured";
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
  const [activeSection, setActiveSection] = useState<"monitors" | "journal" | "notifications">(sectionFromLocation);
  const [selectedCheckId, setSelectedCheckId] = useState<number | undefined>(() => checkFromLocation());

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
    const navigate = () => { setActiveSection(sectionFromLocation()); setSelectedCheckId(checkFromLocation()); };
    window.addEventListener("popstate", navigate);
    return () => window.removeEventListener("popstate", navigate);
  }, []);

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Локальное приложение</p>
          <h1>Website Change Monitor</h1>
        </div>
        {state.kind === "loaded" ? (
          <span className="version">Версия {state.version.version}</span>
        ) : null}
      </header>

      <nav className="top-navigation" aria-label="Основная навигация">
        <button type="button" aria-current={activeSection === "monitors" ? "page" : undefined} onClick={() => setActiveSection("monitors")}>Мониторы</button>
        <button type="button" aria-current={activeSection === "journal" ? "page" : undefined} onClick={() => setActiveSection("journal")}>Журнал</button>
        <button type="button" aria-current={activeSection === "notifications" ? "page" : undefined} onClick={() => setActiveSection("notifications")}>Уведомления</button>
      </nav>

      <main>
        {activeSection === "monitors" ? <>
        <section className="status-panel" aria-live="polite">
          <p className="eyebrow">Состояние системы</p>
          {state.kind === "loading" ? <h2>Проверяем состояние…</h2> : null}
          {state.kind === "failed" ? (
            <>
              <h2>Не удалось получить состояние приложения</h2>
              <p className="muted">Обновите страницу или запустите диагностику.</p>
            </>
          ) : null}
          {state.kind === "loaded" ? (
            <>
              <div className="headline-row">
                <h2>
                  {state.health.status === "degraded"
                    ? "Приложение работает с ограничениями"
                    : "Приложение готово"}
                </h2>
                <span className="status-badge status-badge--warning">
                  Требуется внимание
                </span>
              </div>
              <p className="muted">
                Основные локальные компоненты запущены. Необязательные каналы можно
                настроить позднее.
              </p>
              <div className="component-grid">
                <article className="component-card">
                  <span className="component-dot component-dot--ready" />
                  <div>
                    <h3>Хранилище</h3>
                    <p>
                      SQLite готова · схема {state.health.database.schemaVersion}
                    </p>
                  </div>
                </article>
                <article className="component-card">
                  <span className="component-dot component-dot--warning" />
                  <div>
                    <h3>Канал уведомлений</h3>
                    <p>Telegram пока не настроен</p>
                  </div>
                </article>
              </div>
            </>
          ) : null}
        </section>
        <PreviewPanel onMonitorCreated={() => setMonitorRefresh((value) => value + 1)} />
        <MonitorsWorkspace refreshToken={monitorRefresh} />
        </> : null}
        {activeSection === "journal" ? <JournalWorkspace selectedCheckId={selectedCheckId} /> : null}
        <NotificationsWorkspace centerVisible={activeSection === "notifications"} selectedCheckId={selectedCheckId} onOpenJournal={(checkId) => navigateTo("journal", checkId)} />
      </main>
    </div>
  );

  function navigateTo(section: "journal" | "notifications", checkId: number) {
    window.history.pushState({}, "", `/?section=${section}&check=${checkId}`);
    setActiveSection(section); setSelectedCheckId(checkId);
  }
}

function sectionFromLocation(): "monitors" | "journal" | "notifications" {
  const section = new URLSearchParams(window.location.search).get("section");
  return section === "journal" || section === "notifications" ? section : "monitors";
}

function checkFromLocation(): number | undefined {
  const value = Number(new URLSearchParams(window.location.search).get("check"));
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}
