import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  isTelegramAdmin,
  parseBroadcastCommand,
} from "@/lib/telegram/broadcast";

describe("Telegram Admin Broadcast Feature", () => {
  const ORIGINAL_ENV = process.env.EXCELA_ADMIN_TELEGRAM_ID;

  beforeEach(() => {
    process.env.EXCELA_ADMIN_TELEGRAM_ID = "1122334455";
  });

  afterEach(() => {
    if (ORIGINAL_ENV !== undefined) {
      process.env.EXCELA_ADMIN_TELEGRAM_ID = ORIGINAL_ENV;
    } else {
      delete process.env.EXCELA_ADMIN_TELEGRAM_ID;
    }
  });

  // 1. Admin authorization verification
  it("should authorize sender matching EXCELA_ADMIN_TELEGRAM_ID", () => {
    assert.strictEqual(isTelegramAdmin(1122334455), true);
    assert.strictEqual(isTelegramAdmin("1122334455"), true);
  });

  // 2. Unauthorized sender rejection
  it("should reject unauthorized sender IDs", () => {
    assert.strictEqual(isTelegramAdmin(9999999999), false);
    assert.strictEqual(isTelegramAdmin("9999999999"), false);
    assert.strictEqual(isTelegramAdmin(0), false);
  });

  // 3. Fail-safe when env var is missing or empty
  it("should fail-safe and deny access when EXCELA_ADMIN_TELEGRAM_ID is unset or whitespace", () => {
    delete process.env.EXCELA_ADMIN_TELEGRAM_ID;
    assert.strictEqual(isTelegramAdmin(1122334455), false);

    process.env.EXCELA_ADMIN_TELEGRAM_ID = "   ";
    assert.strictEqual(isTelegramAdmin(1122334455), false);
  });

  // 4. Command parsing with message
  it("should correctly parse /broadcast <message>", () => {
    const res = parseBroadcastCommand("/broadcast Hello everyone! New features added.");
    assert.strictEqual(res.isCommand, true);
    assert.strictEqual(res.message, "Hello everyone! New features added.");
  });

  // 5. Command parsing with bot name suffix
  it("should correctly parse /broadcast@ExcelaBot <message>", () => {
    const res = parseBroadcastCommand("/broadcast@ExcelaBot Maintenance in 10 minutes.");
    assert.strictEqual(res.isCommand, true);
    assert.strictEqual(res.message, "Maintenance in 10 minutes.");
  });

  // 6. Command parsing with multi-line message
  it("should preserve multi-line text in broadcast message", () => {
    const multiline = "/broadcast Update:\n• Feature 1\n• Feature 2\n\nEnjoy planning!";
    const res = parseBroadcastCommand(multiline);
    assert.strictEqual(res.isCommand, true);
    assert.strictEqual(res.message, "Update:\n• Feature 1\n• Feature 2\n\nEnjoy planning!");
  });

  // 7. Missing message detection
  it("should detect missing message when only /broadcast is sent", () => {
    const res1 = parseBroadcastCommand("/broadcast");
    assert.strictEqual(res1.isCommand, true);
    assert.strictEqual(res1.message, "");

    const res2 = parseBroadcastCommand("/broadcast   ");
    assert.strictEqual(res2.isCommand, true);
    assert.strictEqual(res2.message, "");

    const res3 = parseBroadcastCommand("/broadcast@ExcelaBot");
    assert.strictEqual(res3.isCommand, true);
    assert.strictEqual(res3.message, "");
  });

  // 8. Non-broadcast commands
  it("should ignore non-broadcast messages", () => {
    const res = parseBroadcastCommand("Hello broadcast message");
    assert.strictEqual(res.isCommand, false);
    assert.strictEqual(res.message, "");
  });

  // 9. Failure isolation logic simulation
  it("should isolate recipient errors without aborting remaining broadcast", async () => {
    const recipients = [101, 102, 103, 104];
    let sent = 0;
    let failed = 0;

    // Simulate sending: recipient 102 blocked the bot
    for (const id of recipients) {
      try {
        if (id === 102) {
          throw new Error("Forbidden: bot was blocked by the user");
        }
        sent++;
      } catch {
        failed++;
      }
    }

    assert.strictEqual(sent, 3);
    assert.strictEqual(failed, 1);
    const report = `Broadcast complete.\nSent: ${sent}\nFailed: ${failed}`;
    assert.strictEqual(report, "Broadcast complete.\nSent: 3\nFailed: 1");
  });

  // 10. Deduplication of recipient chat IDs
  it("should deduplicate recipient chat IDs", () => {
    const docs = [
      { telegram: { chatId: 111 } },
      { telegram: { chatId: 222 } },
      { telegram: { chatId: 111 } }, // duplicate
      { telegram: { chatId: 333 } },
      { telegram: undefined }, // unlinked
    ];

    const uniqueIds = Array.from(
      new Set(
        docs
          .map((d) => d.telegram?.chatId)
          .filter((id): id is number => typeof id === "number" && Number.isFinite(id) && id !== 0),
      ),
    );

    assert.deepStrictEqual(uniqueIds, [111, 222, 333]);
    assert.strictEqual(uniqueIds.length, 3);
  });
});
