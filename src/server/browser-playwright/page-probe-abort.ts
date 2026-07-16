import type {
  PageProbeDiagnostics,
  PageProbeErrorCode,
} from "../application/page-probe.js";

export class PageProbeAbort extends Error {
  constructor(
    readonly code: PageProbeErrorCode,
    message: string,
    readonly diagnostics?: PageProbeDiagnostics,
  ) {
    super(message);
    this.name = "PageProbeAbort";
  }
}
