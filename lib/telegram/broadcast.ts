import { usersCollection } from "@/lib/mongodb";
import { sendTelegramChatAction, sendTelegramReply } from "@/lib/telegram/client";

/**
 * Checks whether the given Telegram sender ID matches the configured admin ID.
 * The check is performed strictly server-side using process.env.EXCELA_ADMIN_TELEGRAM_ID.
 */
export function isTelegramAdmin(senderId: number | string): boolean {
  const adminIdEnv = process.env.EXCELA_ADMIN_TELEGRAM_ID?.trim();
  if (!adminIdEnv) return false;
  return String(senderId).trim() === adminIdEnv;
}

/**
 * Parses user input for the `/broadcast` command.
 * Supports `/broadcast <message>` and `/broadcast@botname <message>`.
 */
export function parseBroadcastCommand(rawText: string): { isCommand: boolean; message: string } {
  const match = rawText.match(/^\/broadcast(?:@\S+)?(?:\s+([\s\S]+))?$/i);
  if (!match) {
    return { isCommand: false, message: "" };
  }
  const message = match[1]?.trim() ?? "";
  return { isCommand: true, message };
}

/**
 * Broadcasts a message to all Telegram-connected Excela users with error isolation
 * and rate-limit pacing.
 */
export async function broadcastMessageToAllUsers(
  message: string,
  options?: { delayMs?: number },
): Promise<{ total: number; sent: number; failed: number }> {
  const users = await usersCollection();
  const recipientDocs = await users
    .find(
      { "telegram.chatId": { $exists: true, $ne: null } },
      { projection: { "telegram.chatId": 1 } },
    )
    .toArray();

  const chatIds = Array.from(
    new Set(
      recipientDocs
        .map((u) => u.telegram?.chatId)
        .filter((id): id is number => typeof id === "number" && Number.isFinite(id) && id !== 0),
    ),
  );

  let sent = 0;
  let failed = 0;
  const delayMs = options?.delayMs ?? 35; // ~28 messages/sec, safe under Telegram's 30/sec limit

  for (const targetChatId of chatIds) {
    try {
      const ok = await sendTelegramReply(targetChatId, message);
      if (ok) {
        sent++;
      } else {
        failed++;
      }
    } catch (err) {
      console.error(`Broadcast failed for chat ${targetChatId}:`, err instanceof Error ? err.message : err);
      failed++;
    }

    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  return { total: chatIds.length, sent, failed };
}

/**
 * Handles the `/broadcast` Telegram command execution.
 */
export async function handleBroadcastCommand(
  senderId: number,
  chatId: number,
  rawText: string,
): Promise<void> {
  // 1. Strict server-side admin authorization
  if (!isTelegramAdmin(senderId)) {
    await sendTelegramReply(chatId, "Unauthorized.");
    return;
  }

  // 2. Extract and validate message text
  const { isCommand, message } = parseBroadcastCommand(rawText);
  if (!isCommand || !message) {
    await sendTelegramReply(chatId, "Usage:\n/broadcast <message>");
    return;
  }

  // 3. Send typing indicator to admin while broadcasting
  void sendTelegramChatAction(chatId, "typing");

  // 4. Send message to all connected users
  const { sent, failed } = await broadcastMessageToAllUsers(message);

  // 5. Send compact execution summary to admin
  const report = `Broadcast complete.\nSent: ${sent}\nFailed: ${failed}`;
  await sendTelegramReply(chatId, report);
}
