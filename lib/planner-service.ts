// Planner service: reads and writes the authenticated user's Google Sheets planner.
// Preserves layout, duplicate, and color rules:
//   - month tabs matched by lib/sheet.ts's monthTabPattern
//   - day numbers read from column D, rows 3..45
//   - four event slots per day in columns E..H
//   - added text is uppercased; duplicates are same-day case-insensitive text matches
//   - "pending" = red fill (#991b1b-family); "completed" = the exact blue #1e3a8a
import { GoogleAccessError, googleAccessToken } from "@/ai/google-auth";
import type { UserDoc } from "@/lib/models";
import { monthTabPattern } from "@/lib/sheet";
import { taskRemindersCollection } from "@/lib/mongodb";

export class PlannerError extends Error {
  constructor(message: string, readonly code?: string) { super(message); }
}

const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const SLOT_COLUMNS = ["E", "F", "G", "H"] as const;

type Color = { red?: number; green?: number; blue?: number };
type GridCell = {
  formattedValue?: string;
  effectiveFormat?: { backgroundColor?: Color; textFormat?: { foregroundColor?: Color } };
};
type GridSheet = {
  properties: { sheetId: number };
  data?: { startRow?: number; startColumn?: number; rowData?: { values?: GridCell[] }[] }[];
};
type SheetMeta = { properties: { title: string; sheetId: number } };

function isWhite(color: Color | undefined): boolean {
  return Boolean(color && (color.red ?? 0) >= 0.98 && (color.green ?? 0) >= 0.98 && (color.blue ?? 0) >= 0.98);
}
function isPendingRed(color: Color | undefined): boolean {
  if (!color) return false;
  const { red = 0, green = 0, blue = 0 } = color;
  return red >= 0.3 && green < red * 0.6 && blue < red * 0.6 && Math.abs(green - blue) < 0.15;
}
function isCompletedBlue(color: Color | undefined): boolean {
  return Boolean(color && Math.abs((color.red ?? 0) - 30 / 255) < 0.005 &&
    Math.abs((color.green ?? 0) - 58 / 255) < 0.005 && Math.abs((color.blue ?? 0) - 138 / 255) < 0.005);
}
const isBlank = (text: string) => !text.replace(/[\s\u200B-\u200D\u2060\uFEFF]/g, "");

/**
 * A slot is occupied IF AND ONLY IF:
 * 1. It has an active event background color: Pending Red or Completed Blue, OR
 * 2. It has visible, non-reset text (non-blank text where foreground is NOT invisible white text).
 *
 * Any other slot is EMPTY:
 * - Empty text with default white background
 * - Empty text with zebra column tint (#f2f2f2)
 * - Empty text with weekend gray tint (#d6dce4)
 * - Cleared / reset cells with invisible text (white foreground on non-event bg)
 */
export function isSlotEmpty(cell: GridCell | undefined): boolean {
  if (!cell) return true;
  const format = cell.effectiveFormat;
  const bg = format?.backgroundColor;

  // Active event fills: pending red or completed blue are NEVER empty.
  if (isPendingRed(bg) || isCompletedBlue(bg)) {
    return false;
  }

  const text = cell.formattedValue ?? "";
  if (isBlank(text)) {
    // Blank/whitespace text on any template bg (white, zebra, weekend gray) is EMPTY.
    return true;
  }

  // If there is text, check if it's invisible reset fill (white foreground on non-event bg).
  const fg = format?.textFormat?.foregroundColor;
  if (isWhite(fg)) {
    return true;
  }

  // Cell has visible text with normal foreground color (e.g. manual user entry).
  return false;
}

/** A real YYYY-MM-DD used everywhere in the planner service; tools must resolve dates before calling in. */
export function assertDate(date: unknown): string {
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new PlannerError("Date must be YYYY-MM-DD.", "invalid_date");
  }
  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    throw new PlannerError(`${date} is not a real calendar date.`, "invalid_date");
  }
  return date;
}

/** The authenticated user's Google access token and selected spreadsheet id, or a clear PlannerError. */
export async function resolvePlanner(user: UserDoc): Promise<{ token: string; spreadsheetId: string }> {
  if (!user.sheetId) throw new PlannerError("No planner is connected yet. Choose or generate one in Setup.", "no_sheet");
  try {
    return { token: await googleAccessToken(user), spreadsheetId: user.sheetId };
  } catch (error) {
    if (error instanceof GoogleAccessError) throw new PlannerError(error.message, "reauth");
    throw new PlannerError("Could not reach the database. Please retry.", "database");
  }
}

