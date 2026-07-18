import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

const maxBytes = 10 * 1024 * 1024;
const generations = 20;
const sensitiveKey = /authorization|cookie|credential|password|secret|stdin|token/iu;
const urlCredentials = /([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+(?::[^\s/@]*)?@/giu;
const bearer = /\b(Bearer\s+)[A-Za-z0-9._~+\/-]+=*/giu;
const telegramToken = /\b\d{6,}:[A-Za-z0-9_-]{20,}\b/gu;

export interface NdjsonLogger {
  write(event: string, values?: Record<string, unknown>): void;
}

export function createNdjsonLogger(logDirectory: string): NdjsonLogger {
  mkdirSync(logDirectory, { recursive: true });
  const file = join(logDirectory, "application.ndjson");
  return {
    write(event, values = {}) {
      const line = `${JSON.stringify(redact({ timestamp: new Date().toISOString(), event, ...values }))}\n`;
      rotate(file, Buffer.byteLength(line));
      appendFileSync(file, line, { encoding: "utf8", mode: 0o600 });
    },
  };
}

export function redact(value: unknown, key = ""): unknown {
  if (sensitiveKey.test(key)) return "[REDACTED]";
  if (typeof value === "string") {
    return value
      .replace(urlCredentials, "$1[REDACTED]@")
      .replace(bearer, "$1[REDACTED]")
      .replace(telegramToken, "[REDACTED]");
  }
  if (Array.isArray(value)) return value.map((item) => redact(item));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, redact(child, childKey)]));
  }
  return value;
}

function rotate(file: string, incomingBytes: number): void {
  if (!existsSync(file) || statSync(file).size + incomingBytes <= maxBytes) return;
  rmSync(`${file}.${generations}`, { force: true });
  for (let generation = generations - 1; generation >= 1; generation -= 1) {
    const source = `${file}.${generation}`;
    if (existsSync(source)) renameSync(source, `${file}.${generation + 1}`);
  }
  renameSync(file, `${file}.1`);
}
