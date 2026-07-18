import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";

import type { MonitorStore, TelegramDeliveryJob } from "../persistence/monitor-store.js";

export interface TelegramChannelState { status: "available" | "unavailable"; reason: string | null }
export interface TelegramDispatcher {
  initialize(): Promise<void>; recheck(): Promise<TelegramChannelState>;
  ensureAvailable(): Promise<boolean>; drain(): Promise<void>; stop(timeoutMs?: number): Promise<void>;
  state(): TelegramChannelState;
}

export async function inspectTelegramExecutable(
  executablePath: string | null,
  options: { deadlineMs?: number; argsPrefix?: string[]; environment?: NodeJS.ProcessEnv } = {},
): Promise<TelegramChannelState> {
  if (executablePath === null || !isAbsolute(executablePath) || !existsSync(executablePath)) {
    return { status: "unavailable", reason: "Исполняемый файл Telegram не настроен или недоступен." };
  }
  const result = await runProcess(
    executablePath,
    [...(options.argsPrefix ?? []), "show-config"],
    undefined,
    options.deadlineMs ?? 10_000,
    options.environment,
  );
  return result.kind === "exit" && result.code === 0
    ? { status: "available", reason: null }
    : { status: "unavailable", reason: availabilityReason(result) };
}

export function createTelegramDispatcher(options: {
  store: MonitorStore; executablePath: string | null | (() => string | null); deadlineMs?: number;
  availabilityDeadlineMs?: number; now?: () => Date; argsPrefix?: string[]; environment?: NodeJS.ProcessEnv;
}): TelegramDispatcher {
  const bootId = randomUUID(); const now = options.now ?? (() => new Date());
  const dispatchAbort = new AbortController();
  const executablePath = () => typeof options.executablePath === "function" ? options.executablePath() : options.executablePath;
  let channelState: TelegramChannelState = { status: "unavailable", reason: "Telegram не настроен." };
  let dispatchTail = Promise.resolve(); let stopping = false;
  async function inspectAvailability(): Promise<TelegramChannelState> {
    return inspectTelegramExecutable(executablePath(), {
      ...(options.availabilityDeadlineMs === undefined ? {} : { deadlineMs: options.availabilityDeadlineMs }),
      ...(options.argsPrefix === undefined ? {} : { argsPrefix: options.argsPrefix }),
      ...(options.environment === undefined ? {} : { environment: options.environment }),
    });
  }
  async function drainOnce(): Promise<void> {
    if (stopping || channelState.status !== "available") return;
    for (;;) {
      const path = executablePath();
      if (path === null) return;
      const job = options.store.claimTelegramDelivery(bootId, now().toISOString());
      if (job === undefined) return;
      const result = await runProcess(path, [...(options.argsPrefix ?? []), "send"], JSON.stringify(payload(job)), options.deadlineMs ?? 70_000, options.environment, dispatchAbort.signal);
      if (result.kind === "aborted") return;
      const outcome = deliveryOutcome(result);
      options.store.finishTelegramDelivery(job.deliveryId, outcome.state, outcome.reason, result.diagnostic, now().toISOString());
      if (result.kind === "spawn" || (result.kind === "exit" && result.code === 3)) {
        channelState = { status: "unavailable", reason: "Telegram sender не настроен или недоступен." };
        options.store.setTelegramAvailable(false, now().toISOString());
        return;
      }
    }
  }
  return {
    async initialize() { channelState = await inspectAvailability(); options.store.beginTelegramSession(bootId, channelState.status === "available", now().toISOString()); },
    async recheck() { channelState = await inspectAvailability(); options.store.setTelegramAvailable(channelState.status === "available", now().toISOString()); return channelState; },
    async ensureAvailable() { if (channelState.status === "unavailable") await this.recheck(); return channelState.status === "available"; },
    drain() { const work = dispatchTail.then(drainOnce); dispatchTail = work.catch(() => undefined); return work; },
    async stop(timeoutMs = 8_000) {
      stopping = true;
      const timer = setTimeout(() => dispatchAbort.abort(), timeoutMs);
      try { await dispatchTail; } finally { clearTimeout(timer); }
      options.store.abandonTelegramSession(bootId, now().toISOString());
    },
    state: () => channelState,
  };
}

