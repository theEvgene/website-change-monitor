export type TelegramDeliveryState = "pending" | "sending" | "delivered" | "unavailable" | "permanent" | "temporary" | "timeout" | "abandoned" | "disabled";

export interface TelegramDeliveryView { state: TelegramDeliveryState; failureReason: string | null }

export function telegramDeliveryLabel(state: TelegramDeliveryState): string {
  if (state === "pending" || state === "sending") return "Отправляется";
  if (state === "delivered") return "Отправлено";
  if (state === "disabled") return "Telegram отключён";
  return "Не отправлено";
}
