import { useEffect, useState } from "react";

import {
  ComparisonModal,
  hasComparableSnapshots,
  loadComparison,
  type ComparisonResponse,
} from "./ComparisonModal.js";
import { telegramDeliveryLabel, type TelegramDeliveryView } from "./telegram-delivery.js";

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
  labels: string[];
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
  telegram: TelegramDeliveryView | null;
}

interface MonitorDetail extends MonitorSummary {
  targetSelectors: string[];
  exclusionSelectors: string[];
  history: MonitorCheck[];
}

export function MonitorsWorkspace({ refreshToken, onManualCheckResult }: { refreshToken: number; onManualCheckResult: (succeeded: boolean) => void }) {
  const [monitors, setMonitors] = useState<MonitorSummary[]>([]);
  const [selected, setSelected] = useState<MonitorDetail | null>(null);
  const [manualBusy, setManualBusy] = useState(false);
  const [pauseBusy, setPauseBusy] = useState(false);
  const [pauseError, setPauseError] = useState<string | null>(null);
  const [comparison, setComparison] = useState<ComparisonResponse | null>(null);
  const [labelFilter, setLabelFilter] = useState("");
  const [availableLabels, setAvailableLabels] = useState<string[]>([]);
  const [editError, setEditError] = useState<string | null>(null);
  const [operationNotice, setOperationNotice] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void fetch(`/api/monitors${labelFilter === "" ? "" : `?label=${encodeURIComponent(labelFilter)}`}`, {
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
        if (labelFilter === "") setAvailableLabels([...new Set(items.flatMap((item) => item.labels ?? []))].sort((left, right) => left.localeCompare(right, "ru")));
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
  }, [refreshToken, labelFilter]);

  return (
    <section className="monitors-workspace" aria-label="Мониторы">
      <div className="monitors-table-panel">
        <div className="monitors-toolbar">
          <label className="monitor-filter">Фильтр по метке <select aria-label="Фильтр по метке" value={labelFilter} onChange={(event) => setLabelFilter(event.target.value)}><option value="">Все метки</option>{availableLabels.map((label) => <option key={label} value={label}>{label}</option>)}</select></label>
          {operationNotice === null ? null : <p className="status-badge" role="status">{operationNotice}</p>}
        </div>
        {monitors.length === 0 ? (
          <p className="muted">Мониторов пока нет.</p>
        ) : (
          <table className="dense-table">
            <thead>
              <tr>
                <th>Монитор</th><th>Метки</th><th>Интервал</th><th>Последний результат</th><th>Состояние</th><th>Следующая проверка</th>
              </tr>
            </thead>
            <tbody>
              {monitors.map((monitor) => (
                <tr key={monitor.id}>
                  <td><button className="table-link" type="button" onClick={() => void loadMonitor(monitor.id, undefined, setSelected)}>{monitor.name}</button></td>
                  <td>{monitor.labels?.join(", ") || "—"}</td>
                  <td>{monitor.intervalHours} ч</td>
                  <td>{resultLabel(monitor.latestCheckResult)}</td>
                  <td>{monitor.paused ? "Приостановлен" : "Включён"}</td>
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
              {manualBusy ? <><span className="button-spinner" aria-hidden="true" />Проверка выполняется…</> : "Запустить сейчас"}
            </button>
            {pauseError === null ? null : <p className="form-error" role="alert">{pauseError}</p>}
            <button
              className="secondary-button"
              type="button"
              disabled={pauseBusy}
              onClick={() => void changePaused(selected.id, !selected.paused)}
            >
              {selected.paused ? "Возобновить" : "Приостановить"}
            </button>
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
                  {check.telegram == null ? null : <small>Telegram: {telegramDeliveryLabel(check.telegram.state)}{check.telegram.failureReason === null ? "" : ` — ${check.telegram.failureReason}`}</small>}
                  {hasComparableSnapshots(check) ? (
                    <button className="table-link" type="button" onClick={() => void openComparison(check.id)}>
                      Открыть сравнение
                    </button>
                  ) : null}
                </li>
              ))}
            </ol>
            <MonitorEditor key={selected.id} monitor={selected} error={editError} onSaved={(monitor) => { setSelected(monitor); setOperationNotice("Монитор сохранён."); setMonitors((items) => items.map((item) => item.id === monitor.id ? { ...item, ...monitor, latestCheckResult: monitor.history[0]?.result ?? null } : item)); }} onDeleted={() => { setOperationNotice("Монитор удалён."); setMonitors((items) => items.filter((item) => item.id !== selected.id)); setSelected(null); }} onError={setEditError} />
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
      onManualCheckResult(true);
    } catch {
      onManualCheckResult(false);
    } finally {
      setManualBusy(false);
    }
  }

  async function changePaused(id: number, paused: boolean) {
    setPauseBusy(true);
    setPauseError(null);
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
    } catch {
      setPauseError(paused
        ? "Не удалось приостановить автоматические Проверки."
        : "Не удалось возобновить автоматические Проверки.");
    } finally {
      setPauseBusy(false);
    }
  }
}


