import type { UserDoc } from "@/lib/models";
import { PlannerError, findEventsDetailed } from "@/lib/planner-service";
import { executeTool, type ToolCallLog } from "@/lib/agent/executor";
import { parseSmartInput, addDays } from "@/lib/agent/string-parser";

export class AgentError extends Error {
  constructor(message: string, readonly status = 502) { super(message); }
}

export type AgentMessage = { role: "system" | "user" | "assistant" | "tool"; content: string; tool_calls?: unknown; name?: string };

export type ToolRunner = {
  executeTool: (name: string, args: unknown, user: UserDoc, today: string) => Promise<unknown>;
  findEventsDetailed: typeof findEventsDetailed;
};

export const defaultToolRunner: ToolRunner = {
  executeTool,
  findEventsDetailed,
};

function formatDateReadable(dateStr: string): string {
  try {
    const [y, m, d] = dateStr.split("-").map(Number);
    const date = new Date(Date.UTC(y, m - 1, d));
    return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
  } catch {
    return dateStr;
  }
}

/**
 * Smart String Verification Agent:
 * Deterministically and smartly parses user natural-language requests into structured planner operations.
 * Extracts course codes, event titles, explicit dates (today, tomorrow, calendar dates, weekdays),
 * and times. Operates on the user's planner with full conflict checking, duplicate detection, and
 * automatic 5-minute pre-event reminders.
 */
