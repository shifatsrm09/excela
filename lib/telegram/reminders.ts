import { ObjectId } from "mongodb";
import type { TaskReminderDoc, UserDoc } from "@/lib/models";
import { taskRemindersCollection, usersCollection } from "@/lib/mongodb";
import { createEvent, getSchedule, PlannerError } from "@/lib/planner-service";
import { sendTelegramReply } from "@/lib/telegram/client";
import {
  DEFAULT_TIMEZONE,
  formatTime12h,
  getZonedParts,
  parseTimeInput,
  zonedTimeToUtc,
} from "@/lib/telegram/auto-notify";

export { formatTime12h, parseTimeInput };

export type ParseReminderResult =
  | {
      success: true;
      taskTitle: string;
      date: string; // YYYY-MM-DD
      time24: string; // HH:mm
      eventUtc: Date;
      scheduledFor: Date;
      timeFormatted: string; // e.g. "3:00 PM"
      reminderTimeFormatted: string; // e.g. "2:55 PM"
      isTomorrow: boolean;
    }
  | {
      success: false;
      error: "usage" | "missing_task" | "missing_time" | "invalid_time" | "past_time" | "reminder_past";
      timeFormatted?: string;
    };

/**
 * Extracts a 24h normalized time string from a text segment, if any exists.
 * Accurately detects: "7pm", "7:00pm", "19:00", "09:00", "6.45", "noon", "midnight".
 * Ignores bare numbers like "2" in "Oct 2" or course numbers.
 */
export function extractTimeFromText(text: string): string | null {
  if (!text) return null;
  const lower = text.toLowerCase();
  if (/\bnoon\b/.test(lower)) return "12:00";
  if (/\bmidnight\b/.test(lower)) return "00:00";

  // Match:
  // 1) 12-hour times with AM/PM (e.g. "7pm", "7:00pm", "7.00pm", "7 pm", "7:00 PM")
  // 2) 24-hour times with colon or period (e.g. "19:00", "18:30", "09:00", "6.45")
  const regex = /\b(\d{1,2}(?:[:.]\d{2})?\s*(?:am|pm|a\.m\.|p\.m\.)|\d{1,2}[:.]\d{2})\b/gi;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    const candidate = parseTimeInput(match[1]);
    if (candidate) return candidate;
  }
  return null;
}

/**
 * Removes clock time phrases and prepositions ("at 7pm", "7:00 PM", "at noon") from an event title.
 */
export function stripTimeFromText(text: string): string {
  if (!text) return "";
  return text
    .replace(/\s+(?:at|@)?\s*\b(\d{1,2}(?:[:.]\d{2})?\s*(?:am|pm|a\.m\.|p\.m\.)|\d{1,2}[:.]\d{2}|noon|midnight)\b/gi, "")
    .replace(/\s+at\s*$/i, "")
    .replace(/\s+on\s*$/i, "")
    .trim();
}

export type SyncReminderInput = {
  cell: string;
  sheetId?: number;
  rowIndex?: number;
  date?: string;
  rawTitle: string;
  explicitTime?: string | null;
};

export type SyncReminderResult = {
  reminderSet: boolean;
  time24?: string;
  timeFormatted?: string;
  reminderTimeFormatted?: string;
  scheduledFor?: Date;
  titleWithTime: string;
  cleanTitle: string;
};

/**
 * Synchronizes task reminder state for an event:
 * - If event has an explicit clock time: schedules or updates a 5-minute pre-event reminder.
 * - If event has NO explicit clock time: disables/removes any existing task reminder for this cell.
 */
