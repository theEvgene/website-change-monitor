import { useCallback, useMemo, useState } from "react";
import { Observable } from "rxjs";

import { RequestWrapper } from "./RequestWrapper.js";

export interface DiffRow {
  kind: "equal" | "replace" | "delete" | "insert" | "omitted";
  before: string | null;
  after: string | null;
  omittedBefore?: number;
  omittedAfter?: number;
  beforeLinks?: TextLink[];
  afterLinks?: TextLink[];
}

interface TextLink { start: number; end: number; href: string }
interface SnapshotState { id: number; createdAt: string }

export interface ComparisonResponse {
  checkId: number;
  monitorId: number;
  monitorName: string;
  beforeSnapshotId: number;
  afterSnapshotId: number;
  beforeCreatedAt?: string;
  afterCreatedAt?: string;
  eligibleBeforeSnapshots?: SnapshotState[];
  complete: boolean;
  targets: Array<{
    kind: "equal" | "replace" | "delete" | "insert";
    structure: DiffRow[];
    text: DiffRow[];
  }>;
}

export interface ComparableCheck {
  result: "baseline" | "no_change" | "change" | "error" | null;
}

export function hasComparableSnapshots(check: ComparableCheck): boolean {
  return check.result === "change";
}

export function loadComparison(checkId: number, initialSnapshotId?: number): Observable<ComparisonResponse> {
  return new Observable((subscriber) => {
    const controller = new AbortController();
    const query = initialSnapshotId === undefined ? "" : `?initialSnapshotId=${initialSnapshotId}`;
    void fetch(`/api/checks/${checkId}/comparison${query}`, {
      headers: { accept: "application/json" }, signal: controller.signal,
    }).then(async (response) => {
      if (!response.ok) throw new Error(`Comparison failed: ${response.status}`);
      return await response.json() as ComparisonResponse;
    }).then((value) => { subscriber.next(value); subscriber.complete(); }).catch((error: unknown) => {
      if (!controller.signal.aborted) subscriber.error(error);
    });
    return () => controller.abort();
  });
}

export function ComparisonModal({ checkId, onClose }: { checkId: number; onClose: () => void }) {
  const [selectedSnapshotId, setSelectedSnapshotId] = useState<number | undefined>();
  const [metadata, setMetadata] = useState<ComparisonResponse | null>(null);
  const request = useMemo(() => loadComparison(checkId, selectedSnapshotId), [checkId, selectedSnapshotId]);
  const rememberMetadata = useCallback((value: ComparisonResponse) => setMetadata(value), []);
  const states = metadata?.eligibleBeforeSnapshots ?? (metadata === null ? [] : [{ id: metadata.beforeSnapshotId, createdAt: metadata.beforeCreatedAt ?? "" }]);
  const labels = useMemo(() => stateLabels(states, metadata?.afterCreatedAt), [states]);
  const selectedValue = selectedSnapshotId ?? metadata?.beforeSnapshotId;

  return <div className="comparison-backdrop" role="presentation" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="comparison-dialog" role="dialog" aria-modal="true" aria-label="Сравнение">
      <header className="comparison-header">
        <h2>Сравнение{metadata === null ? "" : ` · ${metadata.monitorName}`}</h2>
        <button className="secondary-button" type="button" onClick={onClose}>Закрыть</button>
      </header>
      <div className="comparison-column-headings">
        <select aria-label="Прежнее состояние" value={selectedValue ?? ""} onChange={(event) => setSelectedSnapshotId(Number(event.target.value))}>
          {metadata === null ? <option value="">Загрузка…</option> : states.map((snapshot) => <option key={snapshot.id} value={snapshot.id}>{labels.get(snapshot.id)}</option>)}
        </select>
        <strong>{metadata === null ? "Новое состояние" : metadata.afterCreatedAt === undefined ? "Новое состояние" : `Новое состояние · ${formatTimestamp(metadata.afterCreatedAt, false)}`}</strong>
      </div>
      <RequestWrapper request={request} errorMessage="Не удалось загрузить сравнение" onSuccess={rememberMetadata}>
        {(comparison) => <ComparisonContent comparison={comparison} />}
      </RequestWrapper>
    </section>
  </div>;
}

function ComparisonContent({ comparison }: { comparison: ComparisonResponse }) {
  const rows = comparison.targets.flatMap((target) => target.text);
  const empty = rows.length === 0 || rows.every((row) => row.kind === "equal");
  return <>
    {!comparison.complete ? <p className="comparison-limited" role="status">Сравнение показано частично из-за ограничения размера. Пропущенные строки отмечены ниже.</p> : null}
    {empty ? <p className="comparison-empty">Между выбранными состояниями изменений нет</p> : <div className="comparison-text-diff">{rows.map((row, index) => <DiffRowView row={row} key={index} />)}</div>}
  </>;
}

function stateLabels(states: SnapshotState[], finalCreatedAt?: string): Map<number, string> {
  const referenceYear = finalCreatedAt === undefined ? undefined : moscowYear(new Date(finalCreatedAt));
  const basic = states.map((state) => formatTimestamp(state.createdAt, false, referenceYear));
  const collisions = new Set(basic.filter((label, index) => basic.indexOf(label) !== index));
  return new Map(states.map((state, index) => [state.id, formatTimestamp(state.createdAt, collisions.has(basic[index]!), referenceYear)]));
}

function formatTimestamp(value: string, seconds: boolean, referenceYear?: number): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Прежнее состояние";
  const nowYear = referenceYear ?? moscowYear(new Date());
  const year = moscowYear(date);
  return new Intl.DateTimeFormat("ru-RU", {
    day: "numeric", month: "long", hour: "2-digit", minute: "2-digit",
    ...(year === nowYear ? {} : { year: "numeric" as const }),
    ...(seconds ? { second: "2-digit" as const } : {}),
    timeZone: "Europe/Moscow",
  }).format(date);
}

function moscowYear(date: Date): number { return Number(new Intl.DateTimeFormat("en", { year: "numeric", timeZone: "Europe/Moscow" }).format(date)); }

function DiffRowView({ row }: { row: DiffRow }) {
  return row.kind === "omitted" ? <div className="diff-omitted">Пропущено строк: слева {row.omittedBefore ?? 0}, справа {row.omittedAfter ?? 0}</div> : <div className={`diff-row diff-row--${row.kind}`}>
    <pre className={row.kind === "replace" || row.kind === "delete" ? "diff-before" : undefined}>{renderText(row.before ?? "", row.beforeLinks)}</pre>
    <pre className={row.kind === "replace" || row.kind === "insert" ? "diff-after" : undefined}>{renderText(row.after ?? "", row.afterLinks)}</pre>
  </div>;
}

function renderText(value: string, links: TextLink[] | undefined) {
  if (links === undefined || links.length === 0) return value;
  const fragments: React.ReactNode[] = []; let offset = 0;
  for (const link of links) {
    if (link.start < offset || link.end > value.length || link.end <= link.start) continue;
    if (link.start > offset) fragments.push(value.slice(offset, link.start));
    fragments.push(<a href={link.href} key={`${link.start}-${link.end}-${link.href}`} target="_blank" rel="noopener noreferrer">{value.slice(link.start, link.end)}</a>); offset = link.end;
  }
  if (offset < value.length) fragments.push(value.slice(offset));
  return fragments;
}
