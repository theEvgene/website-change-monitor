/// <reference lib="dom" />

import type { Browser, BrowserContext, Page } from "playwright";
import { chromium, errors } from "playwright";

import {
  type PageProbeDiagnostics,
  type PageProbeErrorCode,
  type PageProbeObservedTimings,
  type PagePreviewInput,
  type PageProbe,
  type PageProbeStage,
} from "../application/page-probe.js";
import { PageProbeAbort } from "./page-probe-abort.js";
import { startSafeProxy } from "./safe-proxy.js";
import { publicNetworkAccess } from "./public-network-access.js";

export interface NetworkTarget {
  address: string;
  family: 4 | 6;
}

export interface NetworkAccess {
  resolve(url: URL): Promise<NetworkTarget>;
}

export interface PageProbeTimings {
  deadlineMs: number;
  navigationMs: number;
  targetMs: number;
  scrollMs: number;
  settleDelayMs: number;
  stabilityMs: number;
  quietWindowMs: number;
  extractionMs: number;
}

export interface PageProbeResourceLimits {
  maxTargets: number;
  maxElementRecords: number;
  maxVisibleTextCharacters: number;
}

export interface PlaywrightPageProbeOptions {
  networkAccess: NetworkAccess;
  timings?: Partial<PageProbeTimings>;
  limits?: Partial<PageProbeResourceLimits>;
}

export interface PageProbeRuntime {
  pageProbe: PageProbe;
  close(): Promise<void>;
}

const productionTimings: PageProbeTimings = {
  deadlineMs: 60_000,
  navigationMs: 30_000,
  targetMs: 15_000,
  scrollMs: 5_000,
  settleDelayMs: 1_000,
  stabilityMs: 5_000,
  quietWindowMs: 750,
  extractionMs: 5_000,
};

const productionResourceLimits: PageProbeResourceLimits = {
  maxTargets: 500,
  maxElementRecords: 20_000,
  maxVisibleTextCharacters: 1_000_000,
};

export function createPlaywrightPageProbe(
  browser: Browser,
  options: PlaywrightPageProbeOptions,
): PageProbe {
  const timings = { ...productionTimings, ...options.timings };
  const limits = { ...productionResourceLimits, ...options.limits };

  return {
    async preview(input) {
      const started = Date.now();
      try {
        return {
          ok: true,
          preview: await runPreview(
            browser,
            options.networkAccess,
            timings,
            limits,
            input,
          ),
        };
      } catch (error: unknown) {
        if (
          error instanceof PageProbeAbort &&
          error.diagnostics !== undefined
        ) {
          return {
            ok: false,
            code: error.code,
            message: error.message,
            ...(error.field === undefined ? {} : { field: error.field }),
            ...(error.index === undefined ? {} : { index: error.index }),
            ...error.diagnostics,
          };
        }
        return {
          ok: false,
          code: "browser_failed",
          message: "Не удалось подготовить Chromium к исследованию страницы.",
          stage: "setup",
          finalUrl: input.url,
          timings: finishObservedTimings(emptyObservedTimings(), started),
        };
      }
    },
  };
}

export async function launchPlaywrightPageProbe(): Promise<PageProbeRuntime> {
  const browser = await chromium.launch({ headless: true });
  return {
    pageProbe: createPlaywrightPageProbe(browser, {
      networkAccess: publicNetworkAccess,
    }),
    async close() {
      await browser.close({ reason: "application_shutdown" });
    },
  };
}

