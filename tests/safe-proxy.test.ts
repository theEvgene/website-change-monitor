import { Socket } from "node:net";

import { describe, expect, it, vi } from "vitest";

import { protectProxySocket } from "../src/server/browser-playwright/safe-proxy.js";

describe("safe proxy socket lifecycle", () => {
  it("contains an aborted pipe write instead of crashing the process", () => {
    const socket = new Socket();
    const destroy = vi.spyOn(socket, "destroy");

    protectProxySocket(socket);
    socket.emit("error", Object.assign(new Error("write ECONNABORTED"), {
      code: "ECONNABORTED",
    }));

    expect(destroy).toHaveBeenCalledOnce();
  });
});
