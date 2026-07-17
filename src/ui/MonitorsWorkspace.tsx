import { useEffect, useState } from "react";

import {
  ComparisonModal,
  hasComparableSnapshots,
  loadComparison,
  type ComparisonResponse,
} from "./ComparisonModal.js";

interface MonitorSummary {
  id: number;
  name: string;
  url: string;
  intervalHours: number;
  scopeRevision: number;
  nextCheckAt: string | null;
  latestCheckResult: "baseline" | "no_change" | "change" | "error" | null;
  activeIntent: ActiveIntent | null;
  paused: boolean;
}

interface ActiveIntent {
  kind: "scheduled" | "overdue" | "manual" | "retry";
  state: "queued" | "running";
  dueAt: string;
}

interface MonitorCheck {
  id: number;
  kind: "scheduled" | "overdue" | "manual" | "retry";
  status: "running" | "succeeded" | "failed";
  result: "baseline" | "no_change" | "change" | "error" | null;
  startedAt: string;
  completedAt: string | null;
  errorMessage: string | null;
  beforeSnapshotId: number | null;
  afterSnapshotId: number | null;
  isFinalError: boolean;
}

interface MonitorDetail extends MonitorSummary {
  targetSelectors: string[];
  exclusionSelectors: string[];
  history: MonitorCheck[];
}