async function googleFetch(token: string, spreadsheetId: string, path: string, init: RequestInit = {}) {
  const result = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    cache: "no-store",
    signal: AbortSignal.timeout(20_000),
  });
  if (!result.ok) {
    const reason = result.status === 403
      ? "Choose your planner through Google Drive again, check that your account can edit it, and make sure Google Sheets API is enabled."
      : result.status === 404
        ? "Choose your planner through Google Drive again to grant Excela access. If it was deleted, select another planner."
        : "Please retry.";
    throw new PlannerError(`Google Sheets request failed (${result.status}). ${reason}`, "sheets_api");
  }
  return result.json();
}

/** All month tabs in the spreadsheet, parsed into {title, sheetId, month, year}. */
async function listMonthTabs(token: string, spreadsheetId: string) {
  const metadata = await googleFetch(token, spreadsheetId, "?fields=sheets(properties(title,sheetId))") as { sheets: SheetMeta[] };
  return metadata.sheets.flatMap(({ properties }) => {
    const match = properties.title.match(monthTabPattern);
    if (!match) return [];
    const month = months.indexOf(match[1].slice(0, 3).toLowerCase()) + 1;
    return [{ title: properties.title, sheetId: properties.sheetId, month, year: Number(match[2]) }];
  });
}

/** Every month tab whose (month, year) falls within [from, to] inclusive. */
function tabsInRange(tabs: Awaited<ReturnType<typeof listMonthTabs>>, from: string, to: string) {
  const start = from.slice(0, 7); // YYYY-MM
  const end = to.slice(0, 7);
  return tabs.filter((tab) => {
    const key = `${tab.year}-${String(tab.month).padStart(2, "0")}`;
    return key >= start && key <= end;
  });
}

export type DaySlot = { column: (typeof SLOT_COLUMNS)[number]; text: string; status: "pending" | "completed" | "other" | "empty" };
export type DayRow = { date: string; sheet: string; sheetId: number; rowIndex: number; slots: DaySlot[] };

/** Reads columns D:H for every day-row across the given tabs. One Sheets read per distinct tab. */
async function readTabGrids(token: string, spreadsheetId: string, tabs: { title: string; sheetId: number; month: number; year: number }[]) {
  if (!tabs.length) return new Map<number, { rowIndex: number; day: number; columns: (GridCell | undefined)[] }[]>();
  const ranges = tabs.map((tab) => `'${tab.title.replaceAll("'", "''")}'!D3:H45`);
  const query = ranges.map((range) => `ranges=${encodeURIComponent(range)}`).join("&");
  const grid = await googleFetch(token, spreadsheetId,
    `?${query}&fields=sheets(properties(sheetId),data(startRow,startColumn,rowData(values(formattedValue,effectiveFormat(backgroundColor,textFormat(foregroundColor))))))`,
  ) as { sheets: GridSheet[] };
  const byTab = new Map<number, { rowIndex: number; day: number; columns: (GridCell | undefined)[] }[]>();
  for (const tab of tabs) {
    const sheet = grid.sheets.find((item) => item.properties.sheetId === tab.sheetId);
    const rows: { rowIndex: number; day: number; columns: (GridCell | undefined)[] }[] = [];
    for (const block of sheet?.data ?? []) {
      for (const [offset, row] of (block.rowData ?? []).entries()) {
        const rowIndex = (block.startRow ?? 0) + offset; // 0-based sheet row
        const columns: (GridCell | undefined)[] = [];
        for (const [columnOffset, cell] of (row.values ?? []).entries()) {
          const column = (block.startColumn ?? 0) + columnOffset - 3; // 0 = D
          if (column >= 0 && column <= 4) columns[column] = cell;
        }
        const day = Number(String(columns[0]?.formattedValue ?? "").trim());
        if (Number.isInteger(day) && day >= 1 && day <= 31) rows.push({ rowIndex, day, columns });
      }
    }
    byTab.set(tab.sheetId, rows);
  }
  return byTab;
}

function slotStatus(cell: GridCell | undefined): DaySlot["status"] {
  if (isSlotEmpty(cell)) return "empty";
  const format = cell?.effectiveFormat;
  if (isPendingRed(format?.backgroundColor)) return "pending";
  if (isCompletedBlue(format?.backgroundColor)) return "completed";
  return "other";
}

/**
 * Reads every day in [from, to] (inclusive, both YYYY-MM-DD) from the user's planner.
 * Returns one DayRow per calendar day that has a matching sheet row; days with no row in the sheet
 * (a month tab is missing, or the day number wasn't found) are simply left out of the result — this
 * mirrors what a human looking at the sheet would see, and callers should treat a missing day as
 * "no information available", not as "definitely nothing scheduled".
 */
