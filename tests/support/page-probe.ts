import type { PageProbeResult } from "../../src/server/application/page-probe.js";

export function successfulPageProbeResult(
  finalUrl: string,
  matchCount: number,
): PageProbeResult {
  return {
    ok: true,
    preview: {
      finalUrl,
      httpStatus: 200,
      matchCount,
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
