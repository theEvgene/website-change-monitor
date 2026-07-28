import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

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
