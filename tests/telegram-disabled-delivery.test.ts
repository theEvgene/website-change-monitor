import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import BetterSqlite3 from "better-sqlite3";

import { openApplicationDatabase } from "../src/server/persistence/database.js";

describe("disabled Telegram deliveries", () => {
  it("terminally disables current pending work and records new events as disabled", async () => {
    const root = await mkdtemp(join(tmpdir(), "wcm-disabled-telegram-"));
    const database = openApplicationDatabase({ rootDirectory: root });
    const now = "2026-07-18T08:00:00.000Z";
    try {
      database.monitors.beginTelegramSession("current-boot", true, now);
      seedChange(database, "Pending", true, now);
      expect(database.monitors.listNotifications().items[0]!.telegram).toEqual({
        state: "pending",
        failureReason: null,
      });

      database.monitors.disablePendingTelegramDeliveries("2026-07-18T08:01:00.000Z");
      expect(database.monitors.listNotifications().items[0]!.telegram).toEqual({
        state: "disabled",
        failureReason: null,
      });
      expect(database.monitors.claimTelegramDelivery("current-boot", now)).toBeUndefined();

      seedChange(database, "Already disabled", false, now);
      expect(database.monitors.listNotifications().items.at(-1)!.telegram).toEqual({
        state: "disabled",
        failureReason: null,
      });
    } finally {
      database.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("leaves sending and completed deliveries unchanged", async () => {
    const root = await mkdtemp(join(tmpdir(), "wcm-disabled-outcomes-"));
    const database = openApplicationDatabase({ rootDirectory: root });
    const now = "2026-07-18T08:00:00.000Z";
    try {
      database.monitors.beginTelegramSession("current-boot", true, now);
      seedChange(database, "Delivered", true, now);
      const delivered = database.monitors.claimTelegramDelivery("current-boot", now)!;
      database.monitors.finishTelegramDelivery(delivered.deliveryId, "delivered", null, null, now);

      seedChange(database, "Sending", true, now);
      database.monitors.claimTelegramDelivery("current-boot", now);
      seedChange(database, "Pending", true, now);

      database.monitors.disablePendingTelegramDeliveries("2026-07-18T08:01:00.000Z");
      expect(database.monitors.listNotifications().items.map((event) => event.telegram.state)).toEqual([
        "delivered",
        "sending",
        "disabled",
      ]);
    } finally {
      database.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not disable pending work owned by another boot", async () => {
    const root = await mkdtemp(join(tmpdir(), "wcm-disabled-other-boot-"));
    const database = openApplicationDatabase({ rootDirectory: root });
    const now = "2026-07-18T08:00:00.000Z";
    try {
      database.monitors.beginTelegramSession("current-boot", true, now);
      seedChange(database, "Other boot", true, now);
      const inspection = new BetterSqlite3(database.path);
      try {
        inspection.prepare("UPDATE notification_deliveries SET boot_id = 'other-boot'").run();
      } finally {
        inspection.close();
      }
      seedChange(database, "Current boot", true, now);

      database.monitors.disablePendingTelegramDeliveries("2026-07-18T08:01:00.000Z");
      expect(database.monitors.listNotifications().items.map((event) => event.telegram.state)).toEqual([
        "pending",
        "disabled",
      ]);
    } finally {
      database.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps a final error internally while Telegram is disabled", async () => {
    const root = await mkdtemp(join(tmpdir(), "wcm-disabled-final-error-"));
    const database = openApplicationDatabase({ rootDirectory: root });
    const now = "2026-07-18T08:00:00.000Z";
    try {
      database.monitors.createMonitor({
        name: "Failure",
        url: "https://example.com",
        targetSelectors: ["body"],
        exclusionSelectors: [],
        intervalHours: 6,
      }, now);
      const first = database.monitors.claimNextCheck(now)!;
      database.monitors.failCheck(
        first,
        { code: "page_failed", message: "Failed" },
        now,
        "2026-07-18T14:00:00.000Z",
        { telegramEnabled: false, notifyWhenUnchanged: false },
      );
      const retryAt = "2026-07-18T08:01:00.000Z";
      const retry = database.monitors.claimNextCheck(retryAt)!;
      database.monitors.failCheck(
        retry,
        { code: "page_failed", message: "Failed again" },
        retryAt,
        "2026-07-18T14:01:00.000Z",
        { telegramEnabled: false, notifyWhenUnchanged: false },
      );
      expect(database.monitors.listNotifications().items[0]).toMatchObject({
        kind: "check_failed_final",
        telegram: { state: "disabled", failureReason: null },
      });
    } finally {
      database.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});

function seedChange(
  database: ReturnType<typeof openApplicationDatabase>,
  name: string,
  telegramEnabled: boolean,
  now: string,
): void {
  const monitorId = database.monitors.createMonitor({
    name,
    url: "https://example.com",
    targetSelectors: ["body"],
    exclusionSelectors: [],
    intervalHours: 6,
  }, now);
  const baseline = database.monitors.claimNextCheck(now)!;
  database.monitors.completeBaseline(
    baseline,
    { formatVersion: 1, sha256: "a".repeat(64), canonicalJson: '{"formatVersion":1,"targets":[]}' },
    now,
    "2026-07-18T14:00:00.000Z",
  );
  database.monitors.enqueueManualCheck(monitorId, now);
  database.monitors.completeChange(
    database.monitors.claimNextCheck(now)!,
    { formatVersion: 1, sha256: "b".repeat(64), canonicalJson: '{"formatVersion":1,"targets":[{"visibleText":"changed"}]}' },
    now,
    "2026-07-18T14:00:00.000Z",
    { telegramEnabled, notifyWhenUnchanged: false },
  );
}
