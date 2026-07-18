import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { openApplicationDatabase } from "../src/server/persistence/database.js";

describe("control notifications", () => {
  it("uses the persisted commit-time setting, skips the Baseline, and exposes delivery only in Check history", async () => {
    const root = await mkdtemp(join(tmpdir(), "wcm-control-уведомления-"));
    let database = openApplicationDatabase({ rootDirectory: root });
    try {
      expect(database.monitors.notificationSettings()).toEqual({ notifyWhenUnchanged: false });
      const now = "2026-07-18T08:00:00.000Z";
      const monitorId = database.monitors.createMonitor({ name: "Catalog", url: "https://example.com", targetSelectors: ["body"], exclusionSelectors: [], intervalHours: 6 }, now);
      const baseline = database.monitors.claimNextCheck(now)!;
      database.monitors.updateNotificationSettings(true);
      database.monitors.completeBaseline(baseline, snapshot(), now, "2026-07-18T14:00:00.000Z");
      expect(database.monitors.listNotifications().items).toEqual([]);

      database.monitors.enqueueManualCheck(monitorId, now);
      const enabledAtCommit = database.monitors.claimNextCheck(now)!;
      database.monitors.completeNoChange(enabledAtCommit, now, "2026-07-18T14:00:00.000Z");
      expect(database.monitors.listNotifications().items).toEqual([]);
      expect(database.monitors.listLiveNotifications().items).toMatchObject([{
        kind: "control_check_ok", centerVisible: false, checkId: enabledAtCommit.checkId,
        telegram: { state: "unavailable" },
      }]);
      expect(database.monitors.getMonitor(monitorId)!.history[0]).toMatchObject({ result: "no_change", telegram: { state: "unavailable" } });
      expect(database.monitors.listJournal()[0]).toMatchObject({ id: enabledAtCommit.checkId, telegram: { state: "unavailable" } });

      database.monitors.enqueueManualCheck(monitorId, now);
      const disabledAtCommit = database.monitors.claimNextCheck(now)!;
      database.monitors.updateNotificationSettings(false);
      database.monitors.completeNoChange(disabledAtCommit, now, "2026-07-18T14:00:00.000Z");
      expect(database.monitors.listNotifications().items).toEqual([]);
      expect(database.monitors.listLiveNotifications().items).toHaveLength(1);

      database.close();
      database = openApplicationDatabase({ rootDirectory: root });
      expect(database.monitors.notificationSettings()).toEqual({ notifyWhenUnchanged: false });
    } finally {
      database.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});

function snapshot() {
  return { formatVersion: 1, sha256: "a".repeat(64), canonicalJson: '{"formatVersion":1,"targets":[]}' };
}
