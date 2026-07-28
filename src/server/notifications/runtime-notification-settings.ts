import type { NotificationPolicy } from "../persistence/monitor-store.js";

export interface RuntimeNotificationSettings extends NotificationPolicy {
  telegramPhase: "enabled" | "disabled";
}

export interface RuntimeNotificationSettingsController {
  state(): RuntimeNotificationSettings;
  update(patch: Partial<NotificationPolicy>, now: string): RuntimeNotificationSettings;
}

export function createRuntimeNotificationSettings(options: {
  disablePendingTelegramDeliveries(now: string): void;
}): RuntimeNotificationSettingsController {
  let current: RuntimeNotificationSettings = {
    telegramEnabled: true,
    notifyWhenUnchanged: false,
    telegramPhase: "enabled",
  };

  return {
    state: () => current,
    update(patch, now) {
      const telegramEnabled = patch.telegramEnabled ?? current.telegramEnabled;
      const notifyWhenUnchanged = telegramEnabled
        ? (patch.notifyWhenUnchanged ?? current.notifyWhenUnchanged)
        : false;
      if (!telegramEnabled && current.telegramEnabled) {
        options.disablePendingTelegramDeliveries(now);
      }
      current = {
        telegramEnabled,
        notifyWhenUnchanged,
        telegramPhase: telegramEnabled ? "enabled" : "disabled",
      };
      return current;
    },
  };
}
