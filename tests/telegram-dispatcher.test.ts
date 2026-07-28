import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import BetterSqlite3 from "better-sqlite3";

import { createTelegramDispatcher } from "../src/server/notifications/telegram-dispatcher.js";
import type { NdjsonLogger } from "../src/server/operations/logger.js";
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
    expect(captured.payload).toMatchObject({
      monitor_id: "Каталог",
      status: "warning",
      message: expect.stringContaining("➕ Добавлено:\n• New role"),
    });
    expect(captured.payload.message).toEqual(expect.stringContaining("➖ Удалено:\n• Old role"));
    expect(captured.payload.message).toEqual(expect.stringContaining("Ссылка: https://example.com/"));
    expect(captured.utf8).toBe("1");
  });

  it("limits the monitor id, preserves the source link, and strips URL credentials", async () => {
    const fixture = await setup({});
    const dispatcher = createTelegramDispatcher({ store: fixture.database.monitors, executablePath: process.execPath, argsPrefix: [fixture.script], environment: fixture.environment });
    await dispatcher.initialize(); seedChange(fixture.database, "😀".repeat(110), "https://user:secret@example.com/" + "x".repeat(3_100)); await dispatcher.drain();
    const captured = JSON.parse(await readFile(fixture.capture, "utf8")) as { payload: { monitor_id: string; message: string } };
    expect([...captured.payload.monitor_id]).toHaveLength(100);
    expect([...captured.payload.message].length).toBeGreaterThan(3_000);
    expect(captured.payload.message).toContain(`Ссылка: https://example.com/${"x".repeat(3_100)}`);
    expect(captured.payload.message).not.toContain("secret");
  });

  it("logs missing comparison data and delivers the prebuilt base alert", async () => {
    const fixture = await setup({});
    const dispatcher = createTelegramDispatcher({
      store: fixture.database.monitors,
      executablePath: process.execPath,
      argsPrefix: [fixture.script],
      environment: fixture.environment,
      logger: fixture.logger,
      now: fixture.now,
    });
    await dispatcher.initialize();
    seedChange(fixture.database, "Fallback");
    const stateBeforeFallback = fallbackDomainState(fixture.database);
    const inspection = new BetterSqlite3(fixture.database.path);
    try {
      inspection.pragma("foreign_keys = OFF");
      inspection.prepare("DELETE FROM snapshots WHERE id = (SELECT after_snapshot_id FROM checks WHERE result = 'change' LIMIT 1)").run();
    } finally {
      inspection.close();
    }

    await dispatcher.drain();

    const captured = JSON.parse(await readFile(fixture.capture, "utf8")) as { payload: { message: string } };
    expect(captured.payload.message).toContain("URL: https://example.com/");
    expect(captured.payload.message).not.toContain("Добавлено:");
    expect(fallbackDomainState(fixture.database)).toEqual(stateBeforeFallback);
    expect(fixture.database.monitors.listNotifications().items[0]!.telegram.state).toBe("delivered");
    expect(fixture.events).toEqual([{
      event: "telegram_change_details_failed",
      values: {
        deliveryId: expect.any(Number),
        checkId: expect.any(Number),
        stage: "comparison_data",
        errorName: "ComparisonDataUnavailable",
        errorMessage: "Change detail preparation failed.",
      },
    }]);
  });

  it("falls back at the comparison stage without logging Snapshot content", async () => {
    const fixture = await setup({});
    const dispatcher = createTelegramDispatcher({
      store: fixture.database.monitors,
      executablePath: process.execPath,
      argsPrefix: [fixture.script],
      environment: fixture.environment,
      logger: fixture.logger,
      now: fixture.now,
    });
    await dispatcher.initialize();
    seedChange(fixture.database, "Broken comparison");
    const stateBeforeFallback = fallbackDomainState(fixture.database);
    const inspection = new BetterSqlite3(fixture.database.path);
    try {
      inspection.prepare("UPDATE snapshots SET canonical_json = ? WHERE id = (SELECT after_snapshot_id FROM checks WHERE result = 'change' LIMIT 1)")
        .run(Buffer.from("private snapshot text", "utf8"));
    } finally {
      inspection.close();
    }

    await dispatcher.drain();

    await expectBaseFallback(fixture, stateBeforeFallback);
    expect(fixture.events[0]).toMatchObject({
      event: "telegram_change_details_failed",
      values: {
        stage: "comparison",
        errorName: expect.any(String),
        errorMessage: "Change detail preparation failed.",
      },
    });
    expect(JSON.stringify(fixture.events)).not.toContain("private snapshot text");
  });

  it.each(["projection", "formatting"] as const)(
    "falls back when %s fails",
    async (stage) => {
      const fixture = await setup({});
      const dispatcher = createTelegramDispatcher({
        store: fixture.database.monitors,
        executablePath: process.execPath,
        argsPrefix: [fixture.script],
        environment: fixture.environment,
        logger: fixture.logger,
        now: fixture.now,
        detailPreparation: stage === "projection"
          ? { project() { throw new TypeError("private fragment https://secret.example"); } }
          : { format() { throw new RangeError("private final message"); } },
      });
      await dispatcher.initialize();
      seedChange(fixture.database, `Broken ${stage}`);
      const stateBeforeFallback = fallbackDomainState(fixture.database);

      await dispatcher.drain();

      await expectBaseFallback(fixture, stateBeforeFallback);
      expect(fixture.events[0]).toMatchObject({
        event: "telegram_change_details_failed",
        values: {
          stage,
          errorName: stage === "projection" ? "TypeError" : "RangeError",
          errorMessage: "Change detail preparation failed.",
        },
      });
      expect(JSON.stringify(fixture.events)).not.toMatch(/private|https:/u);
    },
  );

  it("delivers the base alert even when failure logging throws", async () => {
    const fixture = await setup({});
    const dispatcher = createTelegramDispatcher({
      store: fixture.database.monitors,
      executablePath: process.execPath,
      argsPrefix: [fixture.script],
      environment: fixture.environment,
      logger: { write() { throw new Error("logger unavailable"); } },
      now: fixture.now,
      detailPreparation: { format() { throw new Error("formatting failed"); } },
    });
    await dispatcher.initialize();
    seedChange(fixture.database, "Logger failure");
    const stateBeforeFallback = fallbackDomainState(fixture.database);

    await dispatcher.drain();

    await expectBaseFallback(fixture, stateBeforeFallback);
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

  it("maps a control notification to the Telegram success status", async () => {
    const fixture = await setup({});
    const dispatcher = createTelegramDispatcher({ store: fixture.database.monitors, executablePath: process.execPath, argsPrefix: [fixture.script], environment: fixture.environment });
    await dispatcher.initialize(); seedControl(fixture.database); await dispatcher.drain();
    const captured = JSON.parse(await readFile(fixture.capture, "utf8")) as { payload: { status: string } };
    expect(captured.payload.status).toBe("success");
    expect(fixture.database.monitors.listNotifications().items).toEqual([]);
    expect(fixture.database.monitors.listLiveNotifications().items[0]).toMatchObject({ kind: "control_check_ok", centerVisible: false, telegram: { state: "delivered" } });
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
    const events: Array<{ event: string; values?: Record<string, unknown> }> = [];
    const logger: NdjsonLogger = { write(event, values) { events.push({ event, ...(values === undefined ? {} : { values }) }); } };
    const now = () => new Date("2026-07-18T08:00:00.000Z");
    return { root, capture, script, database, environment: { ...process.env, FAKE_CAPTURE: capture, ...extra }, events, logger, now };
  }
});

async function expectBaseFallback(fixture: {
  capture: string;
  database: ApplicationDatabase;
}, stateBeforeFallback: ReturnType<typeof fallbackDomainState>): Promise<void> {
  const captured = JSON.parse(await readFile(fixture.capture, "utf8")) as { payload: { message: string } };
  expect(captured.payload.message).toContain("URL: https://example.com/");
  expect(captured.payload.message).not.toContain("Добавлено:");
  expect(captured.payload.message).not.toContain("Удалено:");
  expect(fallbackDomainState(fixture.database)).toEqual(stateBeforeFallback);
  expect(fixture.database.monitors.listNotifications().items[0]!.telegram.state).toBe("delivered");
}

function fallbackDomainState(database: ApplicationDatabase) {
  const event = database.monitors.listNotifications().items[0]!;
  const { telegram: _telegram, ...notification } = event;
  const check = database.monitors.getMonitor(event.monitorId)!.history
    .find((candidate) => candidate.id === event.checkId)!;
  return {
    notification,
    check: {
      status: check.status,
      result: check.result,
      beforeSnapshotId: check.beforeSnapshotId,
      afterSnapshotId: check.afterSnapshotId,
    },
  };
}

function seedChange(database: ApplicationDatabase, name: string, url = "https://example.com"): void {
  const now = "2026-07-18T08:00:00.000Z";
  const id = database.monitors.createMonitor({ name, url, targetSelectors: ["body"], exclusionSelectors: [], intervalHours: 6 }, now);
  const baseline = database.monitors.claimNextCheck(now)!;
  database.monitors.completeBaseline(baseline, { formatVersion: 1, sha256: "a".repeat(64), canonicalJson: snapshotJson("Old role") }, now, "2026-07-18T14:00:00.000Z");
  database.monitors.enqueueManualCheck(id, now);
  const changed = database.monitors.claimNextCheck(now)!;
  database.monitors.completeChange(changed, { formatVersion: 1, sha256: "b".repeat(64), canonicalJson: snapshotJson("New role") }, now, "2026-07-18T14:00:00.000Z");
}

function seedControl(database: ApplicationDatabase): void {
  const now = "2026-07-18T08:00:00.000Z";
  const id = database.monitors.createMonitor({ name: "Catalog", url: "https://example.com", targetSelectors: ["body"], exclusionSelectors: [], intervalHours: 6 }, now);
  const baseline = database.monitors.claimNextCheck(now)!;
  database.monitors.completeBaseline(baseline, { formatVersion: 1, sha256: "a".repeat(64), canonicalJson: '{"a":1}' }, now, "2026-07-18T14:00:00.000Z");
  database.monitors.enqueueManualCheck(id, now);
  database.monitors.completeNoChange(
    database.monitors.claimNextCheck(now)!,
    now,
    "2026-07-18T14:00:00.000Z",
    { telegramEnabled: true, notifyWhenUnchanged: true },
  );
}

function snapshotJson(visibleText: string): string {
  return JSON.stringify({
    formatVersion: 1,
    targets: [{
      elements: [{ namespace: "http://www.w3.org/1999/xhtml", name: "div", childElementCount: 0 }],
      visibleText,
    }],
  });
}
