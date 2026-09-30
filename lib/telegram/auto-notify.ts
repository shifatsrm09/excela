import type { ObjectId } from "mongodb";
import type { DailyNotificationConfig } from "@/lib/models";
import { usersCollection } from "@/lib/mongodb";
import { getSchedule, type DayRow } from "@/lib/planner-service";
import { sendTelegramReply } from "@/lib/telegram/client";

export const DEFAULT_TIMEZONE = process.env.APP_TIMEZONE || "Asia/Dhaka";

/**
 * Parses user input into a normalized 24-hour "HH:mm" string.
 * Supports:
 * - "6pm", "6:30pm", "6.30pm", "6:30 pm", "6.30 pm", "6 pm", "6am", "6:30am", "6.30am"
 * - "6:45", "6.45", "18:30", "18.30", "09:00", "09.00", "9:00", "9.00", "9:30", "9.30"
 * - "12am", "12pm", "12:00am", "12.00am", "12:00pm", "12.00pm"
 * Returns null if invalid.
 */
export function parseTimeInput(raw: string): string | null {
  if (!raw || typeof raw !== "string") return null;
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === "noon") return "12:00";
  if (trimmed === "midnight") return "00:00";

  const match = trimmed.match(/^(\d{1,2})(?:[:.](\d{1,2}))?\s*(am|pm|a\.m\.|p\.m\.)?$/i);
  if (!match) return null;

  let hours = parseInt(match[1], 10);
  const minutes = match[2] !== undefined ? parseInt(match[2], 10) : 0;
  const rawMeridiem = match[3]?.toLowerCase().replace(/\./g, "");
  const meridiem = rawMeridiem === "am" || rawMeridiem === "pm" ? rawMeridiem : undefined;

  // Bare numbers without minutes or AM/PM (e.g. "2" in "Oct 2") are not valid times
  if (!meridiem && match[2] === undefined) {
    return null;
  }

  if (Number.isNaN(hours) || Number.isNaN(minutes) || minutes < 0 || minutes > 59) {
    return null;
  }

  if (meridiem) {
    if (hours < 1 || hours > 12) return null;
    if (meridiem === "pm" && hours < 12) {
      hours += 12;
    } else if (meridiem === "am" && hours === 12) {
      hours = 0;
    }
  } else {
    if (hours < 0 || hours > 23) return null;
  }

  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

/**
 * Formats a normalized 24-hour "HH:mm" time string into a 12-hour display string.
 * e.g. "18:30" -> "6:30 PM", "09:00" -> "9:00 AM"
 */
export function formatTime12h(time24: string): string {
  const [hStr, mStr] = time24.split(":");
  let h = parseInt(hStr, 10);
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12;
  if (h === 0) h = 12;
  return `${h}:${mStr} ${ampm}`;
}

/**
 * Extracts calendar date parts in a specific timezone using Intl.DateTimeFormat.
 */
export function getZonedParts(date: Date, timeZone: string) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = formatter.formatToParts(date);
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? "0";
  return {
    year: parseInt(part("year"), 10),
    month: parseInt(part("month"), 10),
    day: parseInt(part("day"), 10),
    hour: parseInt(part("hour"), 10) % 24,
    minute: parseInt(part("minute"), 10),
    second: parseInt(part("second"), 10),
  };
}

/**
 * Converts a calendar date/time in `timeZone` to a UTC Date.
 */
export function zonedTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  const approxUtc = new Date(Date.UTC(year, month - 1, day, hour, minute, 0));
  const zoned = getZonedParts(approxUtc, timeZone);
  const zonedAsUtc = new Date(Date.UTC(zoned.year, zoned.month - 1, zoned.day, zoned.hour, zoned.minute, zoned.second));
  const offset = approxUtc.getTime() - zonedAsUtc.getTime();
  return new Date(approxUtc.getTime() + offset);
}

/**
 * Computes the next run time in UTC for a daily "HH:mm" schedule in `timeZone`.
 */
export function computeNextRunAt(time: string, timeZone: string, fromDate = new Date()): Date {
  const [targetHour, targetMinute] = time.split(":").map(Number);
  const nowZoned = getZonedParts(fromDate, timeZone);

  let candidate = zonedTimeToUtc(nowZoned.year, nowZoned.month, nowZoned.day, targetHour, targetMinute, timeZone);
  if (candidate.getTime() <= fromDate.getTime()) {
    // Today's target time has already passed; advance to tomorrow
    const tomorrowApprox = new Date(candidate.getTime() + 24 * 3600 * 1000);
    const tomorrowZoned = getZonedParts(tomorrowApprox, timeZone);
    candidate = zonedTimeToUtc(tomorrowZoned.year, tomorrowZoned.month, tomorrowZoned.day, targetHour, targetMinute, timeZone);
  }
  return candidate;
}

/**
 * Sets or updates the user's daily notification schedule in MongoDB.
 */
