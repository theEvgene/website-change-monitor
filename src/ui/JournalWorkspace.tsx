import { useCallback, useEffect, useState } from "react";

import {
  ComparisonModal,
  hasComparableSnapshots,
  loadComparison,
  type ComparisonResponse,
} from "./ComparisonModal.js";
import { telegramDeliveryLabel, type TelegramDeliveryView } from "./telegram-delivery.js";

interface JournalCheck {
  id: number;
  monitorId: number;
  monitorName: string;
  url: string;
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

export type JournalResultFilter = "all" | "change" | "no_change" | "error" | "baseline" | "running";

export function JournalWorkspace({
  selectedCheckId,
  resultFilter,
  onResultFilterChange,
  onManualCheckResult,
}: {
  selectedCheckId: number | undefined;
  resultFilter: JournalResultFilter;
  onResultFilterChange: (filter: JournalResultFilter) => void;
  onManualCheckResult: (succeeded: boolean) => void;
}) {
  const [checks, setChecks] = useState<JournalCheck[]>([]);
  const [failed, setFailed] = useState(false);
  const [comparison, setComparison] = useState<ComparisonResponse | null>(null);
  const [manualBusyMonitorIds, setManualBusyMonitorIds] = useState<Set<number>>(new Set());

  const loadJournal = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch("/api/checks", {
      headers: { accept: "application/json" },
      ...(signal === undefined ? {} : { signal }),
    });
    if (!response.ok) throw new Error(`Journal failed: ${response.status}`);
    setChecks(await response.json() as JournalCheck[]);
    setFailed(false);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void loadJournal(controller.signal).catch((error: unknown) => {
      if (!(error instanceof DOMException && error.name === "AbortError")) setFailed(true);
    });
    return () => controller.abort();
  }, [loadJournal]);

  const visibleChecks = checks.filter((check) => matchesResultFilter(check, resultFilter));

  return (
    <section className="journal-panel" aria-label="Журнал">
      <div className="journal-toolbar">
        <label className="journal-filter">
          Результат
          <select value={resultFilter} onChange={(event) => onResultFilterChange(event.target.value as JournalResultFilter)}>
            <option value="change">Обнаружены изменения</option>
            <option value="no_change">Без изменений</option>
            <option value="error">Ошибки</option>
            <option value="baseline">Базовый снимок</option>
            <option value="running">Выполняются</option>
            <option value="all">Все результаты</option>
          </select>
        </label>
      </div>
      {failed ? <p className="form-error" role="alert">Не удалось загрузить Журнал.</p> : null}
      {!failed && checks.length === 0 ? <p className="muted">Проверок пока нет.</p> : null}
      {!failed && checks.length > 0 && visibleChecks.length === 0 ? <p className="muted">Проверок с выбранным Результатом пока нет.</p> : null}
      {visibleChecks.length > 0 ? (
        <table className="dense-table">
          <thead><tr><th>Монитор</th><th>Время</th><th>Вид</th><th>Результат</th><th>Telegram</th><th>Действия</th></tr></thead>
          <tbody>{visibleChecks.map((check) => {
            const manualBusy = manualBusyMonitorIds.has(check.monitorId);
            return (
              <tr key={check.id} className={check.id === selectedCheckId ? "selected-check" : undefined} aria-current={check.id === selectedCheckId ? "true" : undefined}>
              <td><a className="table-link" href={check.url} target="_blank" rel="noopener noreferrer">{check.monitorName}</a>{check.id === selectedCheckId ? <span className="status-badge">Выбрано</span> : null}</td>
              <td>{formatDate(check.completedAt ?? check.startedAt)}</td>
              <td>{kindLabel(check.kind)}</td>
              <td>{resultLabel(check)}</td>
              <td>{check.telegram == null ? "—" : telegramDeliveryLabel(check.telegram.state)}{check.telegram?.failureReason == null ? null : <small>{check.telegram.failureReason}</small>}</td>
              <td><div className="journal-actions">
                {hasComparableSnapshots(check) ? (
                  <button className="table-link" type="button" onClick={() => void openComparison(check.id)}>
                    Открыть сравнение
                  </button>
                ) : null}
                <button
                  className="journal-recheck"
                  type="button"
                  title={manualBusy ? "Проверка выполняется" : "Запустить сейчас"}
                  aria-label={manualBusy ? `Проверка выполняется: ${check.monitorName}` : `Запустить сейчас: ${check.monitorName}`}
                  disabled={manualBusy}
                  onClick={() => void requestManualCheck(check.monitorId)}
                >{manualBusy ? <span className="button-spinner" aria-hidden="true" /> : "↻"}</button>
              </div></td>
            </tr>
          );})}</tbody>
        </table>
      ) : null}
      {comparison === null ? null : <ComparisonModal comparison={comparison} onClose={() => setComparison(null)} />}
    </section>
  );

  async function openComparison(checkId: number) {
    const loaded = await loadComparison(checkId);
    if (loaded !== null) setComparison(loaded);
  }

  async function requestManualCheck(monitorId: number) {
    setManualBusyMonitorIds((current) => new Set(current).add(monitorId));
    try {
      const response = await fetch(`/api/monitors/${monitorId}/checks`, {
        method: "POST", headers: { accept: "application/json" },
      });
      if (!response.ok) throw new Error(`Manual Check failed: ${response.status}`);
      await loadJournal();
      onManualCheckResult(true);
    } catch {
      onManualCheckResult(false);
    } finally {
      setManualBusyMonitorIds((current) => {
        const next = new Set(current); next.delete(monitorId); return next;
      });
    }
  }
}

function matchesResultFilter(check: JournalCheck, filter: JournalResultFilter): boolean {
  if (filter === "all") return true;
  if (filter === "running") return check.status === "running";
  return check.status !== "running" && check.result === filter;
}

function kindLabel(kind: JournalCheck["kind"]): string {
  if (kind === "manual") return "Ручная";
  if (kind === "retry") return "Повторная";
  if (kind === "overdue") return "Просроченная";
  return "Плановая";
}

function resultLabel(check: JournalCheck): string {
  if (check.status === "running") return "Выполняется";
  if (check.result === "baseline") return "Базовый снимок";
  if (check.result === "no_change") return "Без изменений";
  if (check.result === "change") return "Обнаружено изменение";
  if (check.result === "error") return check.isFinalError ? "Окончательная ошибка" : "Ошибка — ожидается Повторная проверка";
  return "Неизвестно";
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("ru-RU", {
    dateStyle: "short", timeStyle: "short", timeZone: "Europe/Moscow",
  }).format(new Date(value));
}
