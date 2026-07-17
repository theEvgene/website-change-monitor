import { useEffect, useState } from "react";

import {
  ComparisonModal,
  hasComparableSnapshots,
  loadComparison,
  type ComparisonResponse,
} from "./ComparisonModal.js";

interface JournalCheck {
  id: number;
  monitorId: number;
  monitorName: string;
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

export function JournalWorkspace({ selectedCheckId }: { selectedCheckId: number | undefined }) {
  const [checks, setChecks] = useState<JournalCheck[]>([]);
  const [failed, setFailed] = useState(false);
  const [comparison, setComparison] = useState<ComparisonResponse | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/checks", {
      headers: { accept: "application/json" }, signal: controller.signal,
    }).then(async (response) => {
      if (!response.ok) throw new Error(`Journal failed: ${response.status}`);
      return (await response.json()) as JournalCheck[];
    }).then(setChecks).catch((error: unknown) => {
      if (!(error instanceof DOMException && error.name === "AbortError")) setFailed(true);
    });
    return () => controller.abort();
  }, []);

  return (
    <section className="journal-panel" aria-labelledby="journal-title">
      <p className="eyebrow">Все проверки</p>
      <h2 id="journal-title">Журнал</h2>
      {failed ? <p className="form-error" role="alert">Не удалось загрузить Журнал.</p> : null}
      {!failed && checks.length === 0 ? <p className="muted">Проверок пока нет.</p> : null}
      {checks.length > 0 ? (
        <table className="dense-table">
          <thead><tr><th>Монитор</th><th>Время</th><th>Вид</th><th>Результат</th><th /></tr></thead>
          <tbody>{checks.map((check) => (
              <tr key={check.id} className={check.id === selectedCheckId ? "selected-check" : undefined} aria-current={check.id === selectedCheckId ? "true" : undefined}>
              <td>{check.monitorName}{check.id === selectedCheckId ? <span className="status-badge">Выбрано</span> : null}</td>
              <td>{formatDate(check.completedAt ?? check.startedAt)}</td>
              <td>{kindLabel(check.kind)}</td>
              <td>{resultLabel(check)}</td>
              <td>{hasComparableSnapshots(check) ? (
                <button className="table-link" type="button" onClick={() => void openComparison(check.id)}>
                  Открыть Сравнение
                </button>
              ) : null}</td>
            </tr>
          ))}</tbody>
        </table>
      ) : null}
      {comparison === null ? null : <ComparisonModal comparison={comparison} onClose={() => setComparison(null)} />}
    </section>
  );

  async function openComparison(checkId: number) {
    const loaded = await loadComparison(checkId);
    if (loaded !== null) setComparison(loaded);
  }
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