export async function getSchedule(user: UserDoc, from: string, to: string): Promise<DayRow[]> {
  assertDate(from);
  assertDate(to);
  if (from > to) throw new PlannerError("The start date must not be after the end date.", "invalid_range");
  const { token, spreadsheetId } = await resolvePlanner(user);
  const tabs = tabsInRange(await listMonthTabs(token, spreadsheetId), from, to);
  const grids = await readTabGrids(token, spreadsheetId, tabs);
  const days: DayRow[] = [];
  let cursor = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  while (cursor <= end) {
    const date = cursor.toISOString().slice(0, 10);
    const tab = tabs.find((item) => item.year === cursor.getUTCFullYear() && item.month === cursor.getUTCMonth() + 1);
    const row = tab && grids.get(tab.sheetId)?.find((candidate) => candidate.day === cursor.getUTCDate());
    if (tab && row) {
      days.push({
        date,
        sheet: tab.title,
        sheetId: tab.sheetId,
        rowIndex: row.rowIndex,
        slots: SLOT_COLUMNS.map((column, index) => ({
          column,
          text: String(row.columns[index + 1]?.formattedValue ?? "").trim(),
          status: slotStatus(row.columns[index + 1]),
        })).filter((slot) => slot.status !== "empty"),
      });
    }
    cursor = new Date(cursor.getTime() + 86_400_000);
  }
  return days;
}

/** Case-insensitive substring search for events whose text matches `query`, within [from, to]. */
export async function findEvents(user: UserDoc, query: string, from: string, to: string) {
  const needle = query.trim().toLowerCase();
  if (!needle) throw new PlannerError("Provide text to search for.", "invalid_query");
  const days = await getSchedule(user, from, to);
  return days.flatMap((day) =>
    day.slots
      .filter((slot) => slot.text.toLowerCase().includes(needle))
      .map((slot) => ({ date: day.date, sheet: day.sheet, text: slot.text, status: slot.status, cell: `${slot.column}${day.rowIndex + 1}` })),
  );
}

export type CreateEventResult = { status: "created" | "duplicate"; date: string; label: string; cell?: string; sheetId?: number; rowIndex?: number; link?: string };

/**
 * Adds one event to the first empty slot on `date`:
 * uppercase "COURSE TITLE" label, E→F→G→H slot order, same-day
 * case-insensitive duplicate skipping, dark-red fill with white text. Throws PlannerError, including
 * "day_full" when all four slots are occupied and "no_month_tab" when no matching tab exists yet.
 */
export async function createEvent(user: UserDoc, input: { course: string; title: string; date: string }): Promise<CreateEventResult> {
  const title = input.title.trim();
  const course = input.course.trim();
  const date = assertDate(input.date);
  if (!title || title.length > 200 || course.length > 80) {
    throw new PlannerError("The event needs a short title (course optional).", "invalid_event");
  }
  const { token, spreadsheetId } = await resolvePlanner(user);
  const tabs = await listMonthTabs(token, spreadsheetId);
  const target = new Date(`${date}T00:00:00Z`);
  const tab = tabs.find((item) => item.year === target.getUTCFullYear() && item.month === target.getUTCMonth() + 1);
  if (!tab) throw new PlannerError(`No "${target.toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" })}" tab exists in this planner yet.`, "no_month_tab");
  const grids = await readTabGrids(token, spreadsheetId, [tab]);
  const row = grids.get(tab.sheetId)?.find((candidate) => candidate.day === target.getUTCDate());
  if (!row) throw new PlannerError(`Cannot locate day ${target.getUTCDate()} in ${tab.title}.`, "day_not_found");

  const label = [course, title].filter(Boolean).join(" ").replace(/\s+/g, " ").toUpperCase();
  const activeEvents = SLOT_COLUMNS.map((_, index) => {
    const cell = row.columns[index + 1];
    if (isSlotEmpty(cell)) return "";
    return String(cell?.formattedValue ?? "").trim();
  });
  if (activeEvents.some((text) => text && text.toLowerCase() === label.toLowerCase())) {
    return { status: "duplicate", date, label };
  }
  const slotIndex = [0, 1, 2, 3].findIndex((index) => isSlotEmpty(row.columns[index + 1]));
  if (slotIndex === -1) throw new PlannerError(`All four event slots on ${date} are occupied.`, "day_full");

  await googleFetch(token, spreadsheetId, ":batchUpdate", {
    method: "POST",
    body: JSON.stringify({
      requests: [{
        repeatCell: {
          range: { sheetId: tab.sheetId, startRowIndex: row.rowIndex, endRowIndex: row.rowIndex + 1, startColumnIndex: slotIndex + 4, endColumnIndex: slotIndex + 5 },
          cell: {
            userEnteredValue: { stringValue: label },
            userEnteredFormat: {
              backgroundColorStyle: { rgbColor: { red: 153 / 255, green: 27 / 255, blue: 27 / 255 } },
              textFormat: { foregroundColorStyle: { rgbColor: { red: 1, green: 1, blue: 1 } } },
            },
          },
          fields: "userEnteredValue,userEnteredFormat.backgroundColorStyle,userEnteredFormat.textFormat.foregroundColorStyle",
        },
      }],
    }),
  });

  const cell = `${SLOT_COLUMNS[slotIndex]}${row.rowIndex + 1}`;
  const link = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit#gid=${tab.sheetId}&range=A${Math.max(1, row.rowIndex + 1 - 12)}`;
  return { status: "created", date, label, cell, sheetId: tab.sheetId, rowIndex: row.rowIndex, link };
}

