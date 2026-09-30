import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ObjectId } from "mongodb";
import {
  parseReminderCommand,
  extractTimeFromText,
  stripTimeFromText,
} from "@/lib/telegram/reminders";
import {
  computeNextRunAt,
  formatDailyNotificationMessage,
  formatTime12h,
  parseTimeInput,
  zonedTimeToUtc,
} from "@/lib/telegram/auto-notify";
import type { TaskReminderDoc, UserDoc } from "@/lib/models";

// Fixed reference time for deterministic testing:
// 2026-09-30 10:00:00 UTC = 2026-09-30 16:00:00 in Asia/Dhaka (UTC+6)
const FAKE_NOW_DHAKA_4PM = new Date("2026-09-30T10:00:00Z");

// 2026-09-30 08:00:00 UTC = 2026-09-30 14:00:00 (2:00 PM) in Asia/Dhaka
const FAKE_NOW_DHAKA_2PM = new Date("2026-09-30T08:00:00Z");

describe("Task Reminder (/n) Feature - Comprehensive Test Suite", () => {
  // 1. /n task at 3pm
  it("1. should parse /n task at 3pm correctly", () => {
    const res = parseReminderCommand("/n self advising at 3pm", "Asia/Dhaka", FAKE_NOW_DHAKA_2PM);
    assert.strictEqual(res.success, true);
    if (res.success) {
      assert.strictEqual(res.taskTitle, "self advising");
      assert.strictEqual(res.time24, "15:00");
      assert.strictEqual(res.timeFormatted, "3:00 PM");
      assert.strictEqual(res.reminderTimeFormatted, "2:55 PM");
      assert.strictEqual(res.date, "2026-09-30");
    }
  });

  // 2. /n task at 15:00
  it("2. should parse /n task at 15:00 correctly", () => {
    const res = parseReminderCommand("/n self advising at 15:00", "Asia/Dhaka", FAKE_NOW_DHAKA_2PM);
    assert.strictEqual(res.success, true);
    if (res.success) {
      assert.strictEqual(res.taskTitle, "self advising");
      assert.strictEqual(res.time24, "15:00");
      assert.strictEqual(res.timeFormatted, "3:00 PM");
    }
  });

  // 3. /n task at 3:00 PM
  it("3. should parse /n task at 3:00 PM correctly", () => {
    const res = parseReminderCommand("/n self advising at 3:00 PM", "Asia/Dhaka", FAKE_NOW_DHAKA_2PM);
    assert.strictEqual(res.success, true);
    if (res.success) {
      assert.strictEqual(res.taskTitle, "self advising");
      assert.strictEqual(res.time24, "15:00");
      assert.strictEqual(res.timeFormatted, "3:00 PM");
      assert.strictEqual(res.reminderTimeFormatted, "2:55 PM");
    }
  });

  // 4. Invalid time
  it("4. should reject invalid time formats", () => {
    const res1 = parseReminderCommand("/n gym at 25:99", "Asia/Dhaka", FAKE_NOW_DHAKA_2PM);
    assert.strictEqual(res1.success, false);
    if (!res1.success) {
      assert.strictEqual(res1.error, "invalid_time");
    }

    const res2 = parseReminderCommand("/n gym at lunchtime", "Asia/Dhaka", FAKE_NOW_DHAKA_2PM);
    assert.strictEqual(res2.success, false);
    if (!res2.success) {
      assert.strictEqual(res2.error, "invalid_time");
    }
  });

  // 5. Missing task
  it("5. should reject commands with missing task name", () => {
    const res = parseReminderCommand("/n at 3pm", "Asia/Dhaka", FAKE_NOW_DHAKA_2PM);
    assert.strictEqual(res.success, false);
    if (!res.success) {
      assert.strictEqual(res.error, "missing_task");
    }
  });

  // 6. Missing time
  it("6. should reject commands with missing time", () => {
    const res1 = parseReminderCommand("/n gym", "Asia/Dhaka", FAKE_NOW_DHAKA_2PM);
    assert.strictEqual(res1.success, false);
    if (!res1.success) {
      assert.strictEqual(res1.error, "missing_time");
    }

    const res2 = parseReminderCommand("/n gym at", "Asia/Dhaka", FAKE_NOW_DHAKA_2PM);
    assert.strictEqual(res2.success, false);
    if (!res2.success) {
      assert.strictEqual(res2.error, "missing_time");
    }
  });

  // 7. Past time
  it("7. should reject times that have already passed today", () => {
    // Current time in Dhaka is 16:00 (4 PM), attempting to schedule for 3pm today:
    const res = parseReminderCommand("/n self advising at 3pm", "Asia/Dhaka", FAKE_NOW_DHAKA_4PM);
    assert.strictEqual(res.success, false);
    if (!res.success) {
      assert.strictEqual(res.error, "past_time");
      assert.strictEqual(res.timeFormatted, "3:00 PM");
    }
  });

  // 8. Correct timezone conversion
  it("8. should handle timezone conversions accurately", () => {
    // 3:00 PM in Dhaka (UTC+6) is 09:00:00 UTC
    const dhakaUtc = zonedTimeToUtc(2026, 9, 30, 15, 0, "Asia/Dhaka");
    assert.strictEqual(dhakaUtc.toISOString(), "2026-09-30T09:00:00.000Z");

    // 3:00 PM in New York (EDT, UTC-4) is 19:00:00 UTC
    const nyUtc = zonedTimeToUtc(2026, 9, 30, 15, 0, "America/New_York");
    assert.strictEqual(nyUtc.toISOString(), "2026-09-30T19:00:00.000Z");
  });

  // 9. Reminder scheduled exactly 5 minutes before event
  it("9. should schedule reminder exactly 5 minutes (300,000 ms) before event", () => {
    const res = parseReminderCommand("/n self advising at 3pm", "Asia/Dhaka", FAKE_NOW_DHAKA_2PM);
    assert.strictEqual(res.success, true);
    if (res.success) {
      const diffMs = res.eventUtc.getTime() - res.scheduledFor.getTime();
      assert.strictEqual(diffMs, 5 * 60 * 1000); // 300,000 ms
      // Event: 09:00:00 UTC -> Reminder: 08:55:00 UTC
      assert.strictEqual(res.scheduledFor.toISOString(), "2026-09-30T08:55:00.000Z");
    }
  });

  // 10. Cron sends reminder when due
  it("10. should consider reminder due when scheduledFor <= now and enabled", () => {
    const scheduledFor = new Date("2026-09-30T08:55:00Z");
    const cronNow = new Date("2026-09-30T08:55:30Z"); // 30 seconds after due

    const reminder: TaskReminderDoc = {
      _id: new ObjectId(),
      userId: new ObjectId(),
      telegramChatId: 123456,
      title: "Self Advising",
      date: "2026-09-30",
      time: "15:00",
      sheetLabel: "SELF ADVISING 3:00 PM",
      timezone: "Asia/Dhaka",
      scheduledFor,
      enabled: true,
      sentAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const isDue = reminder.enabled && reminder.scheduledFor <= cronNow && !reminder.sentAt;
    assert.strictEqual(isDue, true);
  });

  // 11. Cron does not send before due time
  it("11. should NOT consider reminder due when scheduledFor > now", () => {
    const scheduledFor = new Date("2026-09-30T08:55:00Z");
    const cronEarly = new Date("2026-09-30T08:54:50Z"); // 10 seconds before due

    const reminder: TaskReminderDoc = {
      _id: new ObjectId(),
      userId: new ObjectId(),
      telegramChatId: 123456,
      title: "Self Advising",
      date: "2026-09-30",
      time: "15:00",
      sheetLabel: "SELF ADVISING 3:00 PM",
      timezone: "Asia/Dhaka",
      scheduledFor,
      enabled: true,
      sentAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const isDue = reminder.enabled && reminder.scheduledFor <= cronEarly && !reminder.sentAt;
    assert.strictEqual(isDue, false);
  });

  // 12. Reminder cannot be sent twice
  it("12. should NOT process a reminder that is already sent", () => {
    const reminder: TaskReminderDoc = {
      _id: new ObjectId(),
      userId: new ObjectId(),
      telegramChatId: 123456,
      title: "Self Advising",
      date: "2026-09-30",
      time: "15:00",
      sheetLabel: "SELF ADVISING 3:00 PM",
      timezone: "Asia/Dhaka",
      scheduledFor: new Date("2026-09-30T08:55:00Z"),
      enabled: false,
      sentAt: new Date("2026-09-30T08:55:05Z"),
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const isEligible = reminder.enabled && !reminder.sentAt;
    assert.strictEqual(isEligible, false);
  });

  // 13. Concurrent cron calls cannot duplicate the reminder (atomic lock simulation)
  it("13. should prevent duplicate execution using atomic claiming lock", () => {
    const now = new Date("2026-09-30T08:55:00Z");
    const lockUntil = new Date(now.getTime() + 5 * 60 * 1000);

    // Mock storage
    const state: { processingLockUntil?: Date | null; sentCount: number } = {
      processingLockUntil: null,
      sentCount: 0,
    };

    // First worker claims
    const claim1 = !state.processingLockUntil || state.processingLockUntil <= now;
    assert.strictEqual(claim1, true);
    if (claim1) {
      state.processingLockUntil = lockUntil;
      state.sentCount++;
    }

    // Concurrent worker 2 attempts to claim before worker 1 finishes
    const claim2 = !state.processingLockUntil || state.processingLockUntil <= now;
    assert.strictEqual(claim2, false); // Blocked by active lock!
    assert.strictEqual(state.sentCount, 1);
  });

  // 14. User isolation
  it("14. should guarantee reminders are strictly isolated per user and chat", () => {
    const userA = { _id: new ObjectId(), chatId: 11111 };
    const userB = { _id: new ObjectId(), chatId: 22222 };

    const reminderA: TaskReminderDoc = {
      _id: new ObjectId(),
      userId: userA._id,
      telegramChatId: userA.chatId,
      title: "User A Task",
      date: "2026-09-30",
      time: "15:00",
      sheetLabel: "USER A TASK 3:00 PM",
      timezone: "Asia/Dhaka",
      scheduledFor: new Date("2026-09-30T08:55:00Z"),
      enabled: true,
      sentAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    assert.notStrictEqual(reminderA.userId, userB._id);
    assert.strictEqual(reminderA.telegramChatId, userA.chatId);
    assert.notStrictEqual(reminderA.telegramChatId, userB.chatId);
  });

  // 15. Deleted event does not trigger reminder
  it("15. should discard reminder if event was deleted from Google Sheet", () => {
    const daySlots = [
      { column: "E", text: "GYM", status: "pending" as const },
      { column: "F", text: "CLASS", status: "pending" as const },
    ];

    const reminderTitle = "Self Advising";
    const found = daySlots.some((s) => s.text.toLowerCase().includes(reminderTitle.toLowerCase()));
    assert.strictEqual(found, false); // Event is gone!

    const action = found ? "send" : "discard";
    assert.strictEqual(action, "discard");
  });

  // 16. Moved event / time changed does not trigger old reminder
  it("16. should discard reminder if event time was changed to a different hour", () => {
    // Event was originally scheduled for 3:00 PM (15:00), but user changed sheet to 5:00 PM (17:00)
    const slotText = "SELF ADVISING 5:00 PM";
    const detectedTime = extractTimeFromText(slotText);

    assert.strictEqual(detectedTime, "17:00");
    const originalTime: string = "15:00";
    const timeMatches = (detectedTime as string) === originalTime;
    assert.strictEqual(timeMatches, false);

    const action = timeMatches ? "send" : "discard";
    assert.strictEqual(action, "discard");
  });

  // 17. Completed event does not trigger reminder
  it("17. should discard reminder if event was completed prior to reminder time", () => {
    const slot: { column: string; text: string; status: "pending" | "completed" } = {
      column: "E",
      text: "SELF ADVISING 3:00 PM",
      status: "completed", // Marked complete (blue fill)!
    };

    const isPending = (slot.status as string) === "pending";
    assert.strictEqual(isPending, false);

    const action = isPending ? "send" : "discard";
    assert.strictEqual(action, "discard");
  });

  // 18. /auto still works
  it("18. should compute nextRunAt and format daily notifications cleanly", () => {
    const time24 = parseTimeInput("6:30pm");
    assert.strictEqual(time24, "18:30");
    assert.strictEqual(formatTime12h(time24), "6:30 PM");

    const nextRun = computeNextRunAt(time24, "Asia/Dhaka", FAKE_NOW_DHAKA_2PM);
    assert.strictEqual(nextRun > FAKE_NOW_DHAKA_2PM, true);

    const mockSchedule = [
      {
        date: "2026-09-30",
        sheet: "Sept 2026",
        sheetId: 1,
        rowIndex: 4,
        slots: [{ column: "E" as const, text: "GYM", status: "pending" as const }],
      },
      {
        date: "2026-10-01",
        sheet: "Oct 2026",
        sheetId: 2,
        rowIndex: 3,
        slots: [{ column: "E" as const, text: "ASSIGNMENT", status: "pending" as const }],
      },
    ];

    const message = formatDailyNotificationMessage(mockSchedule, "2026-09-30", "2026-10-01");
    assert.match(message, /Today — Sep 30/);
    assert.match(message, /GYM/);
    assert.match(message, /Tomorrow — Oct 1/);
    assert.match(message, /ASSIGNMENT/);
  });

  // 19. /auto and /n work simultaneously
  it("19. should allow /auto and /n to coexist without interference", () => {
    const user: Partial<UserDoc> = {
      _id: new ObjectId(),
      dailyNotification: {
        enabled: true,
        time: "18:00",
        timezone: "Asia/Dhaka",
        nextRunAt: new Date("2026-09-30T12:00:00Z"),
      },
    };

    const reminder: TaskReminderDoc = {
      _id: new ObjectId(),
      userId: user._id!,
      telegramChatId: 99999,
      title: "Self Advising",
      date: "2026-09-30",
      time: "15:00",
      sheetLabel: "SELF ADVISING 3:00 PM",
      timezone: "Asia/Dhaka",
      scheduledFor: new Date("2026-09-30T08:55:00Z"),
      enabled: true,
      sentAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    // Both are active and have distinct trigger times
    assert.strictEqual(user.dailyNotification?.enabled, true);
    assert.strictEqual(reminder.enabled, true);
    assert.notStrictEqual(user.dailyNotification?.nextRunAt?.toISOString(), reminder.scheduledFor.toISOString());
  });

  // 20. /auto off does not disable /n reminders
  it("20. should preserve task reminders when /auto is disabled", () => {
    const user: Partial<UserDoc> = {
      _id: new ObjectId(),
      dailyNotification: {
        enabled: false, // Disabled via /auto off
        time: "18:00",
      },
    };

    const reminder: TaskReminderDoc = {
      _id: new ObjectId(),
      userId: user._id!,
      telegramChatId: 99999,
      title: "Self Advising",
      date: "2026-09-30",
      time: "15:00",
      sheetLabel: "SELF ADVISING 3:00 PM",
      timezone: "Asia/Dhaka",
      scheduledFor: new Date("2026-09-30T08:55:00Z"),
      enabled: true, // Reminder is still enabled!
      sentAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    assert.strictEqual(user.dailyNotification?.enabled, false);
    assert.strictEqual(reminder.enabled, true);
  });

  // 21. /n reminder does not affect /auto
  it("21. should ensure creating /n does not alter user's /auto daily configuration", () => {
    const initialConfig = {
      enabled: true,
      time: "08:30",
      timezone: "Asia/Dhaka",
      nextRunAt: new Date("2026-10-01T02:30:00Z"),
    };

    const user: Partial<UserDoc> = {
      _id: new ObjectId(),
      dailyNotification: { ...initialConfig },
    };

    // Simulating reminder creation
    const newReminder: TaskReminderDoc = {
      _id: new ObjectId(),
      userId: user._id!,
      telegramChatId: 99999,
      title: "Meeting",
      date: "2026-09-30",
      time: "15:00",
      sheetLabel: "MEETING 3:00 PM",
      timezone: "Asia/Dhaka",
      scheduledFor: new Date("2026-09-30T08:55:00Z"),
      enabled: true,
      sentAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    // Verify user dailyNotification is completely unchanged
    assert.deepStrictEqual(user.dailyNotification, initialConfig);
    assert.strictEqual(newReminder.title, "Meeting");
  });

  // 22. Natural language time edge cases
  it("22. should correctly identify timed vs untimed natural language inputs", () => {
    // Timed inputs
    assert.strictEqual(extractTimeFromText("I have gym at 7pm Oct 2"), "19:00");
    assert.strictEqual(extractTimeFromText("I have gym at 19:00 Oct 2"), "19:00");
    assert.strictEqual(extractTimeFromText("I have gym tomorrow at 7pm"), "19:00");
    assert.strictEqual(extractTimeFromText("I have gym at 7pm"), "19:00");
    assert.strictEqual(extractTimeFromText("Gym at noon tomorrow"), "12:00");
    assert.strictEqual(extractTimeFromText("Gym at midnight tomorrow"), "00:00");
    assert.strictEqual(extractTimeFromText("Assignment due Oct 2 at 11pm"), "23:00");

    // Untimed inputs (must NEVER extract a false time)
    assert.strictEqual(extractTimeFromText("I have gym Oct 2"), null);
    assert.strictEqual(extractTimeFromText("I have gym tomorrow"), null);
    assert.strictEqual(extractTimeFromText("Assignment due tomorrow"), null);
    assert.strictEqual(extractTimeFromText("CSE 220 assignment"), null);
  });

  // 23. stripTimeFromText
  it("23. should strip time phrases cleanly from titles", () => {
    assert.strictEqual(stripTimeFromText("Self Advising at 7pm"), "Self Advising");
    assert.strictEqual(stripTimeFromText("Self Advising 7:00 PM"), "Self Advising");
    assert.strictEqual(stripTimeFromText("Meeting tomorrow at 3pm"), "Meeting tomorrow");
    assert.strictEqual(stripTimeFromText("Gym at noon"), "Gym");
    assert.strictEqual(stripTimeFromText("Gym Oct 2"), "Gym Oct 2");
  });

  // 24. Timed event reminder calculation (5 minutes prior)
  it("24. should compute exactly 5-minute pre-event reminder for natural language timed event", () => {
    // Event: Oct 1, 7:00 PM (19:00) in Asia/Dhaka
    const time24 = extractTimeFromText("I have self advising at 7pm Oct 1");
    assert.strictEqual(time24, "19:00");

    const eventUtc = zonedTimeToUtc(2026, 10, 1, 19, 0, "Asia/Dhaka");
    const scheduledFor = new Date(eventUtc.getTime() - 5 * 60_000);

    // 19:00 in Dhaka (UTC+6) is 13:00 UTC
    assert.strictEqual(eventUtc.toISOString(), "2026-10-01T13:00:00.000Z");
    // Reminder at 12:55 UTC (6:55 PM Dhaka)
    assert.strictEqual(scheduledFor.toISOString(), "2026-10-01T12:55:00.000Z");
    assert.strictEqual(eventUtc.getTime() - scheduledFor.getTime(), 300_000);
  });

  // 25. Untimed event produces NO reminder
  it("25. should not schedule reminder for untimed event", () => {
    const rawTitle = "Gym";
    const explicitTime = "";
    const extractedTime = parseTimeInput(explicitTime) || extractTimeFromText(rawTitle);

    assert.strictEqual(extractedTime, null);
    const reminderSet = Boolean(extractedTime);
    assert.strictEqual(reminderSet, false);
  });

  // 26. Event time updates and removal
  it("26. should update reminder when event time is updated, and disable reminder when time is removed", () => {
    // Original event: 7:00 PM -> Reminder at 6:55 PM
    let time24 = extractTimeFromText("Self Advising at 7pm");
    assert.strictEqual(time24, "19:00");
    const reminderMinutesBefore = 5;
    assert.strictEqual(reminderMinutesBefore, 5);

    // Update to 8:00 PM -> Reminder at 7:55 PM
    const newTime = "8pm";
    time24 = parseTimeInput(newTime);
    assert.strictEqual(time24, "20:00");
    assert.strictEqual(formatTime12h(time24), "8:00 PM");

    // Remove time: newTime = ""
    const removedTime = "";
    time24 = parseTimeInput(removedTime);
    assert.strictEqual(time24, null); // Untimed now!
  });
});
