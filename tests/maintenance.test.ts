import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { redact } from "../src/server/operations/logger.js";
import { openApplicationDatabase } from "../src/server/persistence/database.js";
import { createManualBackup, restoreManualBackup, verifyDatabaseFile } from "../src/server/persistence/maintenance.js";

describe("Windows data maintenance", () => {
  it("backs up and restores a database under a Unicode path without overwriting", async () => {
    const parent = await mkdtemp(join(tmpdir(), "wcm-путь с пробелами-"));
    const root = join(parent, "Website Change Monitor");
    try {
      const database = openApplicationDatabase({ rootDirectory: root });
      database.configureTelegramExecutable("C:\\Telegram\\first.exe");
      database.close();
      const backup = await createManualBackup(root, "ручная копия.sqlite3");
      await expect(createManualBackup(root, "ручная копия.sqlite3")).rejects.toThrow("уже существует");
      const changed = openApplicationDatabase({ rootDirectory: root });
      changed.configureTelegramExecutable("C:\\Telegram\\second.exe");
      changed.close();
      restoreManualBackup(root, backup);
      const restored = openApplicationDatabase({ rootDirectory: root });
      expect(restored.telegramExecutablePath()).toBe("C:\\Telegram\\first.exe");
      restored.close();
      expect(verifyDatabaseFile(backup)).toEqual({ quickCheck: "ok", foreignKeyViolations: 0 });
    } finally { await rm(parent, { recursive: true, force: true }); }
  });

  it("rejects a damaged restore source and keeps the primary database", async () => {
    const root = await mkdtemp(join(tmpdir(), "wcm-maintenance-"));
    try {
      const database = openApplicationDatabase({ rootDirectory: root });
      database.configureTelegramExecutable("C:\\Telegram\\safe.exe");
      database.close();
      const damaged = join(root, "damaged.sqlite3");
      await writeFile(damaged, "not sqlite", "utf8");
      expect(() => restoreManualBackup(root, damaged)).toThrow();
      const intact = openApplicationDatabase({ rootDirectory: root });
      expect(intact.telegramExecutablePath()).toBe("C:\\Telegram\\safe.exe");
      intact.close();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("puts the original database back when post-swap verification fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "wcm-restore-rollback-"));
    try {
      const original = openApplicationDatabase({ rootDirectory: root });
      original.configureTelegramExecutable("C:\\Telegram\\original.exe");
      original.close();
      const backup = await createManualBackup(root, "rollback.sqlite3");
      const changed = openApplicationDatabase({ rootDirectory: root });
      changed.configureTelegramExecutable("C:\\Telegram\\current.exe");
      changed.close();
      let calls = 0;
      expect(() => restoreManualBackup(root, backup, {
        verify(path) {
          calls += 1;
          if (calls === 3) throw new Error("post-swap failure");
          return verifyDatabaseFile(path);
        },
      })).toThrow("post-swap failure");
      const intact = openApplicationDatabase({ rootDirectory: root });
      expect(intact.telegramExecutablePath()).toBe("C:\\Telegram\\current.exe");
      intact.close();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("redacts secrets and URL credentials from structured logs", () => {
    expect(redact({
      url: "https://alice:password@example.com/page",
      authorization: "Bearer visible",
      message: "token 123456789:abcdefghijklmnopqrstuvwxyzABCDE",
      stdin: "private input",
    })).toEqual({
      url: "https://[REDACTED]@example.com/page",
      authorization: "[REDACTED]",
      message: "token [REDACTED]",
      stdin: "[REDACTED]",
    });
  });
});