async function runPreview(
  browser: Browser,
  networkAccess: NetworkAccess,
  timings: PageProbeTimings,
  limits: PageProbeResourceLimits,
  input: PagePreviewInput,
) {
  let context: BrowserContext | undefined;
  let page: Page | undefined;
  let deadlineExceeded = false;
  let blockedError: unknown;
  let stage: PageProbeStage = "setup";
  let httpStatus: number | undefined;
  const previewStarted = Date.now();
  const observedTimings = emptyObservedTimings();
  const timed = async <T>(
    key: Exclude<keyof PageProbeObservedTimings, "totalMs">,
    action: () => Promise<T>,
  ): Promise<T> => {
    const started = Date.now();
    try {
      return await action();
    } finally {
      observedTimings[key] += Date.now() - started;
    }
  };
  const proxy = await startSafeProxy(networkAccess, (error) => {
    blockedError = error;
  });
  const deadline = setTimeout(() => {
    deadlineExceeded = true;
    void context?.close({ reason: "check_deadline_exceeded" });
  }, timings.deadlineMs);

  try {
    context = await browser.newContext({
      acceptDownloads: false,
      colorScheme: "light",
      deviceScaleFactor: 1,
      ignoreHTTPSErrors: false,
      locale: "ru-RU",
      permissions: [],
      proxy: { server: proxy.url },
      serviceWorkers: "block",
      timezoneId: "Europe/Moscow",
      viewport: { width: 1440, height: 900 },
    });
    await disableWebRtc(context);
    context.setDefaultNavigationTimeout(timings.navigationMs);
    context.setDefaultTimeout(timings.targetMs);
    page = await context.newPage();
    let downloadStarted = false;
    page.on("dialog", (dialog) => void dialog.dismiss());
    page.on("popup", (popup) => void popup.close());
    page.on("download", (download) => {
      downloadStarted = true;
      void download.cancel();
    });

    stage = "validation";
    await validateNativeSelectors(page, input);

    let response;
    stage = "navigation";
    try {
      response = await timed("navigationMs", () =>
        page!.goto(input.url, {
          waitUntil: "domcontentloaded",
          timeout: stageTimeout(timings.navigationMs, timings.deadlineMs),
        }),
      );
    } catch (error: unknown) {
      if (deadlineExceeded) {
        throw pageError(
          "check_deadline_exceeded",
          "Превышен общий лимит исследования страницы.",
        );
      }
      if (blockedError instanceof PageProbeAbort) {
        throw blockedError;
      }
      if (
        downloadStarted ||
        (error instanceof Error && /download is starting/iu.test(error.message))
      ) {
        throw pageError(
          "unsupported_content",
          "Загрузка файлов не поддерживается.",
        );
      }
      if (error instanceof errors.TimeoutError) {
        throw pageError("navigation_timeout", "Страница не ответила вовремя.");
      }
      throw pageError("navigation_failed", "Не удалось открыть страницу.");
    }

    if (blockedError instanceof PageProbeAbort) {
      throw blockedError;
    }
    if (response === null) {
      throw pageError("navigation_failed", "Главный документ не был загружен.");
    }
    httpStatus = response.status();
    if (response.status() >= 400) {
      throw pageError("http_error", "Страница вернула ошибку HTTP.");
    }
    const contentType = response.headers()["content-type"]?.toLowerCase() ?? "";
    if (
      !contentType.startsWith("text/html") &&
      !contentType.startsWith("application/xhtml+xml")
    ) {
      throw pageError(
        "unsupported_content",
        "Главный ресурс не является HTML-страницей.",
      );
    }

    stage = "target";
    await timed("targetMs", () =>
      waitForVisibleTarget(page!, input.targetSelectors, timings.targetMs),
    );
    stage = "scroll";
    await timed("scrollMs", () =>
      scrollToFirstVisibleTarget(page!, input.targetSelectors, timings.scrollMs),
    );
    stage = "stability";
    await timed("stabilityMs", async () => {
      if (timings.settleDelayMs > 0) {
        await page!.waitForTimeout(timings.settleDelayMs);
      }
      await waitForStableTargets(page!, input, timings);
    });
    stage = "extraction";
    const extracted = await timed("extractionMs", () =>
      extractObservationScope(page!, input, timings.extractionMs, limits),
    );
    if (blockedError instanceof PageProbeAbort) {
      throw blockedError;
    }

    return {
      finalUrl: page.url(),
      httpStatus,
      ...extracted,
      timings: finishObservedTimings(observedTimings, previewStarted),
    };
  } catch (error: unknown) {
    let failure: PageProbeAbort;
    if (error instanceof PageProbeAbort) {
      failure = error;
    } else if (deadlineExceeded) {
      failure = pageError(
        "check_deadline_exceeded",
        "Превышен общий лимит исследования страницы.",
      );
    } else {
      failure = pageError(
        "browser_failed",
        "Chromium не смог исследовать страницу.",
      );
    }
    throw diagnosePageError(failure, {
      stage,
      finalUrl: effectiveUrl(page, input.url),
      httpStatus,
      timings: finishObservedTimings(observedTimings, previewStarted),
    });
  } finally {
    clearTimeout(deadline);
    await context?.close().catch(() => undefined);
    await proxy.close();
  }
}

async function disableWebRtc(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    for (const name of ["RTCPeerConnection", "webkitRTCPeerConnection"]) {
      if (name in globalThis) {
        Object.defineProperty(globalThis, name, {
          configurable: false,
          enumerable: false,
          value: undefined,
          writable: false,
        });
      }
    }
  });
}

