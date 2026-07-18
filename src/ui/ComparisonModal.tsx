export interface DiffRow {
  kind: "equal" | "replace" | "delete" | "insert" | "omitted";
  before: string | null;
  after: string | null;
  omittedBefore?: number;
  omittedAfter?: number;
}

export interface ComparisonResponse {
  checkId: number;
  monitorId: number;
  monitorName: string;
  beforeSnapshotId: number;
  afterSnapshotId: number;
  complete: boolean;
  targets: Array<{
    kind: "equal" | "replace" | "delete" | "insert";
    structure: DiffRow[];
    text: DiffRow[];
  }>;
}

export interface SnapshotLinks {
  beforeSnapshotId: number | null;
  afterSnapshotId: number | null;
}

export function hasComparableSnapshots(check: SnapshotLinks): boolean {
  return check.beforeSnapshotId !== null && check.afterSnapshotId !== null;
}

export async function loadComparison(checkId: number): Promise<ComparisonResponse | null> {
  const response = await fetch(`/api/checks/${checkId}/comparison`, {
    headers: { accept: "application/json" },
  });
  return response.ok ? (await response.json()) as ComparisonResponse : null;
}

export function ComparisonModal({
  comparison,
  onClose,
}: {
  comparison: ComparisonResponse;
  onClose: () => void;
}) {
  return (
    <div className="comparison-backdrop" role="presentation" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="comparison-dialog" role="dialog" aria-modal="true" aria-label="Сравнение">
        <header className="comparison-header">
          <h2>Сравнение · {comparison.monitorName}</h2>
          <button className="secondary-button" type="button" onClick={onClose}>Закрыть</button>
        </header>
        {!comparison.complete ? (
          <p className="comparison-limited" role="status">
            Сравнение показано частично из-за ограничения размера. Пропущенные строки отмечены ниже.
          </p>
        ) : null}
        <div className="comparison-column-headings" aria-hidden="true">
          <strong>Прежнее состояние</strong><strong>Новое состояние</strong>
        </div>
        <div className="comparison-text-diff">
          {comparison.targets.flatMap((target) => target.text).map((row, index) => (
            <DiffRowView row={row} key={index} />
          ))}
        </div>
      </section>
    </div>
  );
}

function DiffRowView({ row }: { row: DiffRow }) {
  return row.kind === "omitted" ? (
    <div className="diff-omitted">
      Пропущено строк: слева {row.omittedBefore ?? 0}, справа {row.omittedAfter ?? 0}
    </div>
  ) : (
    <div className={`diff-row diff-row--${row.kind}`}>
      <pre className={row.kind === "replace" || row.kind === "delete" ? "diff-before" : undefined}>{row.before ?? ""}</pre>
      <pre className={row.kind === "replace" || row.kind === "insert" ? "diff-after" : undefined}>{row.after ?? ""}</pre>
    </div>
  );
}
