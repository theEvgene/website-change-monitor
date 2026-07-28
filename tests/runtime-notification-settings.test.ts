import { describe, expect, it, vi } from "vitest";

import { createRuntimeNotificationSettings } from "../src/server/notifications/runtime-notification-settings.js";

describe("runtime notification settings", () => {
  it("uses a generation so disabling wins over a late enable check", () => {
    const disablePendingTelegramDeliveries = vi.fn();
    const settings = createRuntimeNotificationSettings({
      disablePendingTelegramDeliveries,
    });

    settings.update({ telegramEnabled: false }, "2026-07-28T10:00:00.000Z");
    const enable = settings.update(
      { telegramEnabled: true },
      "2026-07-28T10:00:01.000Z",
    );
    expect(enable).toEqual({
      settings: {
        telegramEnabled: true,
        notifyWhenUnchanged: false,
        telegramPhase: "checking",
      },
      checkGeneration: 2,
    });

    settings.update({ telegramEnabled: false }, "2026-07-28T10:00:02.000Z");

    expect(settings.completeCheck(enable.checkGeneration!)).toBeUndefined();
    expect(settings.state()).toEqual({
      telegramEnabled: false,
      notifyWhenUnchanged: false,
      telegramPhase: "disabled",
    });
    expect(disablePendingTelegramDeliveries).toHaveBeenCalledTimes(2);
  });

  it("completes only the current enable check and keeps no-change notifications reset", () => {
    const settings = createRuntimeNotificationSettings({
      disablePendingTelegramDeliveries: vi.fn(),
    });
    settings.update(
      { notifyWhenUnchanged: true },
      "2026-07-28T10:00:00.000Z",
    );
    settings.update({ telegramEnabled: false }, "2026-07-28T10:00:01.000Z");
    const enable = settings.update(
      { telegramEnabled: true },
      "2026-07-28T10:00:02.000Z",
    );

    expect(settings.completeCheck(enable.checkGeneration!)).toEqual({
      telegramEnabled: true,
      notifyWhenUnchanged: false,
      telegramPhase: "enabled",
    });
  });
});