export async function syncReminderForEvent(
  user: UserDoc,
  input: SyncReminderInput,
  now: Date = new Date(),
): Promise<SyncReminderResult> {
  const reminders = await taskRemindersCollection();

  // 1. Determine if there is an explicit clock time
  let time24: string | null = null;
  if (input.explicitTime && typeof input.explicitTime === "string") {
    time24 = parseTimeInput(input.explicitTime);
  }
  if (!time24) {
    time24 = extractTimeFromText(input.rawTitle);
  }

  const cleanTitle = stripTimeFromText(input.rawTitle) || input.rawTitle.trim();

  // If untimed: disable any existing reminder for this cell
  if (!time24) {
    try {
      await reminders.updateMany(
        { userId: user._id, cell: input.cell, enabled: true, sentAt: null },
        {
          $set: {
            enabled: false,
            discardedAt: now,
            discardReason: "time_removed",
            updatedAt: now,
          },
          $unset: { processingLockUntil: "" },
        },
      );
    } catch {
      // Best effort
    }
    return {
      reminderSet: false,
      titleWithTime: cleanTitle,
      cleanTitle,
    };
  }

  const timeFormatted = formatTime12h(time24);
  const titleWithTime = `${cleanTitle} ${timeFormatted}`;

  const userTimezone = user.dailyNotification?.timezone || DEFAULT_TIMEZONE || "Asia/Dhaka";

  // Resolve event date
  let eventDate = input.date;
  if (!eventDate) {
    const existing = await reminders.findOne({ userId: user._id, cell: input.cell });
    if (existing?.date) {
      eventDate = existing.date;
    } else {
      const zoned = getZonedParts(now, userTimezone);
      eventDate = `${zoned.year}-${String(zoned.month).padStart(2, "0")}-${String(zoned.day).padStart(2, "0")}`;
    }
  }

  const [targetYear, targetMonth, targetDay] = eventDate.split("-").map(Number);
  const [targetHour, targetMinute] = time24.split(":").map(Number);
  const eventUtc = zonedTimeToUtc(targetYear, targetMonth, targetDay, targetHour, targetMinute, userTimezone);
  const scheduledFor = new Date(eventUtc.getTime() - 5 * 60_000); // 5 minutes before event

  const reminderZoned = getZonedParts(scheduledFor, userTimezone);
  const reminderTime24 = `${String(reminderZoned.hour).padStart(2, "0")}:${String(reminderZoned.minute).padStart(2, "0")}`;
  const reminderTimeFormatted = formatTime12h(reminderTime24);

  // If reminder is already in the past, do not schedule or enable it
  if (scheduledFor.getTime() <= now.getTime()) {
    return {
      reminderSet: false,
      time24,
      timeFormatted,
      reminderTimeFormatted,
      titleWithTime,
      cleanTitle,
    };
  }

  const telegramChatId = user.telegram?.chatId ?? 0;

  const existing = await reminders.findOne({
    userId: user._id,
    cell: input.cell,
    sentAt: null,
  });

  if (existing) {
    await reminders.updateOne(
      { _id: existing._id },
      {
        $set: {
          telegramChatId: telegramChatId || existing.telegramChatId,
          title: cleanTitle,
          date: eventDate,
          time: time24,
          sheetLabel: titleWithTime.toUpperCase(),
          sheetId: input.sheetId ?? existing.sheetId,
          rowIndex: input.rowIndex ?? existing.rowIndex,
          timezone: userTimezone,
          scheduledFor,
          enabled: true,
          updatedAt: now,
        },
        $unset: { processingLockUntil: "", discardedAt: "", discardReason: "" },
      },
    );
  } else {
    const reminderDoc: TaskReminderDoc = {
      _id: new ObjectId(),
      userId: user._id,
      telegramChatId,
      title: cleanTitle,
      date: eventDate,
      time: time24,
      sheetLabel: titleWithTime.toUpperCase(),
      cell: input.cell,
      sheetId: input.sheetId,
      rowIndex: input.rowIndex,
      timezone: userTimezone,
      scheduledFor,
      enabled: true,
      sentAt: null,
      processingLockUntil: null,
      createdAt: now,
      updatedAt: now,
    };
    await reminders.insertOne(reminderDoc);
  }

  return {
    reminderSet: true,
    time24,
    timeFormatted,
    reminderTimeFormatted,
    scheduledFor,
    titleWithTime,
    cleanTitle,
  };
}

/**
 * Parses user input for the `/n` command.
 * Examples:
 * - "/n self advising at 3pm"
 * - "/n self advising at 3:00pm"
 * - "/n self advising at 15:00"
 * - "/n self advising at 03:00 PM"
 * - "/n self advising tomorrow at 3pm"
 * - "/n self advising at 3pm tomorrow"
 * - "/n gym at 18:30"
 */
