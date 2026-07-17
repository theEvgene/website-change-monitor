import { useEffect, useState } from "react";

interface MonitorSummary {
  id: number;
  name: string;
  url: string;
  intervalHours: number;
  scopeRevision: number;
  nextCheckAt: string | null;
  latestCheckResult: "baseline" | "no_change" | "change" | "error" | null;
}

interface MonitorCheck {
  id: number;
  result: "baseline" | "no_change" | "change" | "error" | null;
  startedAt: string;
  completedAt: string | null;
  errorMessage: string | null;
}

interface MonitorDetail extends MonitorSummary {
  targetSelectors: string[];
  exclusionSelectors: string[];
  history: MonitorCheck[];
}

export function MonitorsWorkspace({ refreshToken }: { refreshToken: number }) {
  const [monitors, setMonitors] = useState<MonitorSummary[]>([]);
  const [selected, setSelected] = useState<MonitorDetail | null>(null);

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
                <th>Монитор</th><th>Интервал</th><th>Последняя Проверка</th><th>Следующая Проверка</th>
              </tr>
            </thead>
            <tbody>
              {monitors.map((monitor) => (
                <tr key={monitor.id}>
                  <td><button className="table-link" type="button" onClick={() => void loadMonitor(monitor.id, undefined, setSelected)}>{monitor.name}</button></td>
                  <td>{monitor.intervalHours} ч</td>
                  <td>{resultLabel(monitor.latestCheckResult)}</td>
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
            <dl className="monitor-settings">
              <div><dt>URL</dt><dd>{selected.url}</dd></div>
              <div><dt>Область наблюдения</dt><dd>ревизия {selected.scopeRevision}</dd></div>
            </dl>
            <ol className="history-list">
              {selected.history.map((check) => (
                <li key={check.id}>
                  <strong>{resultLabel(check.result)}</strong>
                  <span>{formatDate(check.completedAt ?? check.startedAt)}</span>
                  {check.errorMessage === null ? null : <small>{check.errorMessage}</small>}
                </li>
              ))}
            </ol>
          </>
        )}
      </aside>
    </section>
  );
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

function formatDate(value: string | null): string {
  if (value === null) return "не назначена";
  return new Intl.DateTimeFormat("ru-RU", {
    dateStyle: "short", timeStyle: "short", timeZone: "Europe/Moscow",
  }).format(new Date(value));
}
