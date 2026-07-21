import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import BetterSqlite3 from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import {
  openApplicationDatabase,
  type ApplicationDatabase,
} from "../src/server/persistence/database.js";

describe("durable Check scheduling", () => {
  const roots: string[] = [];
  const databases: ApplicationDatabase[] = [];

  afterEach(async () => {
    for (const database of databases.splice(0)) database.close();
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  });

  it("coalesces duplicate manual work without hiding an ordinary deadline", async () => {
    const { database } = await fixture();
    const monitorId = createMonitor(database, "Catalog");

    expect(database.monitors.enqueueManualCheck(monitorId, at(0))).toBe(true);
    expect(database.monitors.enqueueManualCheck(monitorId, at(0))).toBe(false);
    expect(database.monitors.listActiveIntents()).toEqual([
      expect.objectContaining({ monitorId, kind: "manual", state: "queued" }),
      expect.objectContaining({ monitorId, kind: "scheduled", state: "queued" }),
    ]);
  });

  it("prioritizes manual work but selects the oldest automatic work after three manuals", async () => {
    const { database } = await fixture();
    for (const name of ["A", "B", "C", "D"]) {
      const id = createMonitor(database, name);
      database.monitors.enqueueManualCheck(id, at(0));
    }

    const selectedKinds: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const claimed = database.monitors.claimNextCheck(at(0), false)!;
      selectedKinds.push(claimed.kind);
      database.monitors.failCheck(
        claimed, { code: "test", message: "test" }, at(index + 1), at(100 + index),
      );
    }
    const automatic = database.monitors.claimNextCheck(at(3), true)!;
    selectedKinds.push(automatic.kind);

    expect(selectedKinds).toEqual(["manual", "manual", "manual", "retry"]);
  });

  it("keeps the URL captured by a Check when the Monitor URL later changes", async () => {
    const { database } = await fixture();
    createMonitor(database, "Catalog");
    const claimed = database.monitors.claimNextCheck(at(0))!;

    const direct = new BetterSqlite3(database.path);
    try {
      direct.prepare("UPDATE monitors SET url = ? WHERE id = ?").run(
        "https://example.com/new-catalog",
        claimed.monitorId,
      );
    } finally {
      direct.close();
    }

    expect(database.monitors.listJournal()).toContainEqual(
      expect.objectContaining({
        id: claimed.checkId,
        url: "https://example.com/Catalog",
      }),
    );
  });

  async function fixture() {
    const root = await mkdtemp(join(tmpdir(), "website-change-monitor-schedule-"));
    roots.push(root);
    const database = openApplicationDatabase({ rootDirectory: root });
    databases.push(database);
    return { database };
  }
});

function createMonitor(database: ApplicationDatabase, name: string): number {
  return database.monitors.createMonitor({
    name, url: `https://example.com/${name}`,
    targetSelectors: ["main"], exclusionSelectors: [], intervalHours: 6,
  }, at(0));
}

function at(minute: number): string {
  return new Date(Date.UTC(2026, 6, 17, 8, minute)).toISOString();
}