const PENDING_FORMAT = { backgroundColorStyle: { rgbColor: { red: 153/255, green: 27/255, blue: 27/255 } }, textFormat: { foregroundColorStyle: { rgbColor: { red: 1, green: 1, blue: 1 } } } };
const COMPLETED_FORMAT = { backgroundColorStyle: { rgbColor: { red: 30/255, green: 58/255, blue: 138/255 } }, textFormat: { foregroundColorStyle: { rgbColor: { red: 1, green: 1, blue: 1 } } } };
const CLEAR_FORMAT = { backgroundColorStyle: { rgbColor: { red: 1, green: 1, blue: 1 } }, textFormat: { foregroundColorStyle: { rgbColor: { red: 0.13333334, green: 0.16470589, blue: 0.20784314 } } } };

export type EventMatch = { date: string; sheet: string; sheetId: number; rowIndex: number; text: string; status: DaySlot['status']; cell: string; column: string };

export async function findEventsDetailed(user: UserDoc, query: string, from: string, to: string): Promise<EventMatch[]> {
  const needle = query.trim().toLowerCase();
  if (!needle) throw new PlannerError('Provide text to search for.', 'invalid_query');
  const days = await getSchedule(user, from, to);
  return days.flatMap((day) =>
    day.slots
      .filter((slot) => slot.text.toLowerCase().includes(needle))
      .map((slot) => ({
        date: day.date, sheet: day.sheet, sheetId: day.sheetId, rowIndex: day.rowIndex,
        text: slot.text, status: slot.status, cell: `${slot.column}${day.rowIndex + 1}`, column: slot.column,
      })),
  );
}

function parseCellRef(cell: string): { column: string; rowIndex: number } {
  const match = cell.trim().toUpperCase().match(/^([EFGH])(\d+)$/);
  if (!match) throw new PlannerError(`Invalid cell reference: ${cell}. Must be in columns E, F, G, or H.`, "invalid_cell");
  return { column: match[1], rowIndex: parseInt(match[2], 10) - 1 };
}

function cellToRange(sheetId: number, cell: string) {
  const { column, rowIndex } = parseCellRef(cell);
  const colIndex = SLOT_COLUMNS.indexOf(column as (typeof SLOT_COLUMNS)[number]) + 4; // E is 4
  return { sheetId, startRowIndex: rowIndex, endRowIndex: rowIndex + 1, startColumnIndex: colIndex, endColumnIndex: colIndex + 1 };
}

export async function updateEvent(user: UserDoc, input: { cell: string; sheetId: number; newCourse: string; newTitle: string }) {
  const { token, spreadsheetId } = await resolvePlanner(user);
  const range = cellToRange(input.sheetId, input.cell);
  const label = [input.newCourse, input.newTitle].filter(Boolean).join(' ').replace(/\s+/g, ' ').toUpperCase();
  
  await googleFetch(token, spreadsheetId, ":batchUpdate", {
    method: "POST",
    body: JSON.stringify({
      requests: [{
        repeatCell: {
          range,
          cell: {
            userEnteredValue: { stringValue: label },
            userEnteredFormat: PENDING_FORMAT,
          },
          fields: "userEnteredValue,userEnteredFormat.backgroundColorStyle,userEnteredFormat.textFormat.foregroundColorStyle",
        },
      }],
    }),
  });
  return { status: 'updated', cell: input.cell, sheetId: input.sheetId, label };
}

