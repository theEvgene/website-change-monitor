import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  openApplicationDatabase,
  type ApplicationDatabase,
} from "../src/server/persistence/database.js";

describe("application database", () => {
  const roots: string[] = [];
  const databases: ApplicationDatabase[] = [];

  afterEach(async () => {
    for (const database of databases.splice(0)) {
      database.close();
    }
    for (const root of roots.splice(0)) {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("opens a migrated SQLite database with the required durability settings", async () => {
    const root = await mkdtemp(join(tmpdir(), "website-change-monitor-"));
    roots.push(root);

    const database = openApplicationDatabase({ rootDirectory: root });
    databases.push(database);

    expect(database.path.startsWith(root)).toBe(true);
    expect(database.diagnostics()).toEqual({
      status: "ready",
      schemaVersion: 3,
      journalMode: "wal",
      foreignKeys: true,
      synchronous: "full",
      busyTimeoutMs: 5000,
    });
  });
});