function payload(job: TelegramDeliveryJob) {
  return {
    monitor_id: truncate(job.monitorName.trim().normalize("NFC") || "monitor", 100),
    status: job.kind === "change_detected" ? "warning" : job.kind === "control_check_ok" ? "success" : "error",
    observed_at: job.observedAt,
    message: truncate(`${job.title}\nURL: ${safeUrl(job.url)}\n${job.body}`, 3_000),
  };
}
function safeUrl(value: string): string {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    return url.toString();
  } catch {
    return "некорректный URL";
  }
}
function truncate(value: string, maximum: number): string { const points = [...value]; return points.length <= maximum ? value : `${points.slice(0, maximum - 1).join("")}…`; }
type ProcessResult =
  | { kind: "exit"; code: number; diagnostic: string | null }
  | { kind: "spawn"; diagnostic: null }
  | { kind: "timeout"; diagnostic: null }
  | { kind: "aborted"; diagnostic: null };
function runProcess(path: string, args: string[], stdin: string | undefined, deadlineMs: number, environment?: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<ProcessResult> {
  return new Promise((resolve) => {
    let settled = false;
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(path, args, { shell: false, windowsHide: true, env: { ...(environment ?? process.env), PYTHONUTF8: "1" }, stdio: ["pipe", "pipe", "pipe"] });
    } catch {
      resolve({ kind: "spawn", diagnostic: null });
      return;
    }
    let stdout = ""; let stderr = "";
    child.stdout?.setEncoding("utf8"); child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => { stdout = appendBounded(stdout, chunk, 4_096); });
    child.stderr?.on("data", (chunk: string) => { stderr = appendBounded(stderr, chunk, 4_096); });
    let timer: ReturnType<typeof setTimeout>;
    let abortProcess: (() => void) | undefined;
    const finish = (result: ProcessResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (abortProcess !== undefined) signal?.removeEventListener("abort", abortProcess);
      resolve(result);
    };
    timer = setTimeout(() => { child.kill(); finish({ kind: "timeout", diagnostic: null }); }, deadlineMs);
    abortProcess = () => { child.kill(); finish({ kind: "aborted", diagnostic: null }); };
    signal?.addEventListener("abort", abortProcess, { once: true });
    child.once("error", () => finish({ kind: "spawn", diagnostic: null }));
    child.once("close", (code) => finish({ kind: "exit", code: code ?? 10, diagnostic: safeDiagnostic(stdout, stderr) }));
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(stdin === undefined ? undefined : Buffer.from(stdin, "utf8"));
  });
}
function appendBounded(current: string, chunk: string, maximum: number): string {
  if ([...current].length >= maximum) return current;
  return [...`${current}${chunk}`].slice(0, maximum).join("");
}
function safeDiagnostic(stdout: string, stderr: string): string | null {
  const combined = [stdout.trim(), stderr.trim()].filter(Boolean).join(" | ")
    .replace(/\b\d{6,}:[A-Za-z0-9_-]{20,}\b/g, "[redacted-token]")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ");
  return combined === "" ? null : [...combined].slice(0, 4_096).join("");
}
function deliveryOutcome(result: ProcessResult): { state: "delivered" | "permanent" | "temporary" | "timeout"; reason: string | null } {
  if (result.kind === "aborted") return { state: "timeout", reason: "Отправка остановлена вместе с приложением." };
  if (result.kind === "timeout") return { state: "timeout", reason: "Превышено время отправки." };
  if (result.kind === "spawn") return { state: "temporary", reason: "Не удалось запустить Telegram sender." };
  if (result.code === 0) return { state: "delivered", reason: null };
  if ([2, 3, 4].includes(result.code)) return { state: "permanent", reason: "Telegram отклонил отправку." };
  return { state: "temporary", reason: "Telegram временно не доставил сообщение." };
}
function availabilityReason(result: ProcessResult): string {
  if (result.kind === "aborted") return "Проверка Telegram остановлена.";
  if (result.kind === "timeout") return "Проверка Telegram превысила время ожидания.";
  if (result.kind === "spawn") return "Не удалось запустить Telegram sender.";
  return "Telegram sender не настроен или недоступен.";
}
