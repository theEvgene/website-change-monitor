import { useState, type FormEvent } from "react";
import {
  PreviewInputError,
  validatePreviewInput,
} from "../server/application/preview-page.js";

interface PreviewResponse {
  finalUrl: string;
  targetSelector: string;
  matchCount: number;
}

type PreviewState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "success"; result: PreviewResponse }
  | { kind: "error"; message: string };

export function PreviewPanel() {
  const [url, setUrl] = useState("");
  const [targetSelector, setTargetSelector] = useState("");
  const [state, setState] = useState<PreviewState>({ kind: "idle" });

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    let validated: ReturnType<typeof validatePreviewInput>;
    try {
      validated = validatePreviewInput({ url, targetSelector });
    } catch (error: unknown) {
      setState({
        kind: "error",
        message:
          error instanceof PreviewInputError
            ? error.message
            : "Не удалось проверить введённые данные.",
      });
      return;
    }
    const selectorSyntaxMessage = validateSelectorSyntax(
      validated.targetSelector,
    );
    if (selectorSyntaxMessage !== undefined) {
      setState({ kind: "error", message: selectorSyntaxMessage });
      return;
    }

    setState({ kind: "loading" });
    try {
      const response = await fetch("/api/preview", {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify(validated),
      });
      const body = (await response.json()) as
        PreviewResponse | { error?: { message?: string } };
      if (!response.ok || !isPreviewResponse(body)) {
        throw new Error(
          "error" in body && body.error?.message !== undefined
            ? body.error.message
            : "Не удалось исследовать страницу.",
        );
      }
      setState({ kind: "success", result: body });
    } catch (error: unknown) {
      setState({
        kind: "error",
        message:
          error instanceof Error
            ? error.message
            : "Не удалось исследовать страницу.",
      });
    }
  }

  return (
    <section className="preview-panel" aria-labelledby="preview-title">
      <p className="eyebrow">Новый Монитор</p>
      <h2 id="preview-title">Проверить Целевой селектор</h2>
      <p className="muted">
        Укажите публичную страницу и стандартный CSS-селектор из DevTools.
      </p>
      <form className="preview-form" onSubmit={(event) => void submit(event)}>
        <label>
          <span>URL страницы</span>
          <input
            type="url"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="https://example.com/catalog"
            required
          />
        </label>
        <label>
          <span>Целевой CSS-селектор</span>
          <input
            value={targetSelector}
            onChange={(event) => setTargetSelector(event.target.value)}
            placeholder=".product-card"
            required
          />
        </label>
        <button type="submit" disabled={state.kind === "loading"}>
          {state.kind === "loading" ? "Проверяем…" : "Предпросмотреть"}
        </button>
      </form>
      <div className="preview-result" aria-live="polite">
        {state.kind === "success" ? (
          <>
            <strong>Найдено элементов: {state.result.matchCount}</strong>
            <span>Итоговый URL: {state.result.finalUrl}</span>
          </>
        ) : null}
        {state.kind === "error" ? (
          <strong className="preview-error">{state.message}</strong>
        ) : null}
      </div>
    </section>
  );
}

function isPreviewResponse(
  value: PreviewResponse | { error?: { message?: string } },
): value is PreviewResponse {
  return (
    "finalUrl" in value &&
    typeof value.finalUrl === "string" &&
    "targetSelector" in value &&
    typeof value.targetSelector === "string" &&
    "matchCount" in value &&
    typeof value.matchCount === "number"
  );
}

function validateSelectorSyntax(selector: string): string | undefined {
  try {
    document.querySelector(selector);
  } catch {
    return "Целевой CSS-селектор имеет неверный синтаксис.";
  }
  return undefined;
}
