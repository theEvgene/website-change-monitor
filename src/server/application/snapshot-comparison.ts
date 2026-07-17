export type DiffRow =
  | {
      kind: "equal" | "replace";
      before: string;
      after: string;
    }
  | {
      kind: "delete";
      before: string;
      after: null;
    }
  | {
      kind: "insert";
      before: null;
      after: string;
    }
  | {
      kind: "omitted";
      before: null;
      after: null;
      omittedBefore: number;
      omittedAfter: number;
    };

interface Edit {
  kind: "equal" | "delete" | "insert";
  value: string;
}

const maxSectionLines = 20_000;
const maxTransitions = 5_000_000;

export function diffLines(before: string[], after: string[]): DiffRow[] {
  if (before.length > maxSectionLines || after.length > maxSectionLines) {
    return boundedRows(before, after);
  }
  try {
    return pairHunks(myers(before, after));
  } catch (error: unknown) {
    if (error instanceof ComparisonLimitError) {
      return boundedRows(before, after);
    }
    throw error;
  }
}

function myers(before: string[], after: string[]): Edit[] {
  const endX = before.length;
  const endY = after.length;
  const maximumDistance = endX + endY;
  let transitions = 0;
  let frontier = new Map<number, number>([[1, 0]]);
  const trace: Array<Map<number, number>> = [];

  for (let distance = 0; distance <= maximumDistance; distance += 1) {
    trace.push(new Map(frontier));
    const next = new Map<number, number>();
    for (
      let diagonal = -distance;
      diagonal <= distance;
      diagonal += 2
    ) {
      transitions += 1;
      enforceBudget(transitions);
      const insertionX = frontier.get(diagonal + 1) ?? -1;
      const deletionX = (frontier.get(diagonal - 1) ?? -1) + 1;
      let x =
        diagonal === -distance ||
        (diagonal !== distance && insertionX > deletionX)
          ? insertionX
          : deletionX;
      let y = x - diagonal;
      while (x < endX && y < endY && before[x] === after[y]) {
        x += 1;
        y += 1;
        transitions += 1;
        enforceBudget(transitions);
      }
      next.set(diagonal, x);
      if (x >= endX && y >= endY) {
        return backtrack(before, after, trace, distance);
      }
    }
    frontier = next;
  }
  throw new Error("Myers diff did not reach the end of the edit graph");
}

function backtrack(
  before: string[],
  after: string[],
  trace: Array<Map<number, number>>,
  distance: number,
): Edit[] {
  let x = before.length;
  let y = after.length;
  const reversed: Edit[] = [];

  for (let depth = distance; depth > 0; depth -= 1) {
    const frontier = trace[depth]!;
    const diagonal = x - y;
    const insertionX = frontier.get(diagonal + 1) ?? -1;
    const deletionX = frontier.get(diagonal - 1) ?? -1;
    const previousDiagonal =
      diagonal === -depth ||
      (diagonal !== depth && insertionX > deletionX)
        ? diagonal + 1
        : diagonal - 1;
    const previousX = frontier.get(previousDiagonal) ?? 0;
    const previousY = previousX - previousDiagonal;

    while (x > previousX && y > previousY) {
      reversed.push({ kind: "equal", value: before[x - 1]! });
      x -= 1;
      y -= 1;
    }
    if (x === previousX) {
      reversed.push({ kind: "insert", value: after[y - 1]! });
      y -= 1;
    } else {
      reversed.push({ kind: "delete", value: before[x - 1]! });
      x -= 1;
    }
  }
  while (x > 0 && y > 0) {
    reversed.push({ kind: "equal", value: before[x - 1]! });
    x -= 1;
    y -= 1;
  }
  while (x > 0) {
    reversed.push({ kind: "delete", value: before[x - 1]! });
    x -= 1;
  }
  while (y > 0) {
    reversed.push({ kind: "insert", value: after[y - 1]! });
    y -= 1;
  }
  return reversed.reverse();
}

function pairHunks(edits: Edit[]): DiffRow[] {
  const rows: DiffRow[] = [];
  for (let index = 0; index < edits.length; ) {
    const edit = edits[index]!;
    if (edit.kind === "equal") {
      rows.push({ kind: "equal", before: edit.value, after: edit.value });
      index += 1;
      continue;
    }
    const deletions: string[] = [];
    const insertions: string[] = [];
    while (index < edits.length && edits[index]!.kind !== "equal") {
      const changed = edits[index]!;
      if (changed.kind === "delete") deletions.push(changed.value);
      else insertions.push(changed.value);
      index += 1;
    }
    const rowCount = Math.max(deletions.length, insertions.length);
    for (let offset = 0; offset < rowCount; offset += 1) {
      const deleted = deletions[offset];
      const inserted = insertions[offset];
      if (deleted !== undefined && inserted !== undefined) {
        rows.push({ kind: "replace", before: deleted, after: inserted });
      } else if (deleted !== undefined) {
        rows.push({ kind: "delete", before: deleted, after: null });
      } else if (inserted !== undefined) {
        rows.push({ kind: "insert", before: null, after: inserted });
      }
    }
  }
  return rows;
}

