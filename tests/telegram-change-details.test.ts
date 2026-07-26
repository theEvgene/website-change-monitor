import { describe, expect, it } from "vitest";

import {
  formatTelegramChangeMessage,
  projectTelegramChangeDetails,
} from "../src/server/notifications/telegram-change-details.js";
import {
  compareSnapshots,
  type SnapshotComparison,
} from "../src/server/application/snapshot-comparison.js";

describe("Telegram Change details", () => {
  it("shows one added fragment without an empty removed section", () => {
    const details = projectTelegramChangeDetails(comparison([
      { kind: "insert", before: null, after: "New role" },
    ]));

    expect(formatTelegramChangeMessage({
      title: "Обнаружено изменение",
      monitorName: "Careers",
      sourceUrl: "https://example.com/jobs",
      details,
    })).toBe([
      "Обнаружено изменение",
      "",
      "Страница: Careers",
      "",
      "➕ Добавлено:",
      "• New role",
      "",
      "Ссылка: https://example.com/jobs",
    ].join("\n"));
  });

  it("projects deletions and splits replacements without inventing a changed section", () => {
    const details = projectTelegramChangeDetails(comparison([
      { kind: "delete", before: "Removed first", after: null },
      { kind: "replace", before: "Old title", after: "New title" },
      { kind: "insert", before: null, after: "Added last" },
    ]));

    expect(details).toMatchObject({
      added: ["New title", "Added last"],
      removed: ["Removed first", "Old title"],
    });
    const message = formatTelegramChangeMessage({
      title: "Обнаружено изменение",
      monitorName: "Careers",
      sourceUrl: "https://example.com/jobs",
      details,
    });
    expect(message).toContain("➕ Добавлено:\n• New title\n• Added last");
    expect(message).toContain("➖ Удалено:\n• Removed first\n• Old title");
    expect(message).not.toContain("Изменено:");
  });

  it("normalizes unsafe controls while preserving literal markup and multiline text", () => {
    const details = projectTelegramChangeDetails(comparison([
      {
        kind: "insert",
        before: null,
        after: "  <b>*Role*</b>\r\nsecond\tline\u0000  ",
      },
    ]));

    expect(formatTelegramChangeMessage({
      title: "Обнаружено изменение",
      monitorName: "Careers",
      sourceUrl: "https://example.com/jobs",
      details,
    })).toContain("• <b>*Role*</b>\n  second\tline");
  });

  it("shares the 300-code-point budget equally and marks a partial result once", () => {
    const details = projectTelegramChangeDetails(comparison([
      { kind: "replace", before: "🟥".repeat(200), after: "🟩".repeat(200) },
    ]));

    const message = formatTelegramChangeMessage({
      title: "Обнаружено изменение",
      monitorName: "Careers",
      sourceUrl: "https://example.com/jobs",
      details,
    });

    expect(message).toContain(`• ${"🟩".repeat(150)}\n`);
    expect(message).not.toContain("🟩".repeat(151));
    expect(message).toContain(`• ${"🟥".repeat(150)}\n`);
    expect(message).not.toContain("🟥".repeat(151));
    expect(message.match(/…показана только часть изменений/gu)).toHaveLength(1);
  });

  it("gives the full 300-code-point budget to the only non-empty section", () => {
    const details = projectTelegramChangeDetails(comparison([
      { kind: "insert", before: null, after: "A".repeat(400) },
    ]));

    const message = formatTelegramChangeMessage({
      title: "Обнаружено изменение",
      monitorName: "Careers",
      sourceUrl: "https://example.com/jobs",
      details,
    });

    expect(message).toContain(`• ${"A".repeat(300)}\n`);
    expect(message).not.toContain("A".repeat(301));
    expect(message).not.toContain("➖ Удалено:");
  });

  it("transfers unused section budget while preserving fragment order", () => {
    const details = projectTelegramChangeDetails(comparison([
      { kind: "insert", before: null, after: "first" },
      { kind: "insert", before: null, after: "A".repeat(400) },
      { kind: "delete", before: "gone", after: null },
    ]));

    const message = formatTelegramChangeMessage({
      title: "Обнаружено изменение",
      monitorName: "Careers",
      sourceUrl: "https://example.com/jobs",
      details,
    });

    expect(message).toContain(`➕ Добавлено:\n• first\n• ${"A".repeat(291)}`);
    expect(message).toContain("➖ Удалено:\n• gone");
    expect(message.match(/…показана только часть изменений/gu)).toHaveLength(1);
  });

  it("explains a complete structural-only Change", () => {
    const details = projectTelegramChangeDetails(comparison([], {
      structure: [{ kind: "replace", before: "html:div", after: "html:section" }],
    }));

    expect(formatTelegramChangeMessage({
      title: "Обнаружено изменение",
      monitorName: "Careers",
      sourceUrl: "https://example.com/jobs",
      details,
    })).toContain(
      "Изменилась структура отслеживаемой области. Изменений видимого текста не обнаружено.",
    );
  });

  it("marks an incomplete Comparison without claiming visible text did not change", () => {
    const details = projectTelegramChangeDetails(comparison([], {
      complete: false,
      structure: [{
        kind: "omitted",
        before: null,
        after: null,
        omittedBefore: 10,
        omittedAfter: 10,
      }],
    }));

    const message = formatTelegramChangeMessage({
      title: "Обнаружено изменение",
      monitorName: "Careers",
      sourceUrl: "https://example.com/jobs",
      details,
    });
    expect(message).toContain("…показана только часть изменений");
    expect(message).not.toContain("Изменений видимого текста не обнаружено");
  });

  it("projects the same text rows produced for the application Comparison", () => {
    const sharedComparison = compareSnapshots(
      snapshotJson("Kept\nOld role\nRemoved role"),
      snapshotJson("Kept\nNew role\nAdded role"),
    );

    expect(projectTelegramChangeDetails(sharedComparison)).toMatchObject({
      removed: ["Old role", "Removed role"],
      added: ["New role", "Added role"],
      complete: true,
    });
  });

  it("preserves text-fragment order across multiple target areas", () => {
    const details = projectTelegramChangeDetails({
      complete: true,
      targets: [
        {
          kind: "replace",
          structure: [],
          text: [
            { kind: "delete", before: "first removed", after: null },
            { kind: "insert", before: null, after: "first added" },
          ],
        },
        {
          kind: "replace",
          structure: [],
          text: [
            { kind: "replace", before: "second removed", after: "second added" },
          ],
        },
      ],
    });

    expect(details).toMatchObject({
      added: ["first added", "second added"],
      removed: ["first removed", "second removed"],
    });
  });
});

function comparison(
  text: SnapshotComparison["targets"][number]["text"],
  options: {
    complete?: boolean;
    structure?: SnapshotComparison["targets"][number]["structure"];
  } = {},
): SnapshotComparison {
  return {
    complete: options.complete ?? true,
    targets: [{
      kind: "replace",
      structure: options.structure ?? [
        { kind: "equal", before: "html:div", after: "html:div" },
      ],
      text,
    }],
  };
}

function snapshotJson(visibleText: string): string {
  return JSON.stringify({
    formatVersion: 1,
    targets: [{
      elements: [{
        namespace: "http://www.w3.org/1999/xhtml",
        name: "div",
        childElementCount: 0,
      }],
      visibleText,
    }],
  });
}
