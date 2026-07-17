import { useState, type FormEvent } from "react";
import {
  PreviewInputError,
  type PreviewSelectorField,
  validatePreviewInput,
} from "../server/application/preview-page.js";

interface PreviewResponse {
  finalUrl: string;
  targetMatches: Array<{ selector: string; matchCount: number }>;
  exclusionSelectors: string[];
  targetCount: number;
  targets: Array<{
    elements: Array<{
      namespace: string | null;
      name: string;
      childElementCount: number;
    }>;
    visibleText: string;
  }>;
}

interface ApiErrorBody {
  error?: {
    message?: string;
    field?: PreviewSelectorField;
    index?: number;
  };
}

type PreviewState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "success"; result: PreviewResponse }
  | { kind: "error"; message: string };

type FieldErrors = Record<PreviewSelectorField, Record<number, string>>;

const emptyFieldErrors = (): FieldErrors => ({
  targetSelectors: {},
  exclusionSelectors: {},
});

export function PreviewPanel() {
  const [url, setUrl] = useState("");
  const [selectors, setSelectors] = useState<
    Record<PreviewSelectorField, string[]>
  >({
    targetSelectors: [""],
    exclusionSelectors: [],
  });
  const { targetSelectors, exclusionSelectors } = selectors;
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>(emptyFieldErrors);
  const [state, setState] = useState<PreviewState>({ kind: "idle" });

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFieldErrors(emptyFieldErrors());
    let validated: ReturnType<typeof validatePreviewInput>;
    try {
      validated = validatePreviewInput({
        url,
        targetSelectors,
        exclusionSelectors,
      });
    } catch (error: unknown) {
      handleInputError(error);
      return;
    }

    for (const field of [
      "targetSelectors",
      "exclusionSelectors",
    ] as const) {
      for (const [index, selector] of validated[field].entries()) {
        const message = validateSelectorSyntax(selector);
        if (message !== undefined) {
          setFieldError(field, index, message);
          setState({ kind: "error", message });
          return;
        }
      }
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
      const body = (await response.json()) as PreviewResponse | ApiErrorBody;
      if (!response.ok || !isPreviewResponse(body)) {
        const apiError = "error" in body ? body.error : undefined;
        if (
          apiError?.field !== undefined &&
          apiError.index !== undefined &&
          apiError.message !== undefined
        ) {
          setFieldError(apiError.field, apiError.index, apiError.message);
        }
        throw new Error(
          apiError?.message ?? "Не удалось исследовать страницу.",
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

  function handleInputError(error: unknown) {
    const message =
      error instanceof PreviewInputError
        ? error.message
        : "Не удалось проверить введённые данные.";
    if (
      error instanceof PreviewInputError &&
      error.field !== undefined &&
      error.index !== undefined
    ) {
      setFieldError(error.field, error.index, message);
    }
    setState({ kind: "error", message });
  }

  function setFieldError(
    field: PreviewSelectorField,
    index: number,
    message: string,
  ) {
    setFieldErrors((current) => ({
      ...current,
      [field]: { ...current[field], [index]: message },
    }));
  }

  function clearFieldError(field: PreviewSelectorField, index: number) {
    setFieldErrors((current) => {
      const next = { ...current[field] };
      delete next[index];
      return { ...current, [field]: next };
    });
  }

  function updateSelector(
    field: PreviewSelectorField,
    index: number,
    value: string,
  ) {
    const update = (current: string[]) =>
      current.map((selector, itemIndex) =>
        itemIndex === index ? value : selector,
      );
    setSelectors((current) => ({
      ...current,
      [field]: update(current[field]),
    }));
    clearFieldError(field, index);
    setState({ kind: "idle" });
  }

  function removeSelector(field: PreviewSelectorField, index: number) {
    const remove = (current: string[]) =>
      current.filter((_, itemIndex) => itemIndex !== index);
    setSelectors((current) => ({
      ...current,
      [field]: remove(current[field]),
    }));
    setFieldErrors(emptyFieldErrors());
    setState({ kind: "idle" });
  }

  return (
    <section className="preview-panel" aria-labelledby="preview-title">
      <p className="eyebrow">Новый Монитор</p>
      <h2 id="preview-title">Проверить Область наблюдения</h2>
      <p className="muted">
        Укажите публичную страницу, Целевые селекторы и необязательные
        Селекторы исключения.
      </p>
      <form className="preview-form" onSubmit={(event) => void submit(event)}>
        <label className="preview-url-field">
          <span>URL страницы</span>
          <input
            type="url"
            value={url}
            onChange={(event) => {
              setUrl(event.target.value);
              setState({ kind: "idle" });
            }}
            placeholder="https://example.com/catalog"
            required
          />
        </label>

        <SelectorGroup
          field="targetSelectors"
          legend="Целевые селекторы"
          values={targetSelectors}
          errors={fieldErrors.targetSelectors}
          addLabel="Добавить Целевой селектор"
          inputLabel="Целевой CSS-селектор"
          placeholder=".product-card"
          canRemove={(values) => values.length > 1}
          onAdd={() => {
            setSelectors((current) => ({
              ...current,
              targetSelectors: [...current.targetSelectors, ""],
            }));
            setState({ kind: "idle" });
          }}
          onChange={updateSelector}
          onRemove={removeSelector}
        />

        <SelectorGroup
          field="exclusionSelectors"
          legend="Селекторы исключения"
          values={exclusionSelectors}
          errors={fieldErrors.exclusionSelectors}
          addLabel="Добавить Селектор исключения"
          inputLabel="CSS-селектор исключения"
          placeholder=".price"
          canRemove={() => true}
          onAdd={() => {
            setSelectors((current) => ({
              ...current,
              exclusionSelectors: [...current.exclusionSelectors, ""],
            }));
            setState({ kind: "idle" });
          }}
          onChange={updateSelector}
          onRemove={removeSelector}
        />

        <button className="preview-submit" type="submit" disabled={state.kind === "loading"}>
          {state.kind === "loading" ? "Проверяем…" : "Предпросмотреть"}
        </button>
      </form>
      <div className="preview-result" aria-live="polite">
        {state.kind === "success" ? (
          <>
            <strong>Уникальных элементов: {state.result.targetCount}</strong>
            <ul className="selector-match-list">
              {state.result.targetMatches.map(({ selector, matchCount }) => (
                <li key={selector}>
                  {selector}: {matchCount}
                </li>
              ))}
            </ul>
            <ol className="preview-target-list">
              {state.result.targets.map((target, index) => (
                <li key={`${index}:${target.visibleText}`}>
                  {target.visibleText === "" ? "Нет видимого текста" : target.visibleText}
                </li>
              ))}
            </ol>
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

interface SelectorGroupProps {
  field: PreviewSelectorField;
  legend: string;
  values: string[];
  errors: Record<number, string>;
  addLabel: string;
  inputLabel: string;
  placeholder: string;
  canRemove(values: string[]): boolean;
  onAdd(): void;
  onChange(field: PreviewSelectorField, index: number, value: string): void;
  onRemove(field: PreviewSelectorField, index: number): void;
}

function SelectorGroup({
  field,
  legend,
  values,
  errors,
  addLabel,
  inputLabel,
  placeholder,
  canRemove,
  onAdd,
  onChange,
  onRemove,
}: SelectorGroupProps) {
  return (
    <fieldset className="selector-group">
      <legend>{legend}</legend>
      <div className="selector-list">
        {values.map((value, index) => {
          const error = errors[index];
          const inputId = `${field}-${index}`;
          const errorId = `${inputId}-error`;
          return (
            <div className="selector-row" key={inputId}>
              <label htmlFor={inputId}>
                <span>
                  {inputLabel} {index + 1}
                </span>
                <input
                  id={inputId}
                  value={value}
                  onChange={(event) => onChange(field, index, event.target.value)}
                  placeholder={placeholder}
                  aria-invalid={error === undefined ? undefined : true}
                  aria-describedby={error === undefined ? undefined : errorId}
                />
                {error === undefined ? null : (
                  <small className="field-error" id={errorId}>
                    {error}
                  </small>
                )}
              </label>
              {canRemove(values) ? (
                <button
                  className="selector-remove"
                  type="button"
                  onClick={() => onRemove(field, index)}
                  aria-label={`Удалить: ${inputLabel} ${index + 1}`}
                >
                  Удалить
                </button>
              ) : null}
            </div>
          );
        })}
      </div>
      <button className="selector-add" type="button" onClick={onAdd}>
        {addLabel}
      </button>
    </fieldset>
  );
}

function isPreviewResponse(
  value: PreviewResponse | ApiErrorBody,
): value is PreviewResponse {
  return (
    "finalUrl" in value &&
    typeof value.finalUrl === "string" &&
    "targetMatches" in value &&
    Array.isArray(value.targetMatches) &&
    "exclusionSelectors" in value &&
    Array.isArray(value.exclusionSelectors) &&
    "targetCount" in value &&
    typeof value.targetCount === "number" &&
    "targets" in value &&
    Array.isArray(value.targets)
  );
}

function validateSelectorSyntax(selector: string): string | undefined {
  try {
    document.querySelector(selector);
  } catch {
    return "CSS-селектор имеет неверный синтаксис.";
  }
  return undefined;
}
