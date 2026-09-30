import type { UserDoc } from "@/lib/models";
import { PlannerError, createEvent, checkConflicts } from "@/lib/planner-service";
import { resolveRelativeDate } from "@/lib/agent/dates";
import {
  extractTimeFromText,
  formatTime12h,
  parseTimeInput,
  stripTimeFromText,
  syncReminderForEvent,
} from "@/lib/telegram/reminders";

export const createEventTool = {
  type: "function",
  function: {
    name: "create_event",
    description: "Add a new event to the user's planner on a specific date. Only call this once you have a title and a real date; never invent a date. If the user specified an explicit clock time (e.g. '7pm', '7:00 PM', '19:00', '18:30', 'noon'), pass it in 'time'. If the event has no time (e.g. 'Gym Oct 2', 'Assignment due tomorrow'), leave 'time' empty. The tool automatically schedules a 5-minute reminder when an explicit time is provided.",
    parameters: {
      type: "object",
      properties: {
        course: { type: "string", description: "Course code, e.g. 'CSE340'. Use an empty string if there isn't one." },
        title: { type: "string", description: "Short event title, e.g. 'Quiz 4' or 'Self Advising'." },
        date: { type: "string", description: "YYYY-MM-DD. Resolve relative words using the date table you were given before calling this." },
        time: { type: "string", description: "Explicit clock time if specified by the user (e.g. '7pm', '7:00 PM', '19:00', '18:30', 'noon'). Leave empty if the user did NOT specify a time." },
      },
      required: ["title", "date"],
      additionalProperties: false,
    },
  },
} as const;

export async function runCreateEvent(user: UserDoc, today: string, args: Record<string, unknown>) {
  const rawTitle = typeof args.title === "string" ? args.title : "";
  const course = typeof args.course === "string" ? args.course : "";
  const explicitTime = typeof args.time === "string" ? args.time : "";
  const date = resolveRelativeDate(args.date, today);
  if (!date) throw new PlannerError("The date must be YYYY-MM-DD. Resolve any relative date first, then call create_event again.", "invalid_date");

  // Determine if there is an explicit clock time
  let time24 = parseTimeInput(explicitTime);
  if (!time24) {
    time24 = extractTimeFromText(rawTitle);
  }
  const cleanTitle = stripTimeFromText(rawTitle) || rawTitle.trim();
  const titleToStore = time24 ? `${cleanTitle} ${formatTime12h(time24)}` : cleanTitle;

  // Check for existing events on the target date (for conflict awareness)
  const conflicts = await checkConflicts(user, date);
  const result = await createEvent(user, { course, title: titleToStore, date });

  let reminderSet = false;
  let reminderTimeFormatted: string | undefined;

  if (result.status === "created" && result.cell) {
    const syncRes = await syncReminderForEvent(user, {
      cell: result.cell,
      sheetId: result.sheetId,
      rowIndex: result.rowIndex,
      date: result.date,
      rawTitle: titleToStore,
      explicitTime: time24,
    });
    reminderSet = syncRes.reminderSet;
    reminderTimeFormatted = syncRes.reminderTimeFormatted;
  }

  // Enrich the result with conflict and reminder information
  return {
    ...result,
    existingEventsOnDate: conflicts.existingEvents.map(({ text, status }) => ({ text, status })),
    slotsUsed: conflicts.slotsUsed + (result.status === "created" ? 1 : 0),
    slotsFree: conflicts.slotsFree - (result.status === "created" ? 1 : 0),
    hasTime: Boolean(time24),
    time: time24 ? formatTime12h(time24) : null,
    reminderSet,
    reminderTime: reminderTimeFormatted,
  };
}
