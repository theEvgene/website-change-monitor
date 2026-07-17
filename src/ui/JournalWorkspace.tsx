import { useEffect, useState } from "react";

import { ComparisonModal, type ComparisonResponse } from "./ComparisonModal.js";

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
}

export function JournalWorkspace() {
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
            <tr key={check.id}>
              <td>{check.monitorName}</td>
              <td>{formatDate(check.completedAt ?? check.startedAt)}</td>
              <td>{kindLabel(check.kind)}</td>
              <td>{resultLabel(check)}</td>
              <td>{canCompare(check) ? (
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
    const response = await fetch(`/api/checks/${checkId}/comparison`, {
      headers: { accept: "application/json" },
    });
    if (response.ok) setComparison((await response.json()) as ComparisonResponse);
  }
}

function canCompare(check: JournalCheck): boolean {
  return check.beforeSnapshotId !== null && check.afterSnapshotId !== null &&
    check.beforeSnapshotId !== check.afterSnapshotId;
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
  if (check.result === "error") return "Ошибка";
  return "Неизвестно";
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("ru-RU", {
    dateStyle: "short", timeStyle: "short", timeZone: "Europe/Moscow",
  }).format(new Date(value));
}
