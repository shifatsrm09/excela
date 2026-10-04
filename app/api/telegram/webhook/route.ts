import type { TelegramUpdate } from "@/lib/telegram/types";
import { googleAccessToken } from "@/ai/google-auth";
import { sendTelegramChatAction, sendTelegramReply } from "@/lib/telegram/client";
import {
  disconnectTelegram,
  findUserByTelegramId,
  verifyAndConsumeLinkingCode,
} from "@/lib/telegram/linking";
import {
  appendTelegramConversation,
  clearTelegramConversation,
  getTelegramConversation,
  isUpdateAlreadyProcessed,
} from "@/lib/telegram/conversation";
import { decrypt } from "@/lib/crypto";
import { normalizeOllamaKey } from "@/lib/ollama-key";
import { canonicalSheetUrl, tabMonthYear } from "@/lib/sheet";
import { AgentError, runSmartAgent } from "@/lib/agent/agent";
import { PlannerError, getSchedule } from "@/lib/planner-service";
import {
  DEFAULT_TIMEZONE,
  disableDailyNotification,
  formatTime12h,
  getZonedParts,
  parseTimeInput,
  setDailyNotification,
} from "@/lib/telegram/auto-notify";
import { handleReminderCommand } from "@/lib/telegram/reminders";
import { handleBroadcastCommand } from "@/lib/telegram/broadcast";

export const runtime = "nodejs";
export const maxDuration = 60;

const HELP_MESSAGE = `Excela Planner Assistant

Chat naturally with me to manage your planner.

Schedule
• "What do I have today?"
• "What's on my schedule tomorrow?"
• "What's happening this week?"

Tasks & reminders
• "Gym tomorrow at 7pm"
• "I have self advising at 7pm Oct 1"
• "Gym on Oct 2"
• "Move my meeting to Friday"
• "Change the time to 4pm"
• "Mark that complete"

Timed tasks are automatically reminded 5 minutes before.

Commands
• /start [code] — Connect your Excela account
• /view — Open your Google Sheets planner
• /week — View the next 7 days
• /auto [time] — Get daily schedule updates
• /clear — Clear conversation context
• /disconnect — Disconnect Telegram
• /help — Show this help`;

