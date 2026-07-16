import {
  PageProbeError,
  type PagePreview,
  type PagePreviewInput,
  type PageProbe,
} from "./page-probe.js";

export type PreviewInputErrorCode =
  | "duplicate_selector"
  | "invalid_selector"
  | "invalid_url"
  | "unsupported_selector";

export type PreviewSelectorField =
  | "targetSelectors"
  | "exclusionSelectors";

export class PreviewInputError extends Error {
  constructor(
    readonly code: PreviewInputErrorCode,
    message: string,
    readonly field?: PreviewSelectorField,
    readonly index?: number,
  ) {
    super(message);
    this.name = "PreviewInputError";
  }
}

export async function previewPage(
  input: PagePreviewInput,
  pageProbe: PageProbe,
): Promise<PagePreview & { exclusionSelectors: string[] }> {
  const validated = validatePreviewInput(input);
  const result = await pageProbe.preview(validated);
  if (!result.ok) {
    throw new PageProbeError(result);
  }
  return {
    ...result.preview,
    exclusionSelectors: validated.exclusionSelectors,
  };
}

export function validatePreviewInput(
  input: PagePreviewInput,
): PagePreviewInput {
  validateUrl(input.url);
  return {
    url: input.url.trim(),
    targetSelectors: validateSelectors(input.targetSelectors, "targetSelectors", true),
    exclusionSelectors: validateSelectors(
      input.exclusionSelectors,
      "exclusionSelectors",
      false,
    ),
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

function validateSelectors(
  values: string[],
  field: PreviewSelectorField,
  required: boolean,
): string[] {
  if (required && values.length === 0) {
    throw new PreviewInputError(
      "invalid_selector",
      "Добавьте хотя бы один Целевой селектор.",
      field,
    );
  }

  const selectors: string[] = [];
  const seen = new Set<string>();
  for (const [index, value] of values.entries()) {
    const selector = value.trim();
    if (selector === "") {
      throw new PreviewInputError(
        "invalid_selector",
        field === "targetSelectors"
          ? "Целевой селектор не может быть пустым."
          : "Селектор исключения не может быть пустым.",
        field,
        index,
      );
    }
    if (
      selector.startsWith("//") ||
      /^(?:css|id|text|xpath|pierce|_react|_vue)=/iu.test(selector)
    ) {
      throw new PreviewInputError(
        "unsupported_selector",
        "Поддерживаются только стандартные CSS-селекторы light DOM.",
        field,
        index,
      );
    }
    if (seen.has(selector)) {
      throw new PreviewInputError(
        "duplicate_selector",
        "Такой селектор уже добавлен.",
        field,
        index,
      );
    }
    seen.add(selector);
    selectors.push(selector);
  }
  return selectors;
}
