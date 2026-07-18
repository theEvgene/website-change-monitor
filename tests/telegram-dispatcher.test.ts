import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import BetterSqlite3 from "better-sqlite3";

import { createTelegramDispatcher } from "../src/server/notifications/telegram-dispatcher.js";
import { openApplicationDatabase, type ApplicationDatabase } from "../src/server/persistence/database.js";

describe("Telegram dispatcher", () => {
  const roots: string[] = []; const databases: ApplicationDatabase[] = [];
  afterEach(async () => { for (const database of databases.splice(0)) database.close(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

  it.each([[0, "delivered"], [4, "permanent"], [5, "temporary"], [10, "temporary"]] as const)("maps sender exit %i to %s and sends strict UTF-8 JSON", async (exitCode, state) => {
    const fixture = await setup({ FAKE_EXIT: String(exitCode) });
    const dispatcher = createTelegramDispatcher({ store: fixture.database.monitors, executablePath: process.execPath, argsPrefix: [fixture.script], environment: fixture.environment });
    await dispatcher.initialize(); seedChange(fixture.database, "Каталог");
    expect(fixture.database.monitors.listNotifications().items[0]!.telegram.state).toBe("pending");
    await dispatcher.drain();
    const event = fixture.database.monitors.listNotifications().items[0]!;
    expect(event.telegram.state).toBe(state);
    const captured = JSON.parse(await readFile(fixture.capture, "utf8")) as { payload: Record<string, unknown>; utf8: string };
    expect(Object.keys(captured.payload).sort()).toEqual(["message", "monitor_id", "observed_at", "status"]);
    expect(captured.payload).toMatchObject({ monitor_id: "Каталог", status: "warning", message: expect.stringContaining("URL: https://example.com") });
    expect(captured.utf8).toBe("1");
  });

  it("limits user-controlled fields by code point and strips URL credentials", async () => {
    const fixture = await setup({});
    const dispatcher = createTelegramDispatcher({ store: fixture.database.monitors, executablePath: process.execPath, argsPrefix: [fixture.script], environment: fixture.environment });
    await dispatcher.initialize(); seedChange(fixture.database, "😀".repeat(110), "https://user:secret@example.com/" + "x".repeat(3_100)); await dispatcher.drain();
    const captured = JSON.parse(await readFile(fixture.capture, "utf8")) as { payload: { monitor_id: string; message: string } };
    expect([...captured.payload.monitor_id]).toHaveLength(100);
    expect([...captured.payload.message]).toHaveLength(3_000);
    expect(captured.payload.message).not.toContain("secret");
  });

  it("stores bounded diagnostics with Telegram tokens redacted", async () => {
    const token = `123456789:${"a".repeat(30)}`;
    const fixture = await setup({ FAKE_EXIT: "4", FAKE_STDERR: `failed ${token}` });
    const dispatcher = createTelegramDispatcher({ store: fixture.database.monitors, executablePath: process.execPath, argsPrefix: [fixture.script], environment: fixture.environment });
    await dispatcher.initialize(); seedChange(fixture.database, "Diagnostics"); await dispatcher.drain();
    const inspection = new BetterSqlite3(fixture.database.path, { readonly: true });
    try {
      const row = inspection.prepare("SELECT diagnostic FROM notification_deliveries").get() as { diagnostic: string };
      expect(row.diagnostic).toContain("[redacted-token]");
      expect(row.diagnostic).not.toContain(token);
      expect([...row.diagnostic].length).toBeLessThanOrEqual(4_096);
    } finally { inspection.close(); }
  });

  it("times out one sender and never retries it", async () => {
    const fixture = await setup({ FAKE_DELAY: "100" });
    const dispatcher = createTelegramDispatcher({ store: fixture.database.monitors, executablePath: process.execPath, argsPrefix: [fixture.script], environment: fixture.environment, deadlineMs: 10 });
    await dispatcher.initialize(); seedChange(fixture.database, "Slow"); await dispatcher.drain(); await dispatcher.drain();
    expect(fixture.database.monitors.listNotifications().items[0]!.telegram.state).toBe("timeout");
  });

  it("does not resend old unavailable delivery after recovery and abandons old pending on restart", async () => {
    const fixture = await setup({ FAKE_AVAILABLE: "0" });
    const first = createTelegramDispatcher({ store: fixture.database.monitors, executablePath: process.execPath, argsPrefix: [fixture.script], environment: fixture.environment });
    await first.initialize(); seedChange(fixture.database, "Old");
    fixture.environment.FAKE_AVAILABLE = "1"; await first.recheck(); seedChange(fixture.database, "New"); await first.drain();
    expect(fixture.database.monitors.listNotifications().items.map((event) => event.telegram.state)).toEqual(["unavailable", "delivered"]);

    fixture.database.monitors.setTelegramAvailable(true, "2026-07-18T08:00:01.000Z"); seedChange(fixture.database, "Pending");
    const second = createTelegramDispatcher({ store: fixture.database.monitors, executablePath: process.execPath, argsPrefix: [fixture.script], environment: fixture.environment });
    await second.initialize();
    expect(fixture.database.monitors.listNotifications().items.at(-1)!.telegram.state).toBe("abandoned");
  });

  it("picks up a newly configured executable and marks broken configuration unavailable", async () => {
    const fixture = await setup({ FAKE_EXIT: "3" });
    let executable: string | null = null;
    const dispatcher = createTelegramDispatcher({ store: fixture.database.monitors, executablePath: () => executable, argsPrefix: [fixture.script], environment: fixture.environment });
    await dispatcher.initialize();
    executable = process.execPath;
    expect((await dispatcher.recheck()).status).toBe("available");
    seedChange(fixture.database, "Broken config");
    seedChange(fixture.database, "Already pending");
    await dispatcher.drain();
    expect(dispatcher.state().status).toBe("unavailable");
    expect(fixture.database.monitors.listNotifications().items.map((event) => event.telegram.state)).toEqual(["permanent", "unavailable"]);
    fixture.environment.FAKE_EXIT = "0";
    await dispatcher.recheck(); await dispatcher.drain();
    expect(fixture.database.monitors.listNotifications().items[1]!.telegram.state).toBe("unavailable");
    seedChange(fixture.database, "After failure");
    await dispatcher.drain();
    expect(fixture.database.monitors.listNotifications().items.at(-1)!.telegram.state).toBe("delivered");
  });

  it("abandons an active delivery within the shutdown deadline", async () => {
    const fixture = await setup({ FAKE_DELAY: "1000" });
    const dispatcher = createTelegramDispatcher({ store: fixture.database.monitors, executablePath: process.execPath, argsPrefix: [fixture.script], environment: fixture.environment });
    await dispatcher.initialize(); seedChange(fixture.database, "Shutdown");
    const draining = dispatcher.drain();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await dispatcher.stop(10);
    await draining;
    expect(fixture.database.monitors.listNotifications().items[0]!.telegram.state).toBe("abandoned");
  });

  async function setup(extra: NodeJS.ProcessEnv) {
    const root = await mkdtemp(join(tmpdir(), "wcm telegram кириллица ")); roots.push(root);
    const capture = join(root, "capture.json"); const script = join(root, "fake-sender.mjs");
    await writeFile(script, `import fs from 'node:fs'; const command=process.argv[2]; if(command==='show-config') process.exit(process.env.FAKE_AVAILABLE==='0'?3:0); let input=''; process.stdin.setEncoding('utf8'); process.stdin.on('data',c=>input+=c); process.stdin.on('end',()=>setTimeout(()=>{fs.writeFileSync(process.env.FAKE_CAPTURE,JSON.stringify({payload:JSON.parse(input),utf8:process.env.PYTHONUTF8}));if(process.env.FAKE_STDERR)process.stderr.write(process.env.FAKE_STDERR);process.exit(Number(process.env.FAKE_EXIT||0));},Number(process.env.FAKE_DELAY||0)));`, "utf8");
    const database = openApplicationDatabase({ rootDirectory: root }); databases.push(database);
    return { root, capture, script, database, environment: { ...process.env, FAKE_CAPTURE: capture, ...extra } };
  }
});

function seedChange(database: ApplicationDatabase, name: string, url = "https://example.com"): void {
  const now = "2026-07-18T08:00:00.000Z";
  const id = database.monitors.createMonitor({ name, url, targetSelectors: ["body"], exclusionSelectors: [], intervalHours: 6 }, now);
  const baseline = database.monitors.claimNextCheck(now)!;
  database.monitors.completeBaseline(baseline, { formatVersion: 1, sha256: "a".repeat(64), canonicalJson: '{"a":1}' }, now, "2026-07-18T14:00:00.000Z");
  database.monitors.enqueueManualCheck(id, now);
  const changed = database.monitors.claimNextCheck(now)!;
  database.monitors.completeChange(changed, { formatVersion: 1, sha256: "b".repeat(64), canonicalJson: '{"a":2}' }, now, "2026-07-18T14:00:00.000Z");
}
