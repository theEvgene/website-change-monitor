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

export interface PlaywrightPageProbeOptions {
  networkAccess: NetworkAccess;
  timings?: Partial<PageProbeTimings>;
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

export function createPlaywrightPageProbe(
  browser: Browser,
  options: PlaywrightPageProbeOptions,
): PageProbe {
  const timings = { ...productionTimings, ...options.timings };

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
    await validateNativeSelector(page, input.targetSelector);

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
      waitForVisibleTarget(page!, input.targetSelector, timings.targetMs),
    );
    stage = "scroll";
    await timed("scrollMs", () =>
      scrollToFirstVisibleTarget(page!, input.targetSelector, timings.scrollMs),
    );
    stage = "stability";
    await timed("stabilityMs", async () => {
      if (timings.settleDelayMs > 0) {
        await page!.waitForTimeout(timings.settleDelayMs);
      }
      await waitForStableTargets(page!, input.targetSelector, timings);
    });
    stage = "extraction";
    const matchCount = await timed("extractionMs", () =>
      extractMatchCount(page!, input.targetSelector, timings.extractionMs),
    );
    if (blockedError instanceof PageProbeAbort) {
      throw blockedError;
    }

    return {
      finalUrl: page.url(),
      httpStatus,
      matchCount,
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

async function validateNativeSelector(page: Page, selector: string) {
  try {
    await page.evaluate(
      (value) => document.querySelectorAll(value).length,
      selector,
    );
  } catch {
    throw pageError(
      "invalid_selector",
      "Целевой CSS-селектор имеет неверный синтаксис.",
    );
  }
}

function visitFirstVisibleTarget({
  selector,
  scroll,
}: {
  selector: string;
  scroll: boolean;
}): boolean {
  const element = [...document.querySelectorAll(selector)].find((candidate) => {
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
  selector: string,
  timeout: number,
) {
  try {
    await page.waitForFunction(
      visitFirstVisibleTarget,
      { selector, scroll: false },
      { timeout },
    );
  } catch (error: unknown) {
    if (!(error instanceof errors.TimeoutError)) {
      throw error;
    }
    const count = await page.evaluate(
      (value) => document.querySelectorAll(value).length,
      selector,
    );
    throw pageError(
      count === 0 ? "target_not_found" : "target_not_visible",
      count === 0
        ? "Целевой селектор не нашёл элементов."
        : "Найденные элементы не отображаются на странице.",
    );
  }
}

async function scrollToFirstVisibleTarget(
  page: Page,
  selector: string,
  timeout: number,
) {
  try {
    await Promise.race([
      page
        .evaluate(visitFirstVisibleTarget, { selector, scroll: true })
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
  selector: string,
  timings: Pick<PageProbeTimings, "quietWindowMs" | "stabilityMs">,
) {
  const stable = await page.evaluate(
    ({ selector: value, quietWindowMs, stabilityMs }) =>
      new Promise<boolean>((resolve) => {
        let signature = targetSignature(value);
        let quietTimer = window.setTimeout(done, quietWindowMs);
        const stopTimer = window.setTimeout(() => done(false), stabilityMs);
        const observer = new MutationObserver(() => {
          const next = targetSignature(value);
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

        function targetSignature(targetSelector: string) {
          return [...document.querySelectorAll(targetSelector)]
            .map((element) => element.outerHTML)
            .join("\u0000");
        }

        function done(result = true) {
          observer.disconnect();
          window.clearTimeout(quietTimer);
          window.clearTimeout(stopTimer);
          resolve(result);
        }
      }),
    {
      selector,
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

async function extractMatchCount(
  page: Page,
  selector: string,
  timeout: number,
) {
  try {
    const count = await Promise.race([
      page.evaluate(
        (value) => document.querySelectorAll(value).length,
        selector,
      ),
      rejectAfter(timeout),
    ]);
    if (count === 0) {
      throw pageError(
        "target_disappeared",
        "Целевые элементы исчезли до извлечения.",
      );
    }
    return count;
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

function pageError(code: PageProbeErrorCode, message: string) {
  return new PageProbeAbort(code, message);
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
  return new PageProbeAbort(error.code, error.message, diagnostics);
}

function effectiveUrl(page: Page | undefined, fallback: string): string {
  const current = page?.url();
  return current === undefined || current === "about:blank"
    ? fallback
    : current;
}
