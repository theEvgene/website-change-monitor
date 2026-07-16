import { describe, expect, it, vi } from "vitest";

import { createPublicNetworkAccess } from "../src/server/browser-playwright/public-network-access.js";

describe("public page network policy", () => {
  it("blocks a hostname when any DNS result is non-public", async () => {
    const lookup = vi.fn().mockResolvedValue([
      { address: "93.184.216.34", family: 4 },
      { address: "192.168.1.20", family: 4 },
    ]);
    const networkAccess = createPublicNetworkAccess(lookup);

    await expect(
      networkAccess.resolve(new URL("https://mixed.example/page")),
    ).rejects.toMatchObject({ code: "address_blocked" });
    expect(lookup).toHaveBeenCalledWith("mixed.example", {
      all: true,
      verbatim: true,
    });
  });

  it.each(["192.88.99.1", "3fff::1", "5f00::1", "4000::1"])(
    "blocks special or non-global address %s",
    async (address) => {
      const family = address.includes(":") ? 6 : 4;
      const networkAccess = createPublicNetworkAccess(
        vi.fn().mockResolvedValue([{ address, family }]),
      );

      await expect(
        networkAccess.resolve(new URL("https://special.example/page")),
      ).rejects.toMatchObject({ code: "address_blocked" });
    },
  );
});