export function parseReminderCommand(
  rawText: string,
  userTimezone: string = DEFAULT_TIMEZONE,
  now: Date = new Date(),
): ParseReminderResult {
  // Strip command prefix /n or /n@botname
  const body = rawText.replace(/^\/n(?:@\S+)?(?:\s+|$)/i, "").trim();
  if (!body) {
    return { success: false, error: "usage" };
  }

  // If body starts directly with "at" or "@" (e.g. "/n at 3pm"), task is missing
  if (/^(?:at|@)(?:\s+|$)/i.test(body)) {
    return { success: false, error: "missing_task" };
  }

  // Look for separator " at " or " @ "
  const atMatch = body.match(/^(.*?)\s+(?:at|@)\s+(.*)$/i);
  let taskPart = "";
  let timeAndDatePart = "";

  if (atMatch) {
    taskPart = atMatch[1].trim();
    timeAndDatePart = atMatch[2].trim();
  } else {
    // Fallback: check if the end of body is a time (e.g. "/n self advising 3pm")
    const trailingTimeMatch = body.match(/^(.*?)\s+(\d{1,2}(?:[:.]\d{2})?\s*(?:am|pm|a\.m\.|p\.m\.)?)$/i);
    if (trailingTimeMatch) {
      taskPart = trailingTimeMatch[1].trim();
      timeAndDatePart = trailingTimeMatch[2].trim();
    } else {
      return { success: false, error: "missing_time" };
    }
  }

  if (!taskPart || taskPart.toLowerCase() === "at" || taskPart === "@") {
    return { success: false, error: "missing_task" };
  }

  if (!timeAndDatePart) {
    return { success: false, error: "missing_time" };
  }

  // Extract date if explicitly mentioned in taskPart or timeAndDatePart
  const zonedNow = getZonedParts(now, userTimezone);
  const todayStr = `${zonedNow.year}-${String(zonedNow.month).padStart(2, "0")}-${String(zonedNow.day).padStart(2, "0")}`;
  const tomorrowApprox = new Date(Date.UTC(zonedNow.year, zonedNow.month - 1, zonedNow.day + 1));
  const tomorrowStr = tomorrowApprox.toISOString().slice(0, 10);

  let targetDate = todayStr;
  let isTomorrow = false;

  const combined = `${taskPart} ${timeAndDatePart}`.toLowerCase();
  if (/\btomorrow\b/i.test(combined)) {
    targetDate = tomorrowStr;
    isTomorrow = true;
    taskPart = taskPart.replace(/\btomorrow\b/gi, "").trim();
    timeAndDatePart = timeAndDatePart.replace(/\btomorrow\b/gi, "").trim();
  } else if (/\btoday\b/i.test(combined)) {
    targetDate = todayStr;
    taskPart = taskPart.replace(/\btoday\b/gi, "").trim();
    timeAndDatePart = timeAndDatePart.replace(/\btoday\b/gi, "").trim();
  } else {
    // Check for explicit ISO date YYYY-MM-DD
    const isoMatch = combined.match(/\b(\d{4}-\d{2}-\d{2})\b/);
    if (isoMatch) {
      targetDate = isoMatch[1];
      taskPart = taskPart.replace(isoMatch[1], "").replace(/\bon\b/gi, "").trim();
      timeAndDatePart = timeAndDatePart.replace(isoMatch[1], "").replace(/\bon\b/gi, "").trim();
    }
  }

  // Strip dangling "on" or trailing punctuation from taskPart
  taskPart = taskPart.replace(/\s+on$/i, "").replace(/[,\s]+$/, "").trim();

  if (!taskPart) {
    return { success: false, error: "missing_task" };
  }

  // Parse time
  const time24 = parseTimeInput(timeAndDatePart);
  if (!time24) {
    return { success: false, error: "invalid_time" };
  }

  // Calculate target event time in UTC
  const [targetYear, targetMonth, targetDay] = targetDate.split("-").map(Number);
  const [targetHour, targetMinute] = time24.split(":").map(Number);
  const eventUtc = zonedTimeToUtc(targetYear, targetMonth, targetDay, targetHour, targetMinute, userTimezone);

  // Reminder scheduled for exactly 5 minutes before event
  const reminderUtc = new Date(eventUtc.getTime() - 5 * 60 * 1000);

  // Validation: Past times
  if (eventUtc.getTime() <= now.getTime()) {
    return {
      success: false,
      error: "past_time",
      timeFormatted: formatTime12h(time24),
    };
  }

  if (reminderUtc.getTime() <= now.getTime()) {
    return {
      success: false,
      error: "reminder_past",
      timeFormatted: formatTime12h(time24),
    };
  }

  // Format reminder time display in user's timezone
  const reminderZoned = getZonedParts(reminderUtc, userTimezone);
  const reminderTime24 = `${String(reminderZoned.hour).padStart(2, "0")}:${String(reminderZoned.minute).padStart(2, "0")}`;

  return {
    success: true,
    taskTitle: taskPart,
    date: targetDate,
    time24,
    eventUtc,
    scheduledFor: reminderUtc,
    timeFormatted: formatTime12h(time24),
    reminderTimeFormatted: formatTime12h(reminderTime24),
    isTomorrow,
  };
}

