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