export async function runSmartAgent(
  _apiKey: string | null | undefined,
  user: UserDoc,
  today: string,
  userMessage: string,
  history: AgentMessage[] = [],
  runner: ToolRunner = defaultToolRunner
): Promise<{ reply: string; log: ToolCallLog[]; history: AgentMessage[] }> {
  const intent = parseSmartInput(userMessage, today);
  const log: ToolCallLog[] = [];

  let reply = "";

  try {
    switch (intent.type) {
      case "CREATE_EVENT": {
        const toolName = "create_event";
        const args = {
          course: intent.course,
          title: intent.title,
          date: intent.date,
          time: intent.timeFormatted || "",
        };

        const result = (await runner.executeTool(toolName, args, user, today)) as {
          status: "created" | "duplicate";
          date: string;
          label: string;
          cell?: string;
          reminderSet?: boolean;
          reminderTime?: string;
          existingEventsOnDate?: { text: string; status: string }[];
          slotsUsed?: number;
          slotsFree?: number;
        };

        log.push({ name: toolName, args, ok: true, result });

        const isToday = intent.date === today;
        const isTomorrow = intent.date === addDays(today, 1);
        const dateDesc = isToday ? `today (${intent.date})` : isTomorrow ? `tomorrow (${intent.date})` : formatDateReadable(intent.date);

        if (result.status === "created") {
          let msg = `Added **${result.label}** to your planner for ${dateDesc}${result.cell ? ` (Cell ${result.cell})` : ""}.`;
          if (result.reminderSet && result.reminderTime) {
            msg += `\n⏰ In 5 minutes before the event (${result.reminderTime}), you will receive a Telegram reminder.`;
          }
          if (result.existingEventsOnDate && result.existingEventsOnDate.length > 0) {
            msg += `\n📅 You now have ${result.slotsUsed} event(s) on this date (${result.slotsFree} slots left).`;
          }
          reply = msg;
        } else if (result.status === "duplicate") {
          reply = `ℹ️ **${result.label}** is already on your planner for ${dateDesc}.`;
        }
        break;
      }

      case "GET_TODAY": {
        const toolName = "get_today_schedule";
        const args = {};
        const result = (await runner.executeTool(toolName, args, user, today)) as {
          date: string;
          items: { text: string; status: string }[];
        };
        log.push({ name: toolName, args, ok: true, result });

        if (!result.items.length) {
          reply = `You have nothing scheduled for today (${today}). Enjoy your day!`;
        } else {
          reply = `Here is your schedule for today (${today}):\n\n` +
            result.items.map((item, idx) => `${idx + 1}. [${item.status.toUpperCase()}] ${item.text}`).join("\n");
        }
        break;
      }

      case "GET_TOMORROW": {
        const toolName = "get_schedule";
        const args = { from: intent.date, to: intent.date };
        const result = (await runner.executeTool(toolName, args, user, today)) as {
          date: string;
          slots: { text: string; status: string }[];
        }[];
        log.push({ name: toolName, args, ok: true, result });

        const day = result[0];
        if (!day || !day.slots.length) {
          reply = `You have nothing scheduled for tomorrow (${intent.date}).`;
        } else {
          reply = `Here is your schedule for tomorrow (${intent.date}):\n\n` +
            day.slots.map((item, idx) => `${idx + 1}. [${item.status.toUpperCase()}] ${item.text}`).join("\n");
        }
        break;
      }

      case "GET_WEEK": {
        const toolName = "get_week_schedule";
        const args = {};
        const result = (await runner.executeTool(toolName, args, user, today)) as {
          date: string;
          slots: { text: string; status: string }[];
        }[];
        log.push({ name: toolName, args, ok: true, result });

        const daysWithEvents = result.filter((day) => day.slots.length > 0);
        if (!daysWithEvents.length) {
          reply = "You have no events scheduled for the next 7 days.";
        } else {
          reply = `Here is your schedule for this week:\n\n` +
            daysWithEvents
              .map((day) => `📅 **${formatDateReadable(day.date)}**:\n` + day.slots.map((s) => `  • [${s.status.toUpperCase()}] ${s.text}`).join("\n"))
              .join("\n\n");
        }
        break;
      }

      case "GET_DEADLINES": {
        const toolName = "get_deadlines";
        const args = {};
        const result = (await runner.executeTool(toolName, args, user, today)) as {
          date: string;
          slots: { text: string; status: string }[];
        }[];
        log.push({ name: toolName, args, ok: true, result });

        const daysWithDeadlines = result.filter((day) => day.slots.length > 0);
        if (!daysWithDeadlines.length) {
          reply = "You have no upcoming deadlines in the next 14 days!";
        } else {
          reply = `Here are your upcoming deadlines:\n\n` +
            daysWithDeadlines
              .map((day) => `📅 **${formatDateReadable(day.date)}**:\n` + day.slots.map((s) => `  • ${s.text}`).join("\n"))
              .join("\n\n");
        }
        break;
      }

      case "GET_UNFINISHED": {
        const toolName = "get_unfinished_events";
        const args = {};
        const result = (await runner.executeTool(toolName, args, user, today)) as {
          date: string;
          slots: { text: string; status: string }[];
        }[];
        log.push({ name: toolName, args, ok: true, result });

        const daysWithUnfinished = result.filter((day) => day.slots.length > 0);
        if (!daysWithUnfinished.length) {
          reply = "You have no pending unfinished tasks from the past 30 days!";
        } else {
          reply = `Here are your unfinished tasks from the past 30 days:\n\n` +
            daysWithUnfinished
              .map((day) => `📅 **${formatDateReadable(day.date)}**:\n` + day.slots.map((s) => `  • ${s.text}`).join("\n"))
              .join("\n\n");
        }
        break;
      }

      case "FIND_EVENT": {
        const toolName = "find_event";
        const args = { query: intent.query };
        const result = (await runner.executeTool(toolName, args, user, today)) as {
          totalMatches: number;
          matches: { date: string; cell: string; text: string; status: string }[];
        };
        log.push({ name: toolName, args, ok: true, result });

        if (result.totalMatches === 0) {
          reply = `No events found matching "${intent.query}".`;
        } else {
          reply = `Found ${result.totalMatches} event(s) matching "${intent.query}":\n\n` +
            result.matches.map((m) => `• **${m.text}** on ${formatDateReadable(m.date)} (Cell ${m.cell}, ${m.status.toUpperCase()})`).join("\n");
        }
        break;
      }

      case "MARK_COMPLETE": {
        const fromDate = addDays(today, -30);
        const toDate = addDays(today, 60);
        const matches = await runner.findEventsDetailed(user, intent.targetText, fromDate, toDate);
        if (!matches.length) {
          reply = `Could not find an event matching "${intent.targetText}" to mark complete.`;
        } else {
          const match = matches[0];
          const toolName = "mark_complete";
          const args = { cell: match.cell, sheetId: match.sheetId };
          const result = await runner.executeTool(toolName, args, user, today);
          log.push({ name: toolName, args, ok: true, result });
          reply = `Marked **${match.text}** on ${formatDateReadable(match.date)} as completed! 🎉`;
        }
        break;
      }

      case "MARK_INCOMPLETE": {
        const fromDate = addDays(today, -30);
        const toDate = addDays(today, 60);
        const matches = await runner.findEventsDetailed(user, intent.targetText, fromDate, toDate);
        if (!matches.length) {
          reply = `Could not find an event matching "${intent.targetText}" to mark pending.`;
        } else {
          const match = matches[0];
          const toolName = "mark_incomplete";
          const args = { cell: match.cell, sheetId: match.sheetId };
          const result = await runner.executeTool(toolName, args, user, today);
          log.push({ name: toolName, args, ok: true, result });
          reply = `Marked **${match.text}** on ${formatDateReadable(match.date)} as pending.`;
        }
        break;
      }

      case "DELETE_EVENT": {
        const fromDate = addDays(today, -30);
        const toDate = addDays(today, 60);
        const matches = await runner.findEventsDetailed(user, intent.targetText, fromDate, toDate);
        if (!matches.length) {
          reply = `Could not find an event matching "${intent.targetText}" to delete.`;
        } else {
          const match = matches[0];
          const toolName = "delete_event";
          const args = { cell: match.cell, sheetId: match.sheetId };
          const result = await runner.executeTool(toolName, args, user, today);
          log.push({ name: toolName, args, ok: true, result });
          reply = `Deleted **${match.text}** from your planner (${formatDateReadable(match.date)}, Cell ${match.cell}).`;
        }
        break;
      }

      case "MOVE_EVENT": {
        const fromDate = addDays(today, -30);
        const toDate = addDays(today, 60);
        const matches = await runner.findEventsDetailed(user, intent.targetText, fromDate, toDate);
        if (!matches.length) {
          reply = `Could not find an event matching "${intent.targetText}" to move.`;
        } else {
          const match = matches[0];
          const toolName = "move_event";
          const args = {
            cell: match.cell,
            sourceSheetId: match.sheetId,
            sourceRowIndex: match.rowIndex,
            sourceDate: match.date,
            text: match.text,
            targetDate: intent.targetDate,
          };
          const result = await runner.executeTool(toolName, args, user, today);
          log.push({ name: toolName, args, ok: true, result });
          reply = `Moved **${match.text}** to ${formatDateReadable(intent.targetDate)}.`;
        }
        break;
      }

      case "HELP":
      default: {
        reply = "Hi! I'm Excela, your smart planner assistant.\n\n" +
          "You can chat with me naturally to manage your planner:\n" +
          "• **Add timed tasks**: `I have self advising at 7pm tomorrow`\n" +
          "• **Add academic tasks**: `CSE340 Quiz 2 on Friday at 3pm`\n" +
          "• **Add untimed tasks**: `Gym Oct 2` or `Assignment due tomorrow`\n" +
          "• **Check schedule**: `What do I have today?` or `What's on this week?`\n" +
          "• **Update status**: `Mark Quiz 2 complete` or `Delete Gym`\n\n" +
          "⏰ Any event with an explicit clock time automatically gets a 5-minute pre-event reminder!";
        break;
      }
    }
  } catch (error) {
    if (error instanceof PlannerError) {
      reply = `⚠️ ${error.message}`;
    } else {
      console.error("Agent execution error:", error);
      reply = "That action could not be completed right now. Please check your connection and try again.";
    }
  }

  const updatedHistory: AgentMessage[] = [
    ...history,
    { role: "user", content: userMessage },
    { role: "assistant", content: reply },
  ];

  return { reply, log, history: updatedHistory };
}