export function MonitorsWorkspace({ refreshToken }: { refreshToken: number }) {
  const [monitors, setMonitors] = useState<MonitorSummary[]>([]);
  const [selected, setSelected] = useState<MonitorDetail | null>(null);
  const [manualBusy, setManualBusy] = useState(false);
  const [manualError, setManualError] = useState<string | null>(null);
  const [pauseBusy, setPauseBusy] = useState(false);
  const [comparison, setComparison] = useState<ComparisonResponse | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/monitors", {
      headers: { accept: "application/json" },
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Monitor list failed: ${response.status}`);
        const body = (await response.json()) as unknown;
        return Array.isArray(body) ? (body as MonitorSummary[]) : [];
      })
      .then((items) => {
        setMonitors(items);
        const selectedId = items.find((item) => item.id === selected?.id)?.id ?? items[0]?.id;
        if (selectedId === undefined) setSelected(null);
        else void loadMonitor(selectedId, controller.signal, setSelected);
      })
      .catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          setMonitors([]);
          setSelected(null);
        }
      });
    return () => controller.abort();
  }, [refreshToken]);

  return (
    <section className="monitors-workspace" aria-labelledby="monitors-title">
      <div className="monitors-table-panel">
        <p className="eyebrow">Мониторы</p>
        <h2 id="monitors-title">Сохранённые Мониторы</h2>
        {monitors.length === 0 ? (
          <p className="muted">Сохранённых Мониторов пока нет.</p>
        ) : (
          <table className="dense-table">
            <thead>
              <tr>
                <th>Монитор</th><th>Интервал</th><th>Последняя Проверка</th><th>Состояние</th><th>Следующая Проверка</th>
              </tr>
            </thead>
            <tbody>
              {monitors.map((monitor) => (
                <tr key={monitor.id}>
                  <td><button className="table-link" type="button" onClick={() => void loadMonitor(monitor.id, undefined, setSelected)}>{monitor.name}</button></td>
                  <td>{monitor.intervalHours} ч</td>
                  <td>{resultLabel(monitor.latestCheckResult)}</td>
                  <td>{monitor.paused ? "Приостановлен" : activeIntentLabel(monitor.activeIntent)}</td>
                  <td>{formatDate(monitor.nextCheckAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <aside className="monitor-history" aria-live="polite">
        <p className="eyebrow">История Монитора</p>
        {selected === null ? <p className="muted">Выберите Монитор в таблице.</p> : (
          <>
            <h2>{selected.name}</h2>
            <p className="monitor-next-check">Следующая Проверка: {formatDate(selected.nextCheckAt)}</p>
            {selected.paused ? <p className="status-badge status-badge--warning">Автоматические Проверки приостановлены</p> : null}
            {selected.activeIntent == null ? null : (
              <p className="monitor-queue-state">{activeIntentLabel(selected.activeIntent)}</p>
            )}
            <button
              className="secondary-button"
              type="button"
              disabled={manualBusy}
              onClick={() => void requestManualCheck(selected.id)}
            >
              {manualBusy ? "Проверка выполняется…" : "Запустить сейчас"}
            </button>
            <button
              className="secondary-button"
              type="button"
              disabled={pauseBusy}
              onClick={() => void changePaused(selected.id, !selected.paused)}
            >
              {selected.paused ? "Возобновить" : "Приостановить"}
            </button>
            {manualError === null ? null : (
              <p className="form-error" role="alert">{manualError}</p>
            )}
            <dl className="monitor-settings">
              <div><dt>URL</dt><dd>{selected.url}</dd></div>
              <div><dt>Область наблюдения</dt><dd>ревизия {selected.scopeRevision}</dd></div>
            </dl>
            <ol className="history-list">
              {selected.history.map((check) => (
                <li key={check.id}>
                  <strong>{checkLabel(check)}</strong>
                  <span>{formatDate(check.completedAt ?? check.startedAt)}</span>
                  {check.errorMessage === null ? null : <small>{check.errorMessage}</small>}
                  {hasComparableSnapshots(check) ? (
                    <button className="table-link" type="button" onClick={() => void openComparison(check.id)}>
                      Открыть Сравнение
                    </button>
                  ) : null}
                </li>
              ))}
            </ol>
          </>
        )}
      </aside>
      {comparison === null ? null : <ComparisonModal comparison={comparison} onClose={() => setComparison(null)} />}
    </section>
  );

  async function openComparison(checkId: number) {
    const loaded = await loadComparison(checkId);
    if (loaded !== null) setComparison(loaded);
  }

  async function requestManualCheck(id: number) {
    setManualBusy(true);
    setManualError(null);
    try {
      const response = await fetch(`/api/monitors/${id}/checks`, {
        method: "POST",
        headers: { accept: "application/json" },
      });
      if (!response.ok) {
        throw new Error(`Manual Check failed: ${response.status}`);
      }
      const monitor = (await response.json()) as MonitorDetail;
      setSelected(monitor);
      setMonitors((items) =>
        items.map((item) =>
          item.id === monitor.id
            ? {
                ...item,
                nextCheckAt: monitor.nextCheckAt,
                latestCheckResult: monitor.history[0]?.result ?? null,
              }
            : item,
        ),
      );
    } catch {
      setManualError("Не удалось выполнить Ручную проверку.");
    } finally {
      setManualBusy(false);
    }
  }

  async function changePaused(id: number, paused: boolean) {
    setPauseBusy(true);
    try {
      const response = await fetch(`/api/monitors/${id}/${paused ? "pause" : "resume"}`, {
        method: "POST", headers: { accept: "application/json" },
      });
      if (!response.ok) throw new Error(`Pause state failed: ${response.status}`);
      const monitor = (await response.json()) as MonitorDetail;
      setSelected(monitor);
      setMonitors((items) => items.map((item) => item.id === id
        ? { ...item, paused: monitor.paused, nextCheckAt: monitor.nextCheckAt, activeIntent: monitor.activeIntent }
        : item));
    } finally {
      setPauseBusy(false);
    }
  }
}

async function loadMonitor(id: number, signal: AbortSignal | undefined, update: (monitor: MonitorDetail | null) => void) {
  try {
    const response = await fetch(`/api/monitors/${id}`, {
      headers: { accept: "application/json" },
      ...(signal === undefined ? {} : { signal }),
    });
    if (!response.ok) throw new Error(`Monitor detail failed: ${response.status}`);
    update((await response.json()) as MonitorDetail);
  } catch (error: unknown) {
    if (!(error instanceof DOMException && error.name === "AbortError")) update(null);
  }
}

function resultLabel(result: MonitorCheck["result"]): string {
  if (result === "baseline") return "Базовый снимок";
  if (result === "no_change") return "Без изменений";
  if (result === "change") return "Обнаружено Изменение";
  if (result === "error") return "Ошибка";
  return "Ожидается";
}

function checkLabel(check: MonitorCheck): string {
  if (check.result === "error" && check.isFinalError) return "Окончательная ошибка";
  const result =
    check.status === "running" ? "Выполняется" : resultLabel(check.result);
  if (check.kind === "manual") return `Ручная проверка · ${result}`;
  if (check.kind === "retry") return `Повторная проверка · ${result}`;
  if (check.kind === "overdue") return `Просроченная проверка · ${result}`;
  return result;
}

function formatDate(value: string | null): string {
  if (value === null) return "не назначена";
  return new Intl.DateTimeFormat("ru-RU", {
    dateStyle: "short", timeStyle: "short", timeZone: "Europe/Moscow",
  }).format(new Date(value));
}

function activeIntentLabel(intent: ActiveIntent | null | undefined): string {
  if (intent == null) return "Нет ожидающей Проверки";
  const state = intent.state === "running" ? "Выполняется" : "Ожидает";
  if (intent.kind === "manual") return `${state}: Ручная проверка`;
  if (intent.kind === "retry") return `${state}: Повторная проверка`;
  if (intent.kind === "overdue") return `${state}: Просроченная проверка`;
  return `${state}: Плановая проверка`;
}
