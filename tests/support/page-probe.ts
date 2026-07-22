import type { PageProbeResult } from "../../src/server/application/page-probe.js";

export function simplePagePreviewTargets(...visibleTexts: string[]) {
  return visibleTexts.map((visibleText) => ({
    elements: [
      {
        namespace: "http://www.w3.org/1999/xhtml",
        name: "div",
        childElementCount: 0,
      },
    ],
    visibleText,
  }));
}

export function successfulPageProbeResult(
  finalUrl: string,
  targetMatches: Array<{ selector: string; matchCount: number }>,
  targets: Array<{
    elements: Array<{
      namespace: string | null;
      name: string;
      childElementCount: number;
    }>;
    visibleText: string;
    links?: Array<{ start: number; end: number; href: string }>;
  }> = [],
): PageProbeResult {
  return {
    ok: true,
    preview: {
      finalUrl,
      httpStatus: 200,
      targetMatches,
      targetCount: targets.length,
      targets,
      timings: {
        totalMs: 10,
        navigationMs: 4,
        targetMs: 2,
        scrollMs: 1,
        stabilityMs: 2,
        extractionMs: 1,
      },
    },
  };
}
