import type {
  PageProbeDiagnostics,
  PageProbeErrorCode,
  PageProbeSelectorField,
} from "../application/page-probe.js";

export class PageProbeAbort extends Error {
  constructor(
    readonly code: PageProbeErrorCode,
    message: string,
    readonly diagnostics?: PageProbeDiagnostics,
    readonly field?: PageProbeSelectorField,
    readonly index?: number,
  ) {
    super(message);
    this.name = "PageProbeAbort";
  }
}