async function validateNativeSelectors(page: Page, input: PagePreviewInput) {
  const invalid = await page.evaluate(
    ({ targetSelectors, exclusionSelectors }) => {
      for (const [index, selector] of targetSelectors.entries()) {
        try {
          document.querySelectorAll(selector);
        } catch {
          return { field: "targetSelectors" as const, index };
        }
      }
      for (const [index, selector] of exclusionSelectors.entries()) {
        try {
          document.querySelectorAll(selector);
        } catch {
          return { field: "exclusionSelectors" as const, index };
        }
      }
      return undefined;
    },
    input,
  );
  if (invalid !== undefined) {
    throw pageError(
      "invalid_selector",
      invalid.field === "targetSelectors"
        ? `Целевой CSS-селектор ${invalid.index + 1} имеет неверный синтаксис.`
        : `CSS-селектор исключения ${invalid.index + 1} имеет неверный синтаксис.`,
      invalid,
    );
  }
}

function visitFirstVisibleTarget({
  selectors,
  scroll,
}: {
  selectors: string[];
  scroll: boolean;
}): boolean {
  const matches = new Set<Element>();
  for (const selector of selectors) {
    for (const element of document.querySelectorAll(selector)) {
      matches.add(element);
    }
  }
  const ordered = [...matches].sort((left, right) => {
    if (left === right) {
      return 0;
    }
    return left.compareDocumentPosition(right) & Node.DOCUMENT_POSITION_PRECEDING
      ? 1
      : -1;
  });
  const element = ordered.find((candidate) => {
    const style = getComputedStyle(candidate);
    const box = candidate.getBoundingClientRect();
    return (
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      box.width > 0 &&
      box.height > 0
    );
  });
  if (element === undefined) {
    return false;
  }
  if (scroll) {
    element.scrollIntoView({ behavior: "instant", block: "center" });
  }
  return true;
}

async function waitForVisibleTarget(
  page: Page,
  selectors: string[],
  timeout: number,
) {
  try {
    await page.waitForFunction(
      visitFirstVisibleTarget,
      { selectors, scroll: false },
      { timeout },
    );
  } catch (error: unknown) {
    if (!(error instanceof errors.TimeoutError)) {
      throw error;
    }
    const result = await page.evaluate((values) => {
      const matches = new Set<Element>();
      const matchCounts = values.map((selector) => {
        const selectorMatches = document.querySelectorAll(selector);
        for (const element of selectorMatches) {
          matches.add(element);
        }
        return selectorMatches.length;
      });
      return { matchCounts, targetCount: matches.size };
    }, selectors);
    throw pageError(
      result.targetCount === 0 ? "target_not_found" : "target_not_visible",
      result.targetCount === 0
        ? "Целевой селектор не нашёл элементов."
        : "Найденные элементы не отображаются на странице.",
      result.targetCount === 0
        ? {
            field: "targetSelectors",
            index: Math.max(
              0,
              result.matchCounts.findIndex((count) => count === 0),
            ),
          }
        : undefined,
    );
  }
}

async function scrollToFirstVisibleTarget(
  page: Page,
  selectors: string[],
  timeout: number,
) {
  try {
    await Promise.race([
      page
        .evaluate(visitFirstVisibleTarget, { selectors, scroll: true })
        .then((found) => {
          if (!found) {
            throw new Error("Visible target disappeared");
          }
        }),
      rejectAfter(timeout),
    ]);
  } catch {
    throw pageError("scroll_failed", "Не удалось прокрутить страницу к цели.");
  }
}