function MonitorEditor({ monitor, error, onSaved, onDeleted, onError }: { monitor: MonitorDetail; error: string | null; onSaved: (monitor: MonitorDetail) => void; onDeleted: () => void; onError: (message: string | null) => void }) {
  async function submit(form: HTMLFormElement, resetHistory = false): Promise<void> {
    const data = new FormData(form);
    const lines = (name: string) => String(data.get(name) ?? "").split("\n").map((value) => value.trim()).filter(Boolean);
    const body = { name: String(data.get("name")), url: String(data.get("url")), targetSelectors: lines("targets"), exclusionSelectors: lines("exclusions"), labels: String(data.get("labels") ?? "").split(",").map((value) => value.trim()).filter(Boolean), intervalHours: Number(data.get("interval")), resetHistory };
    const response = await fetch(`/api/monitors/${monitor.id}`, { method: "PUT", headers: { accept: "application/json", "content-type": "application/json" }, body: JSON.stringify(body) });
    if (response.status === 409 && !resetHistory) {
      if (window.confirm("Область наблюдения изменилась. История будет безвозвратно удалена. Продолжить?")) await submit(form, true);
      return;
    }
    if (!response.ok) { onError("Не удалось сохранить Монитор."); return; }
    onError(null); onSaved(await response.json() as MonitorDetail);
  }
  return <form className="monitor-editor" onSubmit={(event) => { event.preventDefault(); void submit(event.currentTarget); }}>
    <h3>Настройки Монитора</h3>
    <label>Имя <input name="name" defaultValue={monitor.name} required /></label>
    <label>URL <input name="url" defaultValue={monitor.url} required /></label>
    <label>Целевые селекторы <textarea name="targets" defaultValue={monitor.targetSelectors.join("\n")} required /></label>
    <label>Селекторы исключения <textarea name="exclusions" defaultValue={monitor.exclusionSelectors.join("\n")} /></label>
    <label>Метки <input name="labels" defaultValue={monitor.labels?.join(", ") ?? ""} /></label>
    <label>Интервал <select name="interval" defaultValue={monitor.intervalHours}>{[6, 12, 24, 48, 72].map((hours) => <option key={hours} value={hours}>{hours} ч</option>)}</select></label>
    <button className="secondary-button" type="submit">Сохранить</button>
    {error === null ? null : <p className="form-error" role="alert">{error}</p>}
    <button className="secondary-button" type="button" onClick={() => void remove()}>Удалить Монитор</button>
  </form>;

  async function remove() {
    const confirmName = window.prompt(`Введите имя «${monitor.name}», чтобы удалить Монитор и всю его Историю.`);
    if (confirmName === null) return;
    const response = await fetch(`/api/monitors/${monitor.id}`, { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ confirmName }) });
    if (!response.ok) { onError("Имя не совпало или Монитор не удалось удалить."); return; }
    onDeleted();
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
