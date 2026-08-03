// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ComparisonModal, type ComparisonResponse } from "../src/ui/ComparisonModal.js";

const response = (beforeSnapshotId: number, before: string, after = "Final"): ComparisonResponse => ({
  checkId: 22, monitorId: 7, monitorName: "Catalog",
  beforeSnapshotId, afterSnapshotId: 4,
  beforeCreatedAt: beforeSnapshotId === 3 ? "2026-07-17T09:00:01.000Z" : "2026-07-16T09:00:00.000Z",
  afterCreatedAt: "2026-07-17T10:00:00.000Z",
  eligibleBeforeSnapshots: [
    { id: 3, createdAt: "2026-07-17T09:00:01.000Z" },
    { id: 1, createdAt: "2026-07-16T09:00:00.000Z" },
  ],
  complete: true,
  targets: [{ kind: "replace", structure: [], text: [{ kind: "replace", before, after }] }],
});

describe("Observable comparison modal", () => {
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it("opens immediately, keeps controls available, and reloads an earlier state without Apply", async () => {
    let finish!: (value: Response) => void;
    const initial = new Promise<Response>((resolve) => { finish = resolve; });
    const fetchMock = vi.fn().mockReturnValueOnce(initial).mockResolvedValueOnce(Response.json(response(1, "Earlier")));
    vi.stubGlobal("fetch", fetchMock);
    render(<ComparisonModal checkId={22} onClose={vi.fn()} />);

    const dialog = screen.getByRole("dialog", { name: "Сравнение" });
    expect(within(dialog).getByRole("status")).toBeVisible();
    expect(within(dialog).getByRole("combobox", { name: "Прежнее состояние" })).toBeEnabled();
    expect(within(dialog).getByRole("button", { name: "Закрыть" })).toBeEnabled();
    finish(Response.json(response(3, "Adjacent")));
    expect(await within(dialog).findByText("Adjacent")).toBeVisible();

    fireEvent.change(within(dialog).getByRole("combobox", { name: "Прежнее состояние" }), { target: { value: "1" } });
    expect(within(dialog).getByRole("status")).toBeVisible();
    expect(await within(dialog).findByText("Earlier")).toBeVisible();
    expect(fetchMock).toHaveBeenLastCalledWith("/api/checks/22/comparison?initialSnapshotId=1", expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it("ignores a stale response when rapid selections race", async () => {
    const pending = new Map<string, (value: Response) => void>();
    vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string) => new Promise<Response>((resolve) => pending.set(url, resolve))));
    render(<ComparisonModal checkId={22} onClose={vi.fn()} />);
    pending.get("/api/checks/22/comparison")!(Response.json(response(3, "Adjacent")));
    const select = await screen.findByRole("combobox", { name: "Прежнее состояние" });
    await screen.findByText("Adjacent");
    fireEvent.change(select, { target: { value: "1" } });
    fireEvent.change(select, { target: { value: "3" } });
    pending.get("/api/checks/22/comparison?initialSnapshotId=3")!(Response.json(response(3, "Newest")));
    expect(await screen.findByText("Newest")).toBeVisible();
    pending.get("/api/checks/22/comparison?initialSnapshotId=1")!(Response.json(response(1, "Stale")));
    await waitFor(() => expect(screen.queryByText("Stale")).not.toBeInTheDocument());
  });

  it("shows a static error, retries the same pair, and unsubscribes on close", async () => {
    const signals: AbortSignal[] = [];
    const fetchMock = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      signals.push(init.signal as AbortSignal);
      return fetchMock.mock.calls.length === 1 ? Promise.resolve(new Response(null, { status: 500 })) : Promise.resolve(Response.json(response(3, "Recovered")));
    });
    vi.stubGlobal("fetch", fetchMock);
    const onClose = vi.fn();
    const view = render(<ComparisonModal checkId={22} onClose={onClose} />);
    expect(await screen.findByText("Не удалось загрузить сравнение")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Повторить" }));
    expect(await screen.findByText("Recovered")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Закрыть" }));
    expect(onClose).toHaveBeenCalledOnce();
    view.unmount();
    expect(signals.at(-1)?.aborted).toBe(true);
  });

  it("formats Moscow labels with conditional years and collision seconds", async () => {
    const dated = response(3, "Adjacent");
    dated.afterCreatedAt = "2026-01-02T00:00:00.000Z";
    dated.eligibleBeforeSnapshots = [
      { id: 3, createdAt: "2026-01-01T21:00:01.000Z" },
      { id: 2, createdAt: "2026-01-01T21:00:02.000Z" },
      { id: 1, createdAt: "2025-12-30T21:00:00.000Z" },
    ];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(dated)));
    render(<ComparisonModal checkId={22} onClose={vi.fn()} />);
    const select = await screen.findByRole("combobox", { name: "Прежнее состояние" });
    const labels = within(select).getAllByRole("option").map((option) => option.textContent ?? "");
    expect(labels[0]).toMatch(/00:00:01/u);
    expect(labels[1]).toMatch(/00:00:02/u);
    expect(labels[2]).toContain("2025");
  });
});