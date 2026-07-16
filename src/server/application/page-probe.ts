export const pageProbeErrorCodes = [
  "address_blocked",
  "application_shutdown",
  "browser_failed",
  "check_deadline_exceeded",
  "content_unstable",
  "extraction_failed",
  "http_error",
  "invalid_selector",
  "invalid_url",
  "navigation_failed",
  "navigation_timeout",
  "scroll_failed",
  "target_disappeared",
  "target_not_found",
  "target_not_visible",
  "unsupported_content",
] as const;

export type PageProbeErrorCode = (typeof pageProbeErrorCodes)[number];

export interface PagePreviewInput {
  url: string;
  targetSelectors: string[];
  exclusionSelectors: string[];
}

export type PageProbeStage =
  | "setup"
  | "validation"
  | "navigation"
  | "target"
  | "scroll"
  | "stability"
  | "extraction";

export interface PageProbeObservedTimings {
  totalMs: number;
  navigationMs: number;
  targetMs: number;
  scrollMs: number;
  stabilityMs: number;
  extractionMs: number;
}

export interface PageProbeDiagnostics {
  stage: PageProbeStage;
  finalUrl?: string | undefined;
  httpStatus?: number | undefined;
  timings: PageProbeObservedTimings;
}

export interface PagePreview {
  finalUrl: string;
  httpStatus: number;
  targetMatches: PagePreviewSelectorMatch[];
  targetCount: number;
  targets: PagePreviewTarget[];
  timings: PageProbeObservedTimings;
}

export type PageProbeSelectorField =
  | "targetSelectors"
  | "exclusionSelectors";

export interface PagePreviewSelectorMatch {
  selector: string;
  matchCount: number;
}

export interface PagePreviewElement {
  namespace: string | null;
  name: string;
  childElementCount: number;
}

export interface PagePreviewTarget {
  elements: PagePreviewElement[];
  visibleText: string;
}

export interface PageProbeSuccess {
  ok: true;
  preview: PagePreview;
}

export interface PageProbeFailure extends PageProbeDiagnostics {
  ok: false;
  code: PageProbeErrorCode;
  message: string;
  field?: PageProbeSelectorField;
  index?: number;
}

export type PageProbeResult = PageProbeSuccess | PageProbeFailure;

export interface PageProbe {
  preview(input: PagePreviewInput): Promise<PageProbeResult>;
}

export class PageProbeError extends Error {
  readonly code: PageProbeErrorCode;
  readonly stage: PageProbeStage;
  readonly finalUrl?: string | undefined;
  readonly httpStatus?: number | undefined;
  readonly timings: PageProbeObservedTimings;
  readonly field: PageProbeSelectorField | undefined;
  readonly index: number | undefined;

  constructor(failure: PageProbeFailure) {
    super(failure.message);
    this.name = "PageProbeError";
    this.code = failure.code;
    this.stage = failure.stage;
    this.finalUrl = failure.finalUrl;
    this.httpStatus = failure.httpStatus;
    this.timings = failure.timings;
    this.field = failure.field;
    this.index = failure.index;
  }
}
