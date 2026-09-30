import type { UserDoc } from "@/lib/models";
import { PlannerError, moveEvent } from "@/lib/planner-service";
import { resolveRelativeDate } from "@/lib/agent/dates";
import { syncReminderForEvent } from "@/lib/telegram/reminders";

export const moveEventTool = {
  type: "function",
  function: {
    name: "move_event",
    description: "Move an existing event to a different date. Pass the cell, sourceSheetId, sourceRowIndex, sourceDate, and text (from find_event or a previous tool result in the conversation), plus the target date.",
    parameters: {
      type: "object",
      properties: {
        cell: { type: "string", description: "Cell reference from find_event (e.g. 'E5')." },
        sourceSheetId: { type: "number", description: "sheetId from find_event." },
        sourceRowIndex: { type: "number", description: "rowIndex from find_event." },
        sourceDate: { type: "string", description: "The current date of the event (YYYY-MM-DD) from find_event." },
        text: { type: "string", description: "The event text from find_event." },
        targetDate: { type: "string", description: "The new date to move the event to (YYYY-MM-DD)." },
      },
      required: ["cell", "sourceSheetId", "sourceRowIndex", "sourceDate", "text", "targetDate"],
      additionalProperties: false,
    },
  },
} as const;

export async function runMoveEvent(user: UserDoc, today: string, args: Record<string, unknown>) {
  const cell = typeof args.cell === "string" ? args.cell : "";
  const sourceSheetId = typeof args.sourceSheetId === "number" ? args.sourceSheetId : NaN;
  const sourceRowIndex = typeof args.sourceRowIndex === "number" ? args.sourceRowIndex : NaN;
  const sourceDate = typeof args.sourceDate === "string" ? args.sourceDate : "";
  const text = typeof args.text === "string" ? args.text : "";
  const rawTargetDate = args.targetDate;
  const targetDate = resolveRelativeDate(rawTargetDate, today);
  if (!cell || !Number.isFinite(sourceSheetId) || !Number.isFinite(sourceRowIndex) || !sourceDate || !text || !targetDate) {
    throw new PlannerError("All fields are required. Use find_event first to get event details, then provide a valid target date.", "invalid_args");
  }
  const result = await moveEvent(user, { cell, sourceSheetId, sourceRowIndex, sourceDate, text, targetDate });

  let reminderSet = false;
  let timeFormatted: string | undefined;
  let reminderTimeFormatted: string | undefined;

  if (result.to.cell) {
    const syncRes = await syncReminderForEvent(user, {
      cell: result.to.cell,
      sheetId: result.to.sheetId,
      date: targetDate,
      rawTitle: text,
    });
    reminderSet = syncRes.reminderSet;
    timeFormatted = syncRes.timeFormatted;
    reminderTimeFormatted = syncRes.reminderTimeFormatted;
  }

  return {
    ...result,
    reminderSet,
    time: timeFormatted,
    reminderTime: reminderTimeFormatted,
  };
}