/**
 * Handles the `/n` Telegram command execution.
 */
export async function handleReminderCommand(
  user: UserDoc,
  chatId: number,
  text: string,
  now: Date = new Date(),
): Promise<void> {
  if (!user.sheetId) {
    await sendTelegramReply(
      chatId,
      "You do not have a connected planner yet. Please connect a Google Sheets planner in Excela setup first.",
    );
    return;
  }

  const timeZone = user.dailyNotification?.timezone || DEFAULT_TIMEZONE;
  const parsed = parseReminderCommand(text, timeZone, now);

  if (!parsed.success) {
    if (parsed.error === "past_time") {
      await sendTelegramReply(
        chatId,
        `${parsed.timeFormatted} has already passed today. Please specify another time.`,
      );
      return;
    }

    if (parsed.error === "reminder_past") {
      await sendTelegramReply(
        chatId,
        `${parsed.timeFormatted} is less than 5 minutes away. Please specify a time at least 5 minutes in the future.`,
      );
      return;
    }

    // Default usage message
    await sendTelegramReply(
      chatId,
      "Usage:\n/n task name at time\n\nExamples:\n/n self advising at 3pm\n/n gym at 18:30",
    );
    return;
  }

  const reminders = await taskRemindersCollection();

  // Idempotency check: check if an identical reminder is already pending
  const existingReminder = await reminders.findOne({
    userId: user._id,
    date: parsed.date,
    time: parsed.time24,
    title: { $regex: new RegExp(`^${parsed.taskTitle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i") },
    enabled: true,
    sentAt: null,
  });

  if (existingReminder) {
    const confirmation = parsed.isTomorrow
      ? `Added "${parsed.taskTitle}" for tomorrow at ${parsed.timeFormatted}.\nReminder set for ${parsed.reminderTimeFormatted}.`
      : `Added "${parsed.taskTitle}" at ${parsed.timeFormatted}.\nReminder set for ${parsed.reminderTimeFormatted}.`;
    await sendTelegramReply(chatId, confirmation);
    return;
  }

  // Create event in Google Sheets planner
  const titleWithTime = `${parsed.taskTitle} ${parsed.timeFormatted}`;
  let createRes;
  try {
    createRes = await createEvent(user, {
      course: "",
      title: titleWithTime,
      date: parsed.date,
    });
  } catch (err) {
    if (err instanceof PlannerError) {
      await sendTelegramReply(chatId, err.message);
      return;
    }
    console.error("Error creating planner event for /n:", err);
    await sendTelegramReply(chatId, "Could not add task to your planner. Please try again.");
    return;
  }

  // Store reminder record in MongoDB
  const reminderDoc: TaskReminderDoc = {
    _id: new ObjectId(),
    userId: user._id,
    telegramChatId: chatId,
    title: parsed.taskTitle,
    date: parsed.date,
    time: parsed.time24,
    sheetLabel: createRes.label,
    cell: createRes.cell,
    sheetId: createRes.sheetId,
    rowIndex: createRes.rowIndex,
    timezone: timeZone,
    scheduledFor: parsed.scheduledFor,
    enabled: true,
    sentAt: null,
    processingLockUntil: null,
    createdAt: now,
    updatedAt: now,
  };

  await reminders.insertOne(reminderDoc);

  // Send confirmation
  const confirmation = parsed.isTomorrow
    ? `Added "${parsed.taskTitle}" for tomorrow at ${parsed.timeFormatted}.\nReminder set for ${parsed.reminderTimeFormatted}.`
    : `Added "${parsed.taskTitle}" at ${parsed.timeFormatted}.\nReminder set for ${parsed.reminderTimeFormatted}.`;

  await sendTelegramReply(chatId, confirmation);
}

/**
 * Executes a controlled batch of due task reminders using atomic MongoDB claiming.
 */
export async function processDueReminders(
  maxBatch = 20,
  now: Date = new Date(),
): Promise<{ processed: number; discarded: number; errors: number }> {
  const reminders = await taskRemindersCollection();
  const users = await usersCollection();
  let processed = 0;
  let discarded = 0;
  let errors = 0;

  for (let i = 0; i < maxBatch; i++) {
    const lockUntil = new Date(now.getTime() + 5 * 60 * 1000); // 5-minute atomic claim lock

    // Atomically claim one due, unlocked reminder
    const reminder = await reminders.findOneAndUpdate(
      {
        enabled: true,
        scheduledFor: { $lte: now },
        sentAt: null,
        $or: [
          { processingLockUntil: { $exists: false } },
          { processingLockUntil: null },
          { processingLockUntil: { $lte: now } },
        ],
      },
      {
        $set: {
          processingLockUntil: lockUntil,
          updatedAt: now,
        },
      },
      { returnDocument: "after" },
    );

    if (!reminder) {
      break;
    }

    try {
      const user = await users.findOne({ _id: reminder.userId });
      if (!user || !user.telegram?.chatId) {
        await reminders.updateOne(
          { _id: reminder._id },
          {
            $set: { enabled: false, discardedAt: now, discardReason: "cancelled", updatedAt: now },
            $unset: { processingLockUntil: "" },
          },
        );
        discarded++;
        continue;
      }

      // Verify task still exists and is pending in Google Sheet
      if (user.sheetId) {
        try {
          const days = await getSchedule(user, reminder.date, reminder.date);
          const day = days.find((d) => d.date === reminder.date);

          if (!day) {
            // Day row not found -> event deleted
            await reminders.updateOne(
              { _id: reminder._id },
              {
                $set: { enabled: false, discardedAt: now, discardReason: "deleted", updatedAt: now },
                $unset: { processingLockUntil: "" },
              },
            );
            discarded++;
            continue;
          }

          // Search day slots for this event
          const targetCol = reminder.cell ? reminder.cell.charAt(0).toUpperCase() : null;
          let slot = targetCol ? day.slots.find((s) => s.column === targetCol) : null;

          if (!slot || !slot.text.toLowerCase().includes(reminder.title.toLowerCase())) {
            slot = day.slots.find((s) => s.text.toLowerCase().includes(reminder.title.toLowerCase())) ?? null;
          }

          if (!slot) {
            // Event deleted or moved
            await reminders.updateOne(
              { _id: reminder._id },
              {
                $set: { enabled: false, discardedAt: now, discardReason: "deleted", updatedAt: now },
                $unset: { processingLockUntil: "" },
              },
            );
            discarded++;
            continue;
          }

          if (slot.status === "completed") {
            // Task already completed before reminder time!
            await reminders.updateOne(
              { _id: reminder._id },
              {
                $set: { enabled: false, discardedAt: now, discardReason: "completed", updatedAt: now },
                $unset: { processingLockUntil: "" },
              },
            );
            discarded++;
            continue;
          }

          // Check if time changed in the planner slot
          const slotTime = extractTimeFromText(slot.text);
          if (slotTime && slotTime !== reminder.time) {
            // Time was changed! Do not fire old reminder
            await reminders.updateOne(
              { _id: reminder._id },
              {
                $set: { enabled: false, discardedAt: now, discardReason: "time_changed", updatedAt: now },
                $unset: { processingLockUntil: "" },
              },
            );
            discarded++;
            continue;
          }
        } catch (sheetErr) {
          console.error(`Error verifying Google Sheet for reminder ${reminder._id}:`, sheetErr);
          // Release lock so it can retry on next cron cycle
          await reminders.updateOne(
            { _id: reminder._id },
            { $unset: { processingLockUntil: "" } },
          );
          errors++;
          continue;
        }
      }

      // Send reminder notification via Telegram
      if (reminder.telegramChatId) {
        const message = `In 5 minutes you have ${reminder.title}.`;
        await sendTelegramReply(reminder.telegramChatId, message);
      }

      // Mark reminder sent
      await reminders.updateOne(
        { _id: reminder._id },
        {
          $set: {
            enabled: false,
            sentAt: now,
            updatedAt: now,
          },
          $unset: {
            processingLockUntil: "",
          },
        },
      );

      processed++;
    } catch (err) {
      console.error(`Error processing task reminder ${reminder._id}:`, err);
      errors++;
      await reminders.updateOne(
        { _id: reminder._id },
        { $unset: { processingLockUntil: "" } },
      );
    }
  }

  return { processed, discarded, errors };
}

/**
 * Disables any active reminders for a specific cell or event title when modified in Excela.
 */
export async function disableRemindersForCell(
  userId: ObjectId,
  sheetId: number,
  cell: string,
): Promise<void> {
  const reminders = await taskRemindersCollection();
  await reminders.updateMany(
    {
      userId,
      sheetId,
      cell,
      enabled: true,
      sentAt: null,
    },
    {
      $set: {
        enabled: false,
        discardedAt: new Date(),
        discardReason: "deleted",
        updatedAt: new Date(),
      },
      $unset: { processingLockUntil: "" },
    },
  );
}
