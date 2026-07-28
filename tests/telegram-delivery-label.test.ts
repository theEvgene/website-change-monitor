import { describe, expect, it } from "vitest";

import { telegramDeliveryLabel } from "../src/ui/telegram-delivery.js";

describe("Telegram delivery label", () => {
  it("presents intentional disablement as a neutral outcome", () => {
    expect(telegramDeliveryLabel("disabled")).toBe("Telegram отключён");
    expect(telegramDeliveryLabel("unavailable")).toBe("Не отправлено");
  });
});
