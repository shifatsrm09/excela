import type { UserDoc } from "@/lib/models";
import { PlannerError, updateEvent } from "@/lib/planner-service";
import {
  extractTimeFromText,
  formatTime12h,
  parseTimeInput,
  stripTimeFromText,
  syncReminderForEvent,
} from "@/lib/telegram/reminders";

export const updateEventTool = {
  type: "function",
  function: {
    name: "update_event",
    description: "Update an existing event's title, time, or course. Pass the cell and sheetId (from find_event or a previous tool result in the conversation), plus the newTitle. If updating or adding a clock time, pass it in 'newTime' (e.g. '8pm', '20:00'). If removing the time to make the event untimed, pass empty string ''. The reminder automatically updates or removes accordingly.",
    parameters: {
      type: "object",
      properties: {
        cell: { type: "string", description: "The cell reference from find_event (e.g. 'E5')." },
        sheetId: { type: "number", description: "The sheetId from find_event result." },
        newTitle: { type: "string", description: "The new event title." },
        newTime: { type: "string", description: "New clock time (e.g. '8pm', '20:00'). Pass '' if removing the time." },
        date: { type: "string", description: "The date of the event (YYYY-MM-DD) from find_event if known." },
        newCourse: { type: "string", description: "The new course code. Use empty string if none." },
      },
      required: ["cell", "sheetId", "newTitle"],
      additionalProperties: false,
    },
  },
} as const;

export async function runUpdateEvent(user: UserDoc, today: string, args: Record<string, unknown>) {
  const cell = typeof args.cell === "string" ? args.cell : "";
  const sheetId = typeof args.sheetId === "number" ? args.sheetId : NaN;
  const newTitle = typeof args.newTitle === "string" ? args.newTitle : "";
  const newCourse = typeof args.newCourse === "string" ? args.newCourse : "";
  const rawNewTime = typeof args.newTime === "string" ? args.newTime : (typeof args.time === "string" ? args.time : undefined);
  const date = typeof args.date === "string" ? args.date : undefined;

  if (!cell || !Number.isFinite(sheetId) || !newTitle.trim()) {
    throw new PlannerError("Cell, sheetId, and newTitle are required. Use find_event first.", "invalid_args");
  }

  // Determine time:
  // If rawNewTime is empty string or explicit "none", time is removed.
  // Otherwise parse rawNewTime, or extract from newTitle.
  let time24: string | null = null;
  if (rawNewTime !== undefined) {
    const trimmed = rawNewTime.trim().toLowerCase();
    if (trimmed !== "" && trimmed !== "none" && trimmed !== "no time") {
      time24 = parseTimeInput(trimmed);
    }
  } else {
    time24 = extractTimeFromText(newTitle);
  }

  const cleanTitle = stripTimeFromText(newTitle) || newTitle.trim();
  const finalTitle = time24 ? `${cleanTitle} ${formatTime12h(time24)}` : cleanTitle;

  const res = await updateEvent(user, { cell, sheetId, newCourse, newTitle: finalTitle });

  const syncRes = await syncReminderForEvent(user, {
    cell,
    sheetId,
    date,
    rawTitle: finalTitle,
    explicitTime: time24,
  });

  return {
    ...res,
    hasTime: Boolean(time24),
    time: time24 ? formatTime12h(time24) : null,
    reminderSet: syncRes.reminderSet,
    reminderTime: syncRes.reminderTimeFormatted,
    reminderRemoved: !syncRes.reminderSet,
  };
}