export async function POST(request: Request) {
  try {
    let update: TelegramUpdate;
    try {
      update = (await request.json()) as TelegramUpdate;
    } catch {
      return Response.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
    }

    // Webhook idempotency: skip if already processed
    if (typeof update.update_id === "number") {
      const alreadyProcessed = await isUpdateAlreadyProcessed(update.update_id);
      if (alreadyProcessed) {
        return Response.json({ ok: true });
      }
    }

    const message = update.message || update.edited_message;
    if (!message || !message.text || !message.from) {
      return Response.json({ ok: true });
    }

    const chatId = message.chat.id;
    const sender = message.from;
    const text = message.text.trim();

    // Command: /start [CODE]
    if (text.startsWith("/start")) {
      const parts = text.split(/\s+/);
      const code = parts[1]?.trim();

      if (code) {
        const result = await verifyAndConsumeLinkingCode(code, sender, chatId);

        if (result.success) {
          await sendTelegramReply(
            chatId,
            "✅ Your Telegram account is now connected to Excela!\n\nYou can now ask me to check your schedule or add, move, and update events on your planner.\n\nType /help to see examples.",
          );
        } else if (result.reason === "already_linked") {
          await sendTelegramReply(
            chatId,
            "⚠️ This Telegram account is already connected to an Excela account.\n\nTo link a different account, disconnect it from your Excela web settings first.",
          );
        } else {
          await sendTelegramReply(
            chatId,
            "⚠️ This linking code is invalid or has expired.\n\nPlease generate a fresh linking code from your Excela web settings.",
          );
        }
      } else {
        const existing = await findUserByTelegramId(sender.id);
        if (existing) {
          await sendTelegramReply(
            chatId,
            "You're connected to Excela! 📅\n\nAsk me anything about your planner, or type /help for examples.",
          );
        } else {
          await sendTelegramReply(
            chatId,
            "Welcome to Excela! 👋\n\nTo connect your Telegram account to your Excela planner, generate a linking code from the Telegram settings page in the Excela web app.",
          );
        }
      }

      return Response.json({ ok: true });
    }

    // Command: /view
    if (text === "/view" || text.startsWith("/view@")) {
      const user = await findUserByTelegramId(sender.id);
      if (!user) {
        await sendTelegramReply(
          chatId,
          "Your Telegram account is not connected to Excela.\n\nPlease connect it from the Excela web settings first.",
        );
        return Response.json({ ok: true });
      }

      if (!user.sheetId) {
        await sendTelegramReply(
          chatId,
          "You do not have a connected planner yet. Please connect a Google Sheets planner in Excela setup first.",
        );
        return Response.json({ ok: true });
      }

      const plainSheetUrl = user.sheetUrl || canonicalSheetUrl(user.sheetId);
      let sheetUrl = plainSheetUrl;

      // Match the dashboard navbar by opening the current month tab directly.
      try {
        const token = await googleAccessToken(user);
        const result = await fetch(
          `https://sheets.googleapis.com/v4/spreadsheets/${user.sheetId}?fields=sheets(properties(sheetId,title))`,
          {
            headers: { Authorization: `Bearer ${token}` },
            cache: "no-store",
            signal: AbortSignal.timeout(15_000),
          },
        );
        if (result.ok) {
          const data = (await result.json()) as { sheets?: { properties: { sheetId: number; title: string } }[] };
          const now = new Date();
          const month = now.getUTCMonth() + 1;
          const year = now.getUTCFullYear();
          const tab = (data.sheets ?? []).find(({ properties }) => {
            const parsed = tabMonthYear(properties.title);
            return parsed?.month === month && parsed.year === year;
          });
          if (tab) sheetUrl = `${canonicalSheetUrl(user.sheetId)}#gid=${tab.properties.sheetId}`;
        }
      } catch {
        // The root planner link remains useful if current-tab lookup fails.
      }

      await sendTelegramReply(chatId, `📊 Open your Excela planner:\n${sheetUrl}`);
      return Response.json({ ok: true });
    }

    // Command: /week (tolerant of /weel, /weekly, /week@bot, trailing spaces, case-insensitive)
    if (/^\/(?:week|weel|weekly)(?:@\S+)?(?:\s+.*)?$/i.test(text)) {
      const user = await findUserByTelegramId(sender.id);
      if (!user) {
        await sendTelegramReply(
          chatId,
          "Your Telegram account is not connected to Excela.\n\nPlease connect it from the Excela web settings first.",
        );
        return Response.json({ ok: true });
      }

      if (!user.sheetId) {
        await sendTelegramReply(
          chatId,
          "You do not have a connected planner yet. Please connect a Google Sheets planner in Excela setup first.",
        );
        return Response.json({ ok: true });
      }

      void sendTelegramChatAction(chatId, "typing");

      try {
        const timeZone = user.dailyNotification?.timezone || DEFAULT_TIMEZONE || "Asia/Dhaka";
        const zoned = getZonedParts(new Date(), timeZone);
        const today = `${zoned.year}-${String(zoned.month).padStart(2, "0")}-${String(zoned.day).padStart(2, "0")}`;
        const start = new Date(`${today}T00:00:00Z`);

        const days: { dateStr: string; dateObj: Date }[] = [];
        for (let i = 0; i < 7; i++) {
          const d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate() + i));
          days.push({
            dateStr: d.toISOString().slice(0, 10),
            dateObj: d,
          });
        }

        const from = days[0].dateStr;
        const to = days[6].dateStr;

        const schedule = await getSchedule(user, from, to);
        const scheduleByDate = new Map(schedule.map((row) => [row.date, row.slots]));

        const lines = days.map(({ dateStr, dateObj }) => {
          const monthStr = dateObj.toLocaleDateString("en-US", { month: "short", timeZone: "UTC" });
          const dayNum = dateObj.getUTCDate();
          const weekdayStr = dateObj.toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" }).toUpperCase();

          const slots = scheduleByDate.get(dateStr) ?? [];
          const eventTexts = slots.map((s) => s.text).filter(Boolean);
          const content = eventTexts.length > 0 ? eventTexts.join(" | ") : "—";

          return `${monthStr} ${dayNum}: ${weekdayStr} → ${content}`;
        });

        await sendTelegramReply(chatId, lines.join("\n"));
      } catch (error) {
        console.error("Telegram /week error:", error);
        const errorMsg =
          error instanceof PlannerError
            ? error.message
            : "Could not retrieve your schedule right now. Please try again.";
        await sendTelegramReply(chatId, errorMsg);
      }

      return Response.json({ ok: true });
    }

    // Command: /auto
    if (/^\/auto(?:@\S+)?(?:\s+.*)?$/i.test(text)) {
      const user = await findUserByTelegramId(sender.id);
      if (!user) {
        await sendTelegramReply(
          chatId,
          "Your Telegram account is not connected to Excela.\n\nPlease connect it from the Excela web settings first.",
        );
        return Response.json({ ok: true });
      }

      // Extract argument after /auto or /auto@botname
      const match = text.match(/^\/auto(?:@\S+)?(?:\s+(.*))?$/i);
      const arg = match?.[1]?.trim() ?? "";

      // 1. Status query: "/auto" with no argument
      if (!arg) {
        const config = user.dailyNotification;
        if (config?.enabled && config.time) {
          await sendTelegramReply(
            chatId,
            `Daily notifications: ON\nTime: ${formatTime12h(config.time)}`,
          );
        } else {
          await sendTelegramReply(chatId, "Daily notifications: OFF");
        }
        return Response.json({ ok: true });
      }

      // 2. Disabling: "/auto off"
      if (arg.toLowerCase() === "off") {
        await disableDailyNotification(user._id);
        await sendTelegramReply(chatId, "Daily notifications disabled.");
        return Response.json({ ok: true });
      }

      // 3. Setting time: "/auto 6:30pm", "/auto 9am", "/auto 18:30", etc.
      const parsedTime = parseTimeInput(arg);
      if (!parsedTime) {
        await sendTelegramReply(chatId, "Usage: /auto 6:30pm");
        return Response.json({ ok: true });
      }

      const isUpdate = Boolean(user.dailyNotification?.enabled && user.dailyNotification?.time);
      await setDailyNotification(user._id, parsedTime, user.dailyNotification?.timezone || DEFAULT_TIMEZONE);

      const timeFormatted = formatTime12h(parsedTime);
      if (isUpdate) {
        await sendTelegramReply(chatId, `Daily notifications updated.\nTime: ${timeFormatted}`);
      } else {
        await sendTelegramReply(chatId, `Daily notifications enabled.\nTime: ${timeFormatted}`);
      }

      return Response.json({ ok: true });
    }

    // Command: /n (task-specific reminder)
    if (/^\/n(?:@\S+)?(?:\s+.*)?$/i.test(text)) {
      const user = await findUserByTelegramId(sender.id);
      if (!user) {
        await sendTelegramReply(
          chatId,
          "Your Telegram account is not connected to Excela.\n\nPlease connect it from the Excela web settings first.",
        );
        return Response.json({ ok: true });
      }

      await handleReminderCommand(user, chatId, text);
      return Response.json({ ok: true });
    }

    // Command: /clear
    if (text === "/clear" || text.startsWith("/clear@")) {
      const user = await findUserByTelegramId(sender.id);
      if (!user) {
        await sendTelegramReply(
          chatId,
          "Your Telegram account is not connected to Excela.\n\nPlease connect it from the Excela web settings first.",
        );
        return Response.json({ ok: true });
      }

      await clearTelegramConversation(chatId);
      await sendTelegramReply(chatId, "Conversation cleared. What would you like to plan?");
      return Response.json({ ok: true });
    }

    // Command: /help
    if (text === "/help" || text.startsWith("/help@")) {
      await sendTelegramReply(chatId, HELP_MESSAGE);
      return Response.json({ ok: true });
    }

    // Command: /disconnect
    if (text === "/disconnect" || text.startsWith("/disconnect@")) {
      const user = await findUserByTelegramId(sender.id);
      if (!user) {
        await sendTelegramReply(
          chatId,
          "Your Telegram account is not connected to Excela.",
        );
        return Response.json({ ok: true });
      }

      await disconnectTelegram(user._id);
      await sendTelegramReply(
        chatId,
        "👋 Your Telegram account has been disconnected from Excela.\n\nYou can reconnect anytime from the Excela web settings.",
      );
      return Response.json({ ok: true });
    }

    // Command: /broadcast <message> (Admin-only)
    if (/^\/broadcast(?:@\S+)?(?:\s+[\s\S]*|$)/i.test(text)) {
      await handleBroadcastCommand(sender.id, chatId, text);
      return Response.json({ ok: true });
    }

    // Normal messages -> Smart Planner Agent
    const user = await findUserByTelegramId(sender.id);
    if (!user) {
      await sendTelegramReply(
        chatId,
        "Your Telegram account is not connected to Excela.\n\nPlease connect it from the Excela web settings first.",
      );
      return Response.json({ ok: true });
    }

    // Check Ollama API key
    const rawApiKey = user.ollamaApiKey ? decrypt(user.ollamaApiKey) : null;
    const apiKey = rawApiKey ? normalizeOllamaKey(rawApiKey) : null;
    if (!apiKey) {
      await sendTelegramReply(
        chatId,
        "⚠️ Please configure your Ollama API key in Excela web setup before chatting with the planner.",
      );
      return Response.json({ ok: true });
    }

    // Check Google Sheets planner
    if (!user.sheetId) {
      await sendTelegramReply(
        chatId,
        "⚠️ Please connect a Google Sheets planner in Excela web setup before chatting with the planner.",
      );
      return Response.json({ ok: true });
    }

    // Show typing status indicator in Telegram
    void sendTelegramChatAction(chatId, "typing");

    const agentTimezone = user.dailyNotification?.timezone || DEFAULT_TIMEZONE || "Asia/Dhaka";
    const zonedToday = getZonedParts(new Date(), agentTimezone);
    const today = `${zonedToday.year}-${String(zonedToday.month).padStart(2, "0")}-${String(zonedToday.day).padStart(2, "0")}`;
    const history = await getTelegramConversation(chatId);

    try {
      const { reply } = await runSmartAgent(apiKey, user, today, text, history);

      // Persist turn in MongoDB conversation history
      await appendTelegramConversation(chatId, user._id, text, reply);

      // Send response to Telegram (auto-chunked if long)
      await sendTelegramReply(chatId, reply);
    } catch (error) {
      console.error("Smart Agent Telegram error:", error);
      const userMsg =
        error instanceof AgentError
          ? error.message
          : "⚠️ I encountered an error while processing your request. Please try again in a moment.";
      await sendTelegramReply(chatId, userMsg);
    }

    return Response.json({ ok: true });
  } catch (error) {
    console.error("Telegram webhook unexpected error:", error);
    return Response.json({ ok: true });
  }
}