async function waitForStableTargets(
  page: Page,
  input: PagePreviewInput,
  timings: Pick<PageProbeTimings, "quietWindowMs" | "stabilityMs">,
) {
  const stable = await page.evaluate(
    ({ targetSelectors, exclusionSelectors, quietWindowMs, stabilityMs }) =>
      new Promise<boolean>((resolve) => {
        let signature = targetSignature();
        let quietTimer = window.setTimeout(done, quietWindowMs);
        const stopTimer = window.setTimeout(() => done(false), stabilityMs);
        const observer = new MutationObserver(() => {
          const next = targetSignature();
          if (next === signature) {
            return;
          }
          signature = next;
          window.clearTimeout(quietTimer);
          quietTimer = window.setTimeout(done, quietWindowMs);
        });
        observer.observe(document, {
          attributes: true,
          characterData: true,
          childList: true,
          subtree: true,
        });

        function targetSignature() {
          const matchCounts = targetSelectors.map(
            (selector) => document.querySelectorAll(selector).length,
          );
          const targetSet = new Set<Element>();
          for (const selector of targetSelectors) {
            for (const element of document.querySelectorAll(selector)) {
              targetSet.add(element);
            }
          }
          const targets = [...targetSet].sort((left, right) => {
            if (left === right) {
              return 0;
            }
            return left.compareDocumentPosition(right) &
              Node.DOCUMENT_POSITION_PRECEDING
              ? 1
              : -1;
          });
          const projections = targets.map((target) => {
            const excluded = exclusionBoundaries(target);
            const entries: string[] = [];
            visit(target, target, excluded, entries);
            return entries;
          });
          return JSON.stringify([matchCounts, projections]);
        }

        function exclusionBoundaries(target: Element): Set<Element> {
          const matches = new Set<Element>();
          for (const selector of exclusionSelectors) {
            for (const element of target.querySelectorAll(selector)) {
              matches.add(element);
            }
          }
          return new Set(
            [...matches].filter(
              (candidate) =>
                ![...matches].some(
                  (other) => other !== candidate && other.contains(candidate),
                ),
            ),
          );
        }

        function visit(
          node: Node,
          root: Element,
          excluded: Set<Element>,
          entries: string[],
        ) {
          if (node instanceof Element) {
            if (node !== root && excluded.has(node)) {
              return;
            }
            const attributes = node
              .getAttributeNames()
              .sort()
              .map((name) => [name, node.getAttribute(name)]);
            entries.push(
              JSON.stringify([node.namespaceURI, node.localName, attributes]),
            );
          } else if (node instanceof Text) {
            entries.push(JSON.stringify(["text", node.data]));
          }
          for (const child of node.childNodes) {
            visit(child, root, excluded, entries);
          }
        }

        function done(result = true) {
          observer.disconnect();
          window.clearTimeout(quietTimer);
          window.clearTimeout(stopTimer);
          resolve(result);
        }
      }),
    {
      targetSelectors: input.targetSelectors,
      exclusionSelectors: input.exclusionSelectors,
      quietWindowMs: timings.quietWindowMs,
      stabilityMs: timings.stabilityMs,
    },
  );
  if (!stable) {
    throw pageError(
      "content_unstable",
      "Целевая область продолжает изменяться.",
    );
  }
}

