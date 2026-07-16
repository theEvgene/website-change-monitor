import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { createHttpTestContext } from "./support/http-test-context.js";
import {
  simplePagePreviewTargets,
  successfulPageProbeResult,
} from "./support/page-probe.js";

const executeFile = promisify(execFile);

describe("documented direct HTTP examples", () => {
  const context = createHttpTestContext();

  afterEach(async () => {
    await context.cleanup();
  });

  it("executes the PowerShell and curl commands published in the guide", async () => {
    const guide = await readFile("docs/http-api.md", "utf8");
    const port = await availablePort();
    const server = await context.applicationServer({
      port,
      pageProbe: {
        async preview() {
          return successfulPageProbeResult(
            "https://example.com/catalog",
            [
              { selector: ".page-title", matchCount: 1 },
              { selector: ".product-card", matchCount: 2 },
            ],
            simplePagePreviewTargets("Catalog", "Product A", "Product B"),
          );
        },
      },
    });
    await server.listen({ host: "127.0.0.1", port });

    const powershellResult = await runDocumentedExample(
      example(guide, "powershell-health"),
      port,
    );
    const curlResult = await runDocumentedExample(
      example(guide, "curl-version"),
      port,
    );
    const previewResult = await runDocumentedExample(
      example(guide, "powershell-preview"),
      port,
    );

    expect(JSON.parse(powershellResult)).toMatchObject({
      application: "website-change-monitor",
      status: "degraded",
    });
    expect(JSON.parse(curlResult)).toEqual({
      application: "website-change-monitor",
      apiVersion: "v1",
      version: "0.1.0",
    });
    expect(JSON.parse(previewResult)).toEqual({
      finalUrl: "https://example.com/catalog",
      targetMatches: [
        { selector: ".page-title", matchCount: 1 },
        { selector: ".product-card", matchCount: 2 },
      ],
      exclusionSelectors: [".price"],
      targetCount: 3,
      targets: simplePagePreviewTargets("Catalog", "Product A", "Product B"),
    });
  });
});

function example(guide: string, name: string): string {
  const fence = "`".repeat(3);
  const pattern = new RegExp(
    `<!-- verify:${name} -->\\s*${fence}powershell\\s*([^]*?)\\s*${fence}`,
  );
  const match = pattern.exec(guide);
  if (match?.[1] === undefined) {
    throw new Error(`Documented example ${name} was not found`);
  }
  return match[1].trim();
}

async function runDocumentedExample(
  command: string,
  port: number,
): Promise<string> {
  const { stdout } = await executeFile(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      command.replaceAll("43117", String(port)),
    ],
    { encoding: "utf8", windowsHide: true },
  );
  return stdout.trim();
}

async function availablePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const address = probe.address();
  if (address === null || typeof address === "string") {
    throw new Error("Unable to allocate a loopback port");
  }
  await new Promise<void>((resolve, reject) => {
    probe.close((error) => (error === undefined ? resolve() : reject(error)));
  });
  return address.port;
}
