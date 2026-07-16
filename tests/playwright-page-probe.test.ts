import { createSocket } from "node:dgram";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createPlaywrightPageProbe } from "../src/server/browser-playwright/playwright-page-probe.js";
import { publicNetworkAccess } from "../src/server/browser-playwright/public-network-access.js";

describe("Playwright PageProbe", () => {
  let browser: Browser;
  let fixture: Server;
  let fixtureUrl: string;

  beforeAll(async () => {
    fixture = createServer((request, response) => {
      if (request.url === "/dynamic") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(`<!doctype html>
          <main id="results"></main>
          <script>
            setTimeout(() => {
              document.querySelector('#results').innerHTML =
                '<article class="target">A</article><article class="target">B</article><article class="target">C</article>';
            }, 20);
          </script>`);
        return;
      }
      if (request.url === "/redirect-private") {
        const address = fixture.address() as AddressInfo;
        response.writeHead(302, {
          location: `http://127.0.0.1:${address.port}/private`,
        });
        response.end();
        return;
      }
      if (request.url === "/private") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end('<div class="target">private</div>');
        return;
      }
      if (request.url === "/isolated") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(`<body><script>
          if (!localStorage.getItem('visited')) {
            localStorage.setItem('visited', 'yes');
            document.body.innerHTML = '<div class="target">fresh</div>';
          }
        </script></body>`);
        return;
      }
      if (request.url === "/encapsulated") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(`<iframe srcdoc='<div class="target">iframe</div>'></iframe>
          <div id="shadow"></div>
          <script>
            document.querySelector('#shadow').attachShadow({mode: 'open'}).innerHTML =
              '<div class="target">shadow</div>';
          </script>`);
        return;
      }
      if (request.url === "/late-block") {
        const address = fixture.address() as AddressInfo;
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(`<div class="target">ready</div><script>
          setTimeout(() => fetch('http://127.0.0.1:${address.port}/private'), 10);
        </script>`);
        return;
      }
      if (request.url?.startsWith("/webrtc")) {
        const port = new URL(request.url, "http://fixture.test").searchParams.get(
          "port",
        );
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(`<div class="target">ready</div><script>
          try {
            const peer = new RTCPeerConnection({
              iceServers: [{ urls: 'stun:127.0.0.1:${port}' }],
            });
            peer.createDataChannel('probe');
            peer.createOffer()
              .then((offer) => peer.setLocalDescription(offer))
              .catch(() => undefined);
          } catch {}
        </script>`);
        return;
      }
      if (request.url === "/download") {
        response.writeHead(200, {
          "content-disposition": 'attachment; filename="payload.bin"',
          "content-type": "application/octet-stream",
        });
        response.end("payload");
        return;
      }
      if (request.url === "/slow") {
        return;
      }
      response.writeHead(404, { "content-type": "text/plain" });
      response.end("not found");
    });
    await new Promise<void>((resolve, reject) => {
      fixture.once("error", reject);
      fixture.listen(0, "127.0.0.1", resolve);
    });
    const address = fixture.address() as AddressInfo;
    fixtureUrl = `http://fixture.test:${address.port}`;
    browser = await chromium.launch({ headless: true });
  }, 30_000);

  afterAll(async () => {
    await browser.close();
    await new Promise<void>((resolve, reject) => {
      fixture.close((error) =>
        error === undefined ? resolve() : reject(error),
      );
    });
  }, 30_000);

  it("renders JavaScript and counts matching light DOM targets", async () => {
    const probe = createPlaywrightPageProbe(browser, {
      networkAccess: fixtureNetworkAccess(),
      timings: fastTimings(),
    });

    await expect(
      probe.preview({
        url: `${fixtureUrl}/dynamic`,
        targetSelector: ".target",
      }),
    ).resolves.toMatchObject({
      ok: true,
      preview: {
        finalUrl: `${fixtureUrl}/dynamic`,
        httpStatus: 200,
        matchCount: 3,
        timings: {
          totalMs: expect.any(Number),
          navigationMs: expect.any(Number),
          targetMs: expect.any(Number),
          scrollMs: expect.any(Number),
          stabilityMs: expect.any(Number),
          extractionMs: expect.any(Number),
        },
      },
    });
  });

  it("blocks a literal loopback address before Chromium connects", async () => {
    const address = fixture.address() as AddressInfo;
    const probe = createPlaywrightPageProbe(browser, {
      networkAccess: publicNetworkAccess,
      timings: fastTimings(),
    });

    await expect(
      probe.preview({
        url: `http://127.0.0.1:${address.port}/dynamic`,
        targetSelector: ".target",
      }),
    ).resolves.toMatchObject({ ok: false, code: "address_blocked" });
  });

  it("rechecks and blocks a redirect to loopback", async () => {
    const probe = createPlaywrightPageProbe(browser, {
      networkAccess: fixtureNetworkAccess(),
      timings: fastTimings(),
    });

    await expect(
      probe.preview({
        url: `${fixtureUrl}/redirect-private`,
        targetSelector: ".target",
      }),
    ).resolves.toMatchObject({ ok: false, code: "address_blocked" });
  });

  it("fails when a late page request targets a blocked address", async () => {
    const probe = createPlaywrightPageProbe(browser, {
      networkAccess: fixtureNetworkAccess(),
      timings: fastTimings(),
    });

    await expect(
      probe.preview({
        url: `${fixtureUrl}/late-block`,
        targetSelector: ".target",
      }),
    ).resolves.toMatchObject({
      ok: false,
      code: "address_blocked",
      finalUrl: `${fixtureUrl}/late-block`,
      httpStatus: 200,
      timings: { totalMs: expect.any(Number) },
    });
  });

  it("disables WebRTC so pages cannot bypass the safe proxy", async () => {
    const udp = createSocket("udp4");
    const packets: Buffer[] = [];
    udp.on("message", (packet) => packets.push(packet));
    await new Promise<void>((resolve, reject) => {
      udp.once("error", reject);
      udp.bind(0, "127.0.0.1", resolve);
    });

    try {
      const address = udp.address();
      const probe = createPlaywrightPageProbe(browser, {
        networkAccess: fixtureNetworkAccess(),
        timings: fastTimings(),
      });

      await expect(
        probe.preview({
          url: `${fixtureUrl}/webrtc?port=${address.port}`,
          targetSelector: ".target",
        }),
      ).resolves.toMatchObject({ ok: true });
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(packets).toHaveLength(0);
    } finally {
      await new Promise<void>((resolve) => udp.close(() => resolve()));
    }
  });

  it("uses a fresh non-persistent BrowserContext for every preview", async () => {
    const probe = createPlaywrightPageProbe(browser, {
      networkAccess: fixtureNetworkAccess(),
      timings: fastTimings(),
    });

    const input = {
      url: `${fixtureUrl}/isolated`,
      targetSelector: ".target",
    };
    await expect(probe.preview(input)).resolves.toMatchObject({
      ok: true,
      preview: { matchCount: 1 },
    });
    await expect(probe.preview(input)).resolves.toMatchObject({
      ok: true,
      preview: { matchCount: 1 },
    });
  });

  it("uses native CSS only in the main document light DOM", async () => {
    const probe = createPlaywrightPageProbe(browser, {
      networkAccess: fixtureNetworkAccess(),
      timings: fastTimings(),
    });

    await expect(
      probe.preview({
        url: `${fixtureUrl}/encapsulated`,
        targetSelector: ".target",
      }),
    ).resolves.toMatchObject({ ok: false, code: "target_not_found" });
    await expect(
      probe.preview({
        url: `${fixtureUrl}/dynamic`,
        targetSelector: "div[",
      }),
    ).resolves.toMatchObject({ ok: false, code: "invalid_selector" });
  });

  it("cancels attachment downloads as unsupported content", async () => {
    const probe = createPlaywrightPageProbe(browser, {
      networkAccess: fixtureNetworkAccess(),
      timings: fastTimings(),
    });

    await expect(
      probe.preview({
        url: `${fixtureUrl}/download`,
        targetSelector: ".target",
      }),
    ).resolves.toMatchObject({ ok: false, code: "unsupported_content" });
  });

  it("returns a typed navigation timeout and closes its context", async () => {
    const probe = createPlaywrightPageProbe(browser, {
      networkAccess: fixtureNetworkAccess(),
      timings: { ...fastTimings(), navigationMs: 75 },
    });

    await expect(
      probe.preview({
        url: `${fixtureUrl}/slow`,
        targetSelector: ".target",
      }),
    ).resolves.toMatchObject({ ok: false, code: "navigation_timeout" });
    expect(browser.contexts()).toHaveLength(0);
  });

  it("returns a typed setup failure instead of leaking an exception", async () => {
    const unavailableBrowser = {
      newContext: vi.fn().mockRejectedValue(new Error("browser unavailable")),
    } as unknown as Browser;
    const probe = createPlaywrightPageProbe(unavailableBrowser, {
      networkAccess: fixtureNetworkAccess(),
      timings: fastTimings(),
    });

    await expect(
      probe.preview({
        url: `${fixtureUrl}/dynamic`,
        targetSelector: ".target",
      }),
    ).resolves.toMatchObject({
      ok: false,
      code: "browser_failed",
      stage: "setup",
      finalUrl: `${fixtureUrl}/dynamic`,
      timings: { totalMs: expect.any(Number) },
    });
  });
});

function fixtureNetworkAccess() {
  return {
    async resolve(url: URL) {
      if (url.hostname !== "fixture.test") {
        return publicNetworkAccess.resolve(url);
      }
      return { address: "127.0.0.1", family: 4 as const };
    },
  };
}

function fastTimings() {
  return {
    deadlineMs: 3_000,
    navigationMs: 1_000,
    targetMs: 500,
    scrollMs: 500,
    settleDelayMs: 0,
    stabilityMs: 500,
    quietWindowMs: 25,
    extractionMs: 500,
  };
}