function boundedRows(before: string[], after: string[]): DiffRow[] {
  let prefix = 0;
  while (
    prefix < before.length &&
    prefix < after.length &&
    before[prefix] === after[prefix] &&
    prefix < 50
  ) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before[before.length - suffix - 1] === after[after.length - suffix - 1] &&
    suffix < 50
  ) {
    suffix += 1;
  }
  return [
    ...before.slice(0, prefix).map(
      (value): DiffRow => ({ kind: "equal", before: value, after: value }),
    ),
    {
      kind: "omitted",
      before: null,
      after: null,
      omittedBefore: before.length - prefix - suffix,
      omittedAfter: after.length - prefix - suffix,
    },
    ...before.slice(before.length - suffix).map(
      (value): DiffRow => ({ kind: "equal", before: value, after: value }),
    ),
  ];
}

function enforceBudget(transitions: number): void {
  if (transitions > maxTransitions) throw new ComparisonLimitError();
}

class ComparisonLimitError extends Error {}

interface SnapshotElement {
  namespace: string | null;
  name: string;
  childElementCount: number;
}

interface SnapshotTarget {
  elements: SnapshotElement[];
  visibleText: string;
}

interface SnapshotDocument {
  formatVersion: number;
  targets: SnapshotTarget[];
}

export interface TargetComparison {
  kind: "equal" | "replace" | "delete" | "insert";
  structure: DiffRow[];
  text: DiffRow[];
}

export interface SnapshotComparison {
  complete: boolean;
  targets: TargetComparison[];
}

export function compareSnapshots(
  beforeJson: string,
  afterJson: string,
): SnapshotComparison {
  const before = parseSnapshot(beforeJson);
  const after = parseSnapshot(afterJson);
  if (before.formatVersion !== 1 || after.formatVersion !== 1) {
    throw new Error("Snapshot version is not supported for Comparison");
  }
  const targetRows = diffLines(
    before.targets.map((target) => JSON.stringify(target)),
    after.targets.map((target) => JSON.stringify(target)),
  );
  const targets: TargetComparison[] = [];
  let complete = true;
  for (const row of targetRows) {
    if (row.kind === "omitted") {
      complete = false;
      continue;
    }
    const beforeTarget =
      row.before === null ? undefined : parseTarget(row.before);
    const afterTarget = row.after === null ? undefined : parseTarget(row.after);
    const structure = diffLines(
      beforeTarget === undefined ? [] : structureLines(beforeTarget.elements),
      afterTarget === undefined ? [] : structureLines(afterTarget.elements),
    );
    const text = diffLines(
      beforeTarget === undefined ? [] : textLines(beforeTarget.visibleText),
      afterTarget === undefined ? [] : textLines(afterTarget.visibleText),
    );
    if (
      structure.some((item) => item.kind === "omitted") ||
      text.some((item) => item.kind === "omitted")
    ) {
      complete = false;
    }
    targets.push({ kind: row.kind, structure, text });
  }
  return { complete, targets };
}

function structureLines(elements: SnapshotElement[]): string[] {
  const lines: string[] = [];
  const remainingChildren: number[] = [];
  for (const [index, element] of elements.entries()) {
    while (remainingChildren.at(-1) === 0) remainingChildren.pop();
    if (index > 0 && remainingChildren.length > 0) {
      remainingChildren[remainingChildren.length - 1]! -= 1;
    }
    const indentation = "  ".repeat(remainingChildren.length);
    lines.push(`${indentation}${element.namespace ?? "null"}:${element.name}`);
    remainingChildren.push(element.childElementCount);
  }
  return lines;
}

function textLines(value: string): string[] {
  return value === "" ? [] : value.split("\n");
}

function parseSnapshot(value: string): SnapshotDocument {
  const parsed = JSON.parse(value) as SnapshotDocument;
  if (!Array.isArray(parsed.targets)) throw new Error("Snapshot is malformed");
  return parsed;
}

function parseTarget(value: string): SnapshotTarget {
  const parsed = JSON.parse(value) as SnapshotTarget;
  if (!Array.isArray(parsed.elements) || typeof parsed.visibleText !== "string") {
    throw new Error("Snapshot target is malformed");
  }
  return parsed;
}
