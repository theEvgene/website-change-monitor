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

export function ComparisonModal({
  comparison,
  onClose,
}: {
  comparison: ComparisonResponse;
  onClose: () => void;
}) {
  return (
    <div className="comparison-backdrop" role="presentation">
      <section className="comparison-dialog" role="dialog" aria-modal="true" aria-label="Сравнение">
        <header className="comparison-header">
          <div>
            <p className="eyebrow">Проверка #{comparison.checkId}</p>
            <h2>Сравнение · {comparison.monitorName}</h2>
          </div>
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
        <div className="comparison-targets">
          {comparison.targets.map((target, index) => (
            <article className="comparison-target" key={index}>
              <h3>Целевая область {index + 1}</h3>
              <DiffSection title="Структура" rows={target.structure} />
              <DiffSection title="Текст" rows={target.text} />
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}

function DiffSection({ title, rows }: { title: string; rows: DiffRow[] }) {
  return (
    <section className="diff-section">
      <h4>{title}</h4>
      {rows.map((row, index) => row.kind === "omitted" ? (
        <div className="diff-omitted" key={index}>
          Пропущено строк: слева {row.omittedBefore ?? 0}, справа {row.omittedAfter ?? 0}
        </div>
      ) : (
        <div className={`diff-row diff-row--${row.kind}`} key={index}>
          <pre className={row.kind === "equal" ? undefined : "diff-before"}>{row.before ?? ""}</pre>
          <pre className={row.kind === "equal" ? undefined : "diff-after"}>{row.after ?? ""}</pre>
        </div>
      ))}
    </section>
  );
}
