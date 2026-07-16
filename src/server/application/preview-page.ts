import {
  PageProbeError,
  type PagePreview,
  type PagePreviewInput,
  type PageProbe,
} from "./page-probe.js";

export type PreviewInputErrorCode =
  "invalid_selector" | "invalid_url" | "unsupported_selector";

export class PreviewInputError extends Error {
  constructor(
    readonly code: PreviewInputErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PreviewInputError";
  }
}

export async function previewPage(
  input: PagePreviewInput,
  pageProbe: PageProbe,
): Promise<PagePreview & { targetSelector: string }> {
  const validated = validatePreviewInput(input);
  const result = await pageProbe.preview({
    url: validated.url,
    targetSelector: validated.targetSelector,
  });
  if (!result.ok) {
    throw new PageProbeError(result);
  }
  return { ...result.preview, targetSelector: validated.targetSelector };
}

export function validatePreviewInput(
  input: PagePreviewInput,
): PagePreviewInput {
  validateUrl(input.url);
  return {
    url: input.url.trim(),
    targetSelector: validateTargetSelector(input.targetSelector),
  };
}

function validateUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new PreviewInputError(
      "invalid_url",
      "Введите абсолютный HTTP(S) URL.",
    );
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.hostname === "" ||
    url.username !== "" ||
    url.password !== ""
  ) {
    throw new PreviewInputError(
      "invalid_url",
      "Введите публичный HTTP(S) URL без имени пользователя и пароля.",
    );
  }
}

function validateTargetSelector(value: string): string {
  const selector = value.trim();
  if (selector === "") {
    throw new PreviewInputError(
      "invalid_selector",
      "Целевой селектор не может быть пустым.",
    );
  }
  if (
    selector.startsWith("//") ||
    /^(?:css|id|text|xpath|pierce|_react|_vue)=/iu.test(selector)
  ) {
    throw new PreviewInputError(
      "unsupported_selector",
      "Поддерживаются только стандартные CSS-селекторы light DOM.",
    );
  }
  return selector;
}
