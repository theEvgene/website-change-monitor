import { useEffect, useState } from "react";
import type { Observable } from "rxjs";

type RequestState<T> =
  | { kind: "loading" }
  | { kind: "success"; value: T }
  | { kind: "error" };

export function RequestWrapper<T>({
  request,
  errorMessage,
  loading,
  children,
  onSuccess,
}: {
  request: Observable<T>;
  errorMessage: string;
  loading?: React.ReactNode;
  children: (value: T) => React.ReactNode;
  onSuccess?: (value: T) => void;
}) {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<RequestState<T>>({ kind: "loading" });

  useEffect(() => {
    setState({ kind: "loading" });
    const subscription = request.subscribe({
      next: (value) => { onSuccess?.(value); setState({ kind: "success", value }); },
      error: () => setState({ kind: "error" }),
    });
    return () => subscription.unsubscribe();
  }, [request, attempt, onSuccess]);

  if (state.kind === "loading") {
    return <div className="request-loading" role="status">{loading ?? <span className="button-spinner" aria-label="Загрузка" />}</div>;
  }
  if (state.kind === "error") {
    return <div className="request-error" role="alert"><p>{errorMessage}</p><button className="secondary-button" type="button" onClick={() => setAttempt((value) => value + 1)}>Повторить</button></div>;
  }
  return <>{children(state.value)}</>;
}