export async function setDailyNotification(
  userId: ObjectId,
  time: string,
  timeZone = DEFAULT_TIMEZONE,
): Promise<DailyNotificationConfig> {
  const nextRunAt = computeNextRunAt(time, timeZone);
  const config: DailyNotificationConfig = {
    enabled: true,
    time,
    timezone: timeZone,
    nextRunAt,
  };
  const users = await usersCollection();
  await users.updateOne(
    { _id: userId },
    {
      $set: {
        dailyNotification: config,
        updatedAt: new Date(),
      },
    },
  );
  return config;
}

/**
 * Disables the user's daily notification schedule in MongoDB without deleting other data.
 */
export async function disableDailyNotification(userId: ObjectId): Promise<void> {
  const users = await usersCollection();
  await users.updateOne(
    { _id: userId },
    {
      $set: {
        "dailyNotification.enabled": false,
        updatedAt: new Date(),
      },
      $unset: {
        "dailyNotification.processingLockUntil": "",
      },
    },
  );
}

/**
 * Formats Today's and Tomorrow's schedules into the compact Telegram message format.
 */
export function formatDailyNotificationMessage(
  schedule: DayRow[],
  todayStr: string,
  tomorrowStr: string,
): string {
  const scheduleByDate = new Map(schedule.map((r) => [r.date, r.slots]));
  const todaySlots = scheduleByDate.get(todayStr) ?? [];
  const tomorrowSlots = scheduleByDate.get(tomorrowStr) ?? [];

  const formatSection = (label: "Today" | "Tomorrow", dateStr: string, slots: { text: string }[]) => {
    const dateObj = new Date(`${dateStr}T00:00:00Z`);
    const monthStr = dateObj.toLocaleDateString("en-US", { month: "short", timeZone: "UTC" });
    const dayNum = dateObj.getUTCDate();
    const header = `${label} — ${monthStr} ${dayNum}`;
    const texts = slots.map((s) => s.text).filter(Boolean);
    const content = texts.length > 0 ? texts.join(" | ") : "—";
    return `${header}\n${content}`;
  };

  return `${formatSection("Today", todayStr, todaySlots)}\n\n${formatSection("Tomorrow", tomorrowStr, tomorrowSlots)}`;
}

/**
 * Executes a controlled batch of due daily notifications using atomic MongoDB claiming.
 */
export async function processDueNotifications(maxBatch = 20): Promise<{ processed: number; errors: number }> {
  const users = await usersCollection();
  let processed = 0;
  let errors = 0;

  for (let i = 0; i < maxBatch; i++) {
    const now = new Date();
    const lockUntil = new Date(now.getTime() + 5 * 60 * 1000); // 5-minute atomic claim lock

    // Atomically claim one due, unlocked user
    const user = await users.findOneAndUpdate(
      {
        "dailyNotification.enabled": true,
        "dailyNotification.nextRunAt": { $lte: now },
        "telegram.chatId": { $exists: true },
        $or: [
          { "dailyNotification.processingLockUntil": { $exists: false } },
          { "dailyNotification.processingLockUntil": { $lte: now } },
        ],
      },
      {
        $set: {
          "dailyNotification.processingLockUntil": lockUntil,
        },
      },
      { returnDocument: "after" },
    );

    if (!user) {
      // No more users currently due
      break;
    }

    const timeZone = user.dailyNotification?.timezone || DEFAULT_TIMEZONE;
    const nextRun = computeNextRunAt(
      user.dailyNotification?.time || "09:00",
      timeZone,
      now,
    );

    try {
      if (!user.telegram?.chatId) {
        throw new Error("Missing telegram.chatId");
      }

      if (!user.sheetId) {
        throw new Error("No connected Google Sheets planner");
      }

      const zonedToday = getZonedParts(now, timeZone);
      const todayStr = `${zonedToday.year}-${String(zonedToday.month).padStart(2, "0")}-${String(zonedToday.day).padStart(2, "0")}`;
      const tomorrowDate = new Date(Date.UTC(zonedToday.year, zonedToday.month - 1, zonedToday.day + 1));
      const tomorrowStr = tomorrowDate.toISOString().slice(0, 10);

      const schedule = await getSchedule(user, todayStr, tomorrowStr);
      const message = formatDailyNotificationMessage(schedule, todayStr, tomorrowStr);

      await sendTelegramReply(user.telegram.chatId, message);

      await users.updateOne(
        { _id: user._id },
        {
          $set: {
            "dailyNotification.nextRunAt": nextRun,
            "dailyNotification.lastSentAt": now,
          },
          $unset: {
            "dailyNotification.processingLockUntil": "",
          },
        },
      );

      processed++;
    } catch (err) {
      console.error(`Error processing auto notification for user ${user._id} (${user.email}):`, err);
      errors++;

      // Advance schedule and clear lock so the user isn't stuck forever or causing infinite error retries
      await users.updateOne(
        { _id: user._id },
        {
          $set: {
            "dailyNotification.nextRunAt": nextRun,
          },
          $unset: {
            "dailyNotification.processingLockUntil": "",
          },
        },
      );
    }
  }

  return { processed, errors };
}
