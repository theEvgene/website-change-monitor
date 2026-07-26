import type { SnapshotComparison } from "../application/snapshot-comparison.js";

export interface TelegramChangeDetails {
  added: string[];
  removed: string[];
  hasStructuralChanges: boolean;
  complete: boolean;
}

export function projectTelegramChangeDetails(
  comparison: SnapshotComparison,
): TelegramChangeDetails {
  const added: string[] = [];
  const removed: string[] = [];
  let hasStructuralChanges = false;
  for (const target of comparison.targets) {
    if (target.structure.some((row) => row.kind !== "equal" && row.kind !== "omitted")) {
      hasStructuralChanges = true;
    }
    for (const row of target.text) {
      if (row.kind === "delete") {
        removed.push(row.before);
      } else if (row.kind === "insert") {
        added.push(row.after);
      } else if (row.kind === "replace") {
        removed.push(row.before);
        added.push(row.after);
      }
    }
  }
  return {
    added,
    removed,
    hasStructuralChanges,
    complete: comparison.complete,
  };
}

export function formatTelegramChangeMessage(input: {
  title: string;
  monitorName: string;
  sourceUrl: string;
  details: TelegramChangeDetails;
}): string {
  const normalizedAdded = normalizedFragments(input.details.added);
  const normalizedRemoved = normalizedFragments(input.details.removed);
  const budgets = sectionBudgets(normalizedAdded, normalizedRemoved);
  const added = takeFragments(normalizedAdded, budgets.added);
  const removed = takeFragments(normalizedRemoved, budgets.removed);
  const lines = [
    input.title,
    "",
    `Страница: ${input.monitorName}`,
  ];
  if (added.fragments.length > 0) {
    lines.push("", "➕ Добавлено:");
    for (const fragment of added.fragments) {
      lines.push(bullet(fragment));
    }
  }
  if (removed.fragments.length > 0) {
    lines.push("", "➖ Удалено:");
    for (const fragment of removed.fragments) {
      lines.push(bullet(fragment));
    }
  }
  if (
    input.details.complete &&
    normalizedAdded.length === 0 &&
    normalizedRemoved.length === 0 &&
    input.details.hasStructuralChanges
  ) {
    lines.push(
      "",
      "Изменилась структура отслеживаемой области. Изменений видимого текста не обнаружено.",
    );
  }
  if (!input.details.complete || added.truncated || removed.truncated) {
    lines.push("", "…показана только часть изменений");
  }
  lines.push("", `Ссылка: ${input.sourceUrl}`);
  return lines.join("\n");
}

function normalizedFragments(fragments: string[]): string[] {
  return fragments
    .map((fragment) => fragment
      .normalize("NFC")
      .replace(/\r\n?/gu, "\n")
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, " ")
      .trim())
    .filter((fragment) => fragment !== "");
}

function bullet(fragment: string): string {
  return `• ${fragment.replaceAll("\n", "\n  ")}`;
}

function sectionBudgets(
  added: string[],
  removed: string[],
): { added: number; removed: number } {
  const addedLength = fragmentsLength(added);
  const removedLength = fragmentsLength(removed);
  if (addedLength === 0) return { added: 0, removed: Math.min(300, removedLength) };
  if (removedLength === 0) return { added: Math.min(300, addedLength), removed: 0 };

  let addedBudget = Math.min(150, addedLength);
  let removedBudget = Math.min(150, removedLength);
  let remaining = 300 - addedBudget - removedBudget;
  const extraAdded = Math.min(remaining, addedLength - addedBudget);
  addedBudget += extraAdded;
  remaining -= extraAdded;
  removedBudget += Math.min(remaining, removedLength - removedBudget);
  return { added: addedBudget, removed: removedBudget };
}

function fragmentsLength(fragments: string[]): number {
  return fragments.reduce((length, fragment) => length + [...fragment].length, 0);
}

function takeFragments(
  fragments: string[],
  budget: number,
): { fragments: string[]; truncated: boolean } {
  const output: string[] = [];
  let remaining = budget;
  let consumed = 0;
  for (const fragment of fragments) {
    const points = [...fragment];
    if (points.length <= remaining) {
      output.push(fragment);
      remaining -= points.length;
      consumed += points.length;
      continue;
    }
    if (remaining > 0) {
      output.push(points.slice(0, remaining).join(""));
      consumed += remaining;
    }
    break;
  }
  return {
    fragments: output,
    truncated: consumed < fragmentsLength(fragments),
  };
}
