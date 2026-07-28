import {
  defaultNotificationPolicy,
  type NotificationPolicy,
} from "../persistence/monitor-store.js";

export interface RuntimeNotificationSettings extends NotificationPolicy {
  telegramPhase: "checking" | "enabled" | "disabled";
}

export interface RuntimeNotificationSettingsController {
  state(): RuntimeNotificationSettings;
  update(patch: Partial<NotificationPolicy>, now: string): {
    settings: RuntimeNotificationSettings;
    checkGeneration?: number;
  };
  completeCheck(generation: number): RuntimeNotificationSettings | undefined;
}

export function createRuntimeNotificationSettings(options: {
  disablePendingTelegramDeliveries(now: string): void;
}): RuntimeNotificationSettingsController {
  let generation = 0;
  let current: RuntimeNotificationSettings = {
    ...defaultNotificationPolicy,
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
        generation += 1;
        options.disablePendingTelegramDeliveries(now);
      }
      const startsCheck = telegramEnabled && !current.telegramEnabled;
      if (startsCheck) generation += 1;
      current = {
        telegramEnabled,
        notifyWhenUnchanged,
        telegramPhase: startsCheck
          ? "checking"
          : telegramEnabled
            ? current.telegramPhase === "checking" ? "checking" : "enabled"
            : "disabled",
      };
      return {
        settings: current,
        ...(startsCheck ? { checkGeneration: generation } : {}),
      };
    },
    completeCheck(checkGeneration) {
      if (
        checkGeneration !== generation ||
        !current.telegramEnabled ||
        current.telegramPhase !== "checking"
      ) {
        return undefined;
      }
      current = { ...current, telegramPhase: "enabled" };
      return current;
    },
  };
}
