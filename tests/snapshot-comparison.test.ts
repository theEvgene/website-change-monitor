import { describe, expect, it } from "vitest";

import {
  compareSnapshots,
  diffLines,
  type DiffRow,
} from "../src/server/application/snapshot-comparison.js";

describe("deterministic Snapshot Comparison", () => {
  it("uses deletion before insertion for ambiguous repeated lines", () => {
    expect(diffLines(["A", "B", "A"], ["A", "A", "B"])).toEqual([
      { kind: "equal", before: "A", after: "A" },
      { kind: "delete", before: "B", after: null },
      { kind: "equal", before: "A", after: "A" },
      { kind: "insert", before: null, after: "B" },
    ] satisfies DiffRow[]);
  });

  it("pairs consecutive deletions and insertions into two-column replacements", () => {
    expect(diffLines(["old one", "old two"], ["new one", "new two"])).toEqual([
      { kind: "replace", before: "old one", after: "new one" },
      { kind: "replace", before: "old two", after: "new two" },
    ] satisfies DiffRow[]);
  });

  it("returns an honestly marked bounded Comparison instead of false equality", () => {
    const rows = diffLines(
      Array.from({ length: 20_001 }, (_, index) => `old ${index}`),
      Array.from({ length: 20_001 }, (_, index) => `new ${index}`),
    );

    expect(rows).toEqual([
      {
        kind: "omitted",
        before: null,
        after: null,
        omittedBefore: 20_001,
        omittedAfter: 20_001,
      },
    ]);
  });

  it("compares changed targets at structure and visible-text levels", () => {
    const before = JSON.stringify({
      formatVersion: 1,
      targets: [
        {
          elements: [
            { namespace: "html", name: "article", childElementCount: 1 },
            { namespace: "html", name: "p", childElementCount: 0 },
          ],
          visibleText: "Old title\nShared",
        },
      ],
    });
    const after = JSON.stringify({
      formatVersion: 1,
      targets: [
        {
          elements: [
            { namespace: "html", name: "article", childElementCount: 1 },
            { namespace: "html", name: "section", childElementCount: 0 },
          ],
          visibleText: "New title\nShared",
        },
      ],
    });

    expect(compareSnapshots(before, after)).toEqual({
      complete: true,
      targets: [
        {
          kind: "replace",
          structure: [
            { kind: "equal", before: "html:article", after: "html:article" },
            {
              kind: "replace",
              before: "  html:p",
              after: "  html:section",
            },
          ],
          text: [
            { kind: "replace", before: "Old title", after: "New title" },
            { kind: "equal", before: "Shared", after: "Shared" },
          ],
        },
      ],
    });
  });
});