async function extractObservationScope(
  page: Page,
  input: PagePreviewInput,
  timeout: number,
  limits: PageProbeResourceLimits,
) {
  try {
    const extracted = await Promise.race([
      page.evaluate(({ targetSelectors, exclusionSelectors, limits }) => {
        const targetMatches = targetSelectors.map((selector) => ({
          selector,
          matchCount: document.querySelectorAll(selector).length,
        }));
        const targetSet = new Set<Element>();
        for (const selector of targetSelectors) {
          for (const element of document.querySelectorAll(selector)) {
            targetSet.add(element);
          }
        }
        const targets = [...targetSet].sort((left, right) => {
          if (left === right) {
            return 0;
          }
          return left.compareDocumentPosition(right) &
            Node.DOCUMENT_POSITION_PRECEDING
            ? 1
            : -1;
        });

        if (targets.length > limits.maxTargets) {
          return { status: "too_large" as const, reason: "targets" as const };
        }

        let elementRecordCount = 0;
        let visibleTextCharacterCount = 0;
        const extractedTargets: Array<{
          elements: Array<{
            namespace: string | null;
            name: string;
            childElementCount: number;
          }>;
          visibleText: string;
        }> = [];
        for (const target of targets) {
          const targetResult = extractTarget(target);
          if (typeof targetResult === "string") {
            return { status: "too_large" as const, reason: targetResult };
          }
          extractedTargets.push(targetResult);
        }

        return {
          status: "ok" as const,
          targetMatches,
          targetCount: targets.length,
          targets: extractedTargets,
        };

        function extractTarget(target: Element) {
          const excluded = exclusionBoundaries(target);
          const displays = [...excluded].map((element) => ({
            element: element as HTMLElement,
            value: (element as HTMLElement).style.getPropertyValue("display"),
            priority: (element as HTMLElement).style.getPropertyPriority(
              "display",
            ),
          }));
          for (const { element } of displays) {
            element.style.setProperty("display", "none", "important");
          }
          try {
            const style = getComputedStyle(target);
            const box = target.getBoundingClientRect();
            const rendered =
              style.display !== "none" &&
              style.visibility !== "hidden" &&
              box.width > 0 &&
              box.height > 0;
            const visibleText =
              rendered && target instanceof HTMLElement ? target.innerText : "";
            visibleTextCharacterCount += visibleText.length;
            if (
              visibleTextCharacterCount > limits.maxVisibleTextCharacters
            ) {
              return "visible_text" as const;
            }
            const elements: Array<{
              namespace: string | null;
              name: string;
              childElementCount: number;
            }> = [];
            if (!visitElement(target, target, excluded, elements)) {
              return "elements" as const;
            }
            return { elements, visibleText };
          } finally {
            for (const { element, value, priority } of displays) {
              if (value === "") {
                element.style.removeProperty("display");
              } else {
                element.style.setProperty("display", value, priority);
              }
            }
          }
        }

        function exclusionBoundaries(target: Element): Set<Element> {
          const matches = new Set<Element>();
          for (const selector of exclusionSelectors) {
            for (const element of target.querySelectorAll(selector)) {
              matches.add(element);
            }
          }
          return new Set(
            [...matches].filter(
              (candidate) =>
                ![...matches].some(
                  (other) => other !== candidate && other.contains(candidate),
                ),
            ),
          );
        }

        function visitElement(
          element: Element,
          root: Element,
          excluded: Set<Element>,
          result: Array<{
            namespace: string | null;
            name: string;
            childElementCount: number;
          }>,
        ): boolean {
          if (element !== root && excluded.has(element)) {
            return true;
          }
          elementRecordCount += 1;
          if (elementRecordCount > limits.maxElementRecords) {
            return false;
          }
          const children = [...element.children].filter(
            (child) => !excluded.has(child),
          );
          result.push({
            namespace: element.namespaceURI,
            name: element.localName,
            childElementCount: children.length,
          });
          for (const child of children) {
            if (!visitElement(child, root, excluded, result)) {
              return false;
            }
          }
          return true;
        }
      }, { ...input, limits }),
      rejectAfter(timeout),
    ]);
    if (extracted.status === "too_large") {
      throw pageError(
        "target_area_too_large",
        "Целевая область слишком велика. Сузьте Целевые селекторы или добавьте Селекторы исключения.",
      );
    }
    if (extracted.targetCount === 0) {
      throw pageError(
        "target_disappeared",
        "Целевые элементы исчезли до извлечения.",
      );
    }
    const missing = extracted.targetMatches.findIndex(
      ({ matchCount }) => matchCount === 0,
    );
    if (missing >= 0) {
      throw pageError(
        "target_not_found",
        `Целевой селектор ${missing + 1} не нашёл элементов.`,
        { field: "targetSelectors", index: missing },
      );
    }
    return extracted;
  } catch (error: unknown) {
    if (error instanceof PageProbeAbort) {
      throw error;
    }
    throw pageError("extraction_failed", "Не удалось извлечь Целевую область.");
  }
}

function rejectAfter(timeout: number): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error("Stage timeout")), timeout);
  });
}

function stageTimeout(stage: number, deadline: number): number {
  return Math.max(1, Math.min(stage, deadline));
}

function pageError(
  code: PageProbeErrorCode,
  message: string,
  location?: {
    field: "targetSelectors" | "exclusionSelectors";
    index: number;
  },
) {
  return new PageProbeAbort(
    code,
    message,
    undefined,
    location?.field,
    location?.index,
  );
}

function emptyObservedTimings(): PageProbeObservedTimings {
  return {
    totalMs: 0,
    navigationMs: 0,
    targetMs: 0,
    scrollMs: 0,
    stabilityMs: 0,
    extractionMs: 0,
  };
}

function finishObservedTimings(
  timings: PageProbeObservedTimings,
  started: number,
): PageProbeObservedTimings {
  return { ...timings, totalMs: Date.now() - started };
}

function diagnosePageError(
  error: PageProbeAbort,
  diagnostics: PageProbeDiagnostics,
): PageProbeAbort {
  return new PageProbeAbort(
    error.code,
    error.message,
    diagnostics,
    error.field,
    error.index,
  );
}

function effectiveUrl(page: Page | undefined, fallback: string): string {
  const current = page?.url();
  return current === undefined || current === "about:blank"
    ? fallback
    : current;
}
