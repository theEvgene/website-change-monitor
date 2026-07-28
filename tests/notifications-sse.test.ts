import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it, vi } from "vitest";

import type { PageProbe } from "../src/server/application/page-probe.js";
import { buildHttpServer } from "../src/server/http/server.js";
import { openApplicationDatabase } from "../src/server/persistence/database.js";
import { simplePagePreviewTargets, successfulPageProbeResult } from "./support/page-probe.js";

it("replays SSE after Last-Event-ID and gives that header priority over the query cursor", async () => {
  const root = await mkdtemp(join(tmpdir(), "website-change-monitor-sse-"));
  const database = openApplicationDatabase({ rootDirectory: root });
  const baseline = successfulPageProbeResult("https://example.com", [{ selector: "body", matchCount: 1 }], simplePagePreviewTargets("A"));
  const changed = successfulPageProbeResult("https://example.com", [{ selector: "body", matchCount: 1 }], simplePagePreviewTargets("B"));
  const preview = vi.fn<PageProbe["preview"]>().mockResolvedValueOnce(baseline).mockResolvedValueOnce(baseline).mockResolvedValueOnce(changed);
  const server = buildHttpServer({ database, version: "0.1.0", port: 43219, pageProbe: { preview } });
  try {
    await server.listen({ host: "127.0.0.1", port: 43219 });
    const created = await server.inject({ method: "POST", url: "/api/monitors", headers: { host: "127.0.0.1:43219" }, payload: { name: "Catalog", url: "https://example.com", targetSelectors: ["body"], exclusionSelectors: [], intervalHours: 6 } });
    const monitorId = created.json<{ id: number }>().id;
    await server.inject({ method: "POST", url: `/api/monitors/${monitorId}/checks`, headers: { host: "127.0.0.1:43219" } });

    const response = await fetch("http://127.0.0.1:43219/api/notifications/stream?after=999", { headers: { accept: "text/event-stream", "Last-Event-ID": "0" } });
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    const chunk = await reader.read();
    await reader.cancel();
    const text = new TextDecoder().decode(chunk.value);
    expect(text).toContain("event: replay");
    expect(text).toContain('"kind":"change_detected"');
    expect(text).not.toContain("event: reset");
  } finally {
    await server.close(); database.close(); await rm(root, { recursive: true, force: true });
  }
});

it("replays an event created with Telegram disabled as a neutral delivery", async () => {
  const root = await mkdtemp(join(tmpdir(), "website-change-monitor-disabled-sse-"));
  const database = openApplicationDatabase({ rootDirectory: root });
  const baseline = successfulPageProbeResult("https://example.com", [{ selector: "body", matchCount: 1 }], simplePagePreviewTargets("A"));
  const changed = successfulPageProbeResult("https://example.com", [{ selector: "body", matchCount: 1 }], simplePagePreviewTargets("B"));
  const preview = vi.fn<PageProbe["preview"]>().mockResolvedValueOnce(baseline).mockResolvedValueOnce(baseline).mockResolvedValueOnce(changed);
  const server = buildHttpServer({ database, version: "0.1.0", port: 43220, pageProbe: { preview } });
  const headers = { host: "127.0.0.1:43220" };
  try {
    await server.listen({ host: "127.0.0.1", port: 43220 });
    const created = await server.inject({
      method: "POST",
      url: "/api/monitors",
      headers,
      payload: { name: "Catalog", url: "https://example.com", targetSelectors: ["body"], exclusionSelectors: [], intervalHours: 6 },
    });
    const monitorId = created.json<{ id: number }>().id;
    await server.inject({
      method: "PUT",
      url: "/api/settings/notifications",
      headers,
      payload: { telegramEnabled: false },
    });
    await server.inject({ method: "POST", url: `/api/monitors/${monitorId}/checks`, headers });

    const response = await fetch("http://127.0.0.1:43220/api/notifications/stream?after=0", { headers: { accept: "text/event-stream" } });
    const reader = response.body!.getReader();
    const chunk = await reader.read();
    await reader.cancel();
    const text = new TextDecoder().decode(chunk.value);
    expect(text).toContain('"kind":"change_detected"');
    expect(text).toContain('"telegram":{"state":"disabled","failureReason":null}');
  } finally {
    await server.close(); database.close(); await rm(root, { recursive: true, force: true });
  }
});

it("publishes one delivery update when pending Telegram work is disabled", async () => {
  const root = await mkdtemp(join(tmpdir(), "website-change-monitor-disable-transition-sse-"));
  const database = openApplicationDatabase({ rootDirectory: root });
  const server = buildHttpServer({ database, version: "0.1.0", port: 43221 });
  const headers = { host: "127.0.0.1:43221" };
  try {
    await server.listen({ host: "127.0.0.1", port: 43221 });
    database.monitors.beginTelegramSession("held-for-sse", true, "2026-07-18T08:00:00.000Z");
    const now = "2026-07-18T08:00:00.000Z";
    const monitorId = database.monitors.createMonitor({
      name: "Catalog", url: "https://example.com", targetSelectors: ["body"], exclusionSelectors: [], intervalHours: 6,
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
      { telegramEnabled: true, notifyWhenUnchanged: false },
    );

    const response = await fetch("http://127.0.0.1:43221/api/notifications/stream?after=0", { headers: { accept: "text/event-stream" } });
    const reader = response.body!.getReader();
    const initial = new TextDecoder().decode((await reader.read()).value);
    expect(initial).toContain('"state":"pending"');

    await server.inject({
      method: "PUT", url: "/api/settings/notifications", headers,
      payload: { telegramEnabled: false },
    });
    let update = "";
    while (!update.includes("event: delivery")) {
      update += new TextDecoder().decode((await reader.read()).value);
    }
    await reader.cancel();
    expect(update.match(/event: delivery/gu)).toHaveLength(1);
    expect(update).toContain('"state":"disabled"');
  } finally {
    await server.close(); database.close(); await rm(root, { recursive: true, force: true });
  }
});