export async function moveEvent(user: UserDoc, input: { cell: string; sourceSheetId: number; sourceRowIndex: number; sourceDate: string; text: string; targetDate: string }) {
  const { token, spreadsheetId } = await resolvePlanner(user);
  
  const sourceRange = cellToRange(input.sourceSheetId, input.cell);
  await googleFetch(token, spreadsheetId, ":batchUpdate", {
    method: "POST",
    body: JSON.stringify({
      requests: [{
        repeatCell: {
          range: sourceRange,
          cell: {
            userEnteredFormat: CLEAR_FORMAT,
          },
          fields: "userEnteredValue,userEnteredFormat.backgroundColorStyle,userEnteredFormat.textFormat.foregroundColorStyle",
        },
      }],
    }),
  });

  const createRes = await createEvent(user, { course: "", title: input.text, date: input.targetDate });
  
  try {
    const reminders = await taskRemindersCollection();
    await reminders.updateMany(
      { userId: user._id, cell: input.cell, enabled: true, sentAt: null },
      { $set: { enabled: false, discardedAt: new Date(), discardReason: "moved", updatedAt: new Date() }, $unset: { processingLockUntil: "" } },
    );
  } catch {
    // Best-effort reminder invalidation
  }

  return { status: 'moved', from: { cell: input.cell, sheetId: input.sourceSheetId, date: input.sourceDate }, to: { cell: createRes.cell, sheetId: createRes.sheetId, date: input.targetDate }, label: createRes.label };
}

export async function markEventComplete(user: UserDoc, input: { cell: string; sheetId: number }) {
  const { token, spreadsheetId } = await resolvePlanner(user);
  const range = cellToRange(input.sheetId, input.cell);
  
  await googleFetch(token, spreadsheetId, ":batchUpdate", {
    method: "POST",
    body: JSON.stringify({
      requests: [{
        repeatCell: {
          range,
          cell: {
            userEnteredFormat: COMPLETED_FORMAT,
          },
          fields: "userEnteredFormat.backgroundColorStyle,userEnteredFormat.textFormat.foregroundColorStyle",
        },
      }],
    }),
  });

  try {
    const reminders = await taskRemindersCollection();
    await reminders.updateMany(
      { userId: user._id, cell: input.cell, enabled: true, sentAt: null },
      { $set: { enabled: false, discardedAt: new Date(), discardReason: "completed", updatedAt: new Date() }, $unset: { processingLockUntil: "" } },
    );
  } catch {
    // Best-effort reminder invalidation
  }

  return { status: 'completed', cell: input.cell, sheetId: input.sheetId };
}

export async function markEventIncomplete(user: UserDoc, input: { cell: string; sheetId: number }) {
  const { token, spreadsheetId } = await resolvePlanner(user);
  const range = cellToRange(input.sheetId, input.cell);
  
  await googleFetch(token, spreadsheetId, ":batchUpdate", {
    method: "POST",
    body: JSON.stringify({
      requests: [{
        repeatCell: {
          range,
          cell: {
            userEnteredFormat: PENDING_FORMAT,
          },
          fields: "userEnteredFormat.backgroundColorStyle,userEnteredFormat.textFormat.foregroundColorStyle",
        },
      }],
    }),
  });
  return { status: 'marked_incomplete', cell: input.cell, sheetId: input.sheetId };
}

export async function deleteEvent(user: UserDoc, input: { cell: string; sheetId: number; confirmationToken?: string }) {
  const { token, spreadsheetId } = await resolvePlanner(user);
  const range = cellToRange(input.sheetId, input.cell);
  
  await googleFetch(token, spreadsheetId, ":batchUpdate", {
    method: "POST",
    body: JSON.stringify({
      requests: [{
        repeatCell: {
          range,
          cell: {
            userEnteredFormat: CLEAR_FORMAT,
          },
          fields: "userEnteredValue,userEnteredFormat.backgroundColorStyle,userEnteredFormat.textFormat.foregroundColorStyle",
        },
      }],
    }),
  });

  try {
    const reminders = await taskRemindersCollection();
    await reminders.updateMany(
      { userId: user._id, cell: input.cell, enabled: true, sentAt: null },
      { $set: { enabled: false, discardedAt: new Date(), discardReason: "deleted", updatedAt: new Date() }, $unset: { processingLockUntil: "" } },
    );
  } catch {
    // Best-effort reminder invalidation
  }

  return { status: 'deleted', cell: input.cell };
}

export async function checkConflicts(user: UserDoc, date: string) {
  await resolvePlanner(user); // ensures user has sheet connected
  const days = await getSchedule(user, date, date);
  const day = days.find((d) => d.date === date);
  const existingEvents = day ? day.slots : [];
  return {
    date,
    existingEvents,
    slotsUsed: existingEvents.length,
    slotsFree: 4 - existingEvents.length,
  };
}
