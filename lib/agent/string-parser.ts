import { extractTimeFromText, formatTime12h, stripTimeFromText } from "@/lib/telegram/reminders";

// Common non-course words that might match uppercase letters + numbers (e.g., "ROOM 404", "SEC 01")
const FALSE_COURSE_WORDS = new Set([
  "ROOM", "RM", "BLDG", "BUILDING", "HALL", "SEC", "SECTION", "SLOT", "STEP", "PART",
  "PAGE", "YEAR", "DATE", "TIME", "UNIT", "CHAP", "CHAPTER", "LEVEL", "FLOOR", "RULE", "TASK",
]);

const MONTH_NAMES: Record<string, number> = {
  jan: 1, january: 1,
  feb: 2, february: 2,
  mar: 3, march: 3,
  apr: 4, april: 4,
  may: 5,
  jun: 6, june: 6,
  jul: 7, july: 7,
  aug: 8, august: 8,
  sep: 9, sept: 9, september: 9,
  oct: 10, october: 10,
  nov: 11, november: 11,
  dec: 12, december: 12,
};

const WEEKDAY_NAMES: Record<string, number> = {
  sunday: 0, sun: 0,
  monday: 1, mon: 1,
  tuesday: 2, tue: 2, tues: 2,
  wednesday: 3, wed: 3,
  thursday: 4, thu: 4, thur: 4, thurs: 4,
  friday: 5, fri: 5,
  saturday: 6, sat: 6,
};

/**
 * Add days to a YYYY-MM-DD date string.
 */
export function addDays(baseDateStr: string, days: number): string {
  const [y, m, d] = baseDateStr.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCDate(date.getUTCDate() + days);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Normalizes and extracts course code (e.g. "CSE340", "MAT110", "ENG101") from text.
 * Returns the course code and the text with the course code removed.
 */
export function extractCourseCode(text: string): { course: string | null; cleanedText: string } {
  if (!text) return { course: null, cleanedText: "" };

  // General pattern: 2 to 5 letters followed by optional space/dash and 3-4 digits
  const generalRegex = /\b([A-Za-z]{2,5})[\s\-_]?(\d{3,4}[A-Za-z]?)\b/g;

  let match: RegExpExecArray | null;
  while ((match = generalRegex.exec(text)) !== null) {
    const letters = match[1].toUpperCase();
    const numbers = match[2].toUpperCase();
    if (FALSE_COURSE_WORDS.has(letters)) continue;

    const courseCode = `${letters}${numbers}`;
    // Replace the course occurrence in the text
    const cleanedText = text.slice(0, match.index) + text.slice(match.index + match[0].length);
    return {
      course: courseCode,
      cleanedText: cleanedText.replace(/\s+/g, " ").trim(),
    };
  }

  return { course: null, cleanedText: text };
}

/**
 * Extracts and resolves date expressions relative to `today` (YYYY-MM-DD).
 * Supports:
 * - "today", "tonight"
 * - "tomorrow", "tmrw"
 * - "day after tomorrow"
 * - "yesterday"
 * - "in X days"
 * - Weekdays: "Monday", "this Friday", "next Tuesday"
 * - Calendar dates: "Oct 1", "October 1st", "15 Nov", "2026-10-01", "10/01"
 */
export function extractDate(text: string, today: string): { date: string | null; dateText: string | null; cleanedText: string } {
  if (!text) return { date: null, dateText: null, cleanedText: "" };

  const [refYear] = today.split("-").map(Number);

  // 1. "day after tomorrow"
  const dayAfterMatch = /\bday\s+after\s+tomorrow\b/i.exec(text);
  if (dayAfterMatch) {
    const resolved = addDays(today, 2);
    const cleaned = text.slice(0, dayAfterMatch.index) + text.slice(dayAfterMatch.index + dayAfterMatch[0].length);
    return { date: resolved, dateText: dayAfterMatch[0], cleanedText: cleaned.replace(/\s+/g, " ").trim() };
  }

  // 2. "day before yesterday"
  const dayBeforeMatch = /\bday\s+before\s+yesterday\b/i.exec(text);
  if (dayBeforeMatch) {
    const resolved = addDays(today, -2);
    const cleaned = text.slice(0, dayBeforeMatch.index) + text.slice(dayBeforeMatch.index + dayBeforeMatch[0].length);
    return { date: resolved, dateText: dayBeforeMatch[0], cleanedText: cleaned.replace(/\s+/g, " ").trim() };
  }

  // 3. "tomorrow" / "tmrw"
  const tomorrowMatch = /\b(?:tomorrow|tmrw)\b/i.exec(text);
  if (tomorrowMatch) {
    const resolved = addDays(today, 1);
    const cleaned = text.slice(0, tomorrowMatch.index) + text.slice(tomorrowMatch.index + tomorrowMatch[0].length);
    return { date: resolved, dateText: tomorrowMatch[0], cleanedText: cleaned.replace(/\s+/g, " ").trim() };
  }

  // 4. "today" / "tonight"
  const todayMatch = /\b(?:today|tonight)\b/i.exec(text);
  if (todayMatch) {
    const resolved = today;
    const cleaned = text.slice(0, todayMatch.index) + text.slice(todayMatch.index + todayMatch[0].length);
    return { date: resolved, dateText: todayMatch[0], cleanedText: cleaned.replace(/\s+/g, " ").trim() };
  }

  // 5. "yesterday"
  const yesterdayMatch = /\byesterday\b/i.exec(text);
  if (yesterdayMatch) {
    const resolved = addDays(today, -1);
    const cleaned = text.slice(0, yesterdayMatch.index) + text.slice(yesterdayMatch.index + yesterdayMatch[0].length);
    return { date: resolved, dateText: yesterdayMatch[0], cleanedText: cleaned.replace(/\s+/g, " ").trim() };
  }

  // 6. "in X days"
  const inDaysMatch = /\bin\s+(\d+)\s+days?\b/i.exec(text);
  if (inDaysMatch) {
    const days = parseInt(inDaysMatch[1], 10);
    const resolved = addDays(today, days);
    const cleaned = text.slice(0, inDaysMatch.index) + text.slice(inDaysMatch.index + inDaysMatch[0].length);
    return { date: resolved, dateText: inDaysMatch[0], cleanedText: cleaned.replace(/\s+/g, " ").trim() };
  }

  // 7. Weekdays: "(this |next |coming )?(monday|tuesday|...)"
  const weekdayRegex = /\b(?:(this|next|coming)\s+)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)\b/i;
  const weekdayMatch = weekdayRegex.exec(text);
  if (weekdayMatch) {
    const modifier = (weekdayMatch[1] || "").toLowerCase();
    const dayName = weekdayMatch[2].toLowerCase();
    const targetDayIndex = WEEKDAY_NAMES[dayName];
    if (targetDayIndex !== undefined) {
      const [y, m, d] = today.split("-").map(Number);
      const currentDayIndex = new Date(Date.UTC(y, m - 1, d)).getUTCDay();

      let diff = targetDayIndex - currentDayIndex;
      if (diff < 0) diff += 7;

      if (modifier === "next") {
        diff = diff === 0 ? 7 : diff + 7;
      } else if (diff === 0 && modifier !== "this") {
        diff = 7;
      }

      const resolved = addDays(today, diff);
      const cleaned = text.slice(0, weekdayMatch.index) + text.slice(weekdayMatch.index + weekdayMatch[0].length);
      return { date: resolved, dateText: weekdayMatch[0], cleanedText: cleaned.replace(/\s+/g, " ").trim() };
    }
  }

  // 8. ISO format: YYYY-MM-DD or YYYY/MM/DD
  const isoMatch = /\b(\d{4})[-/](\d{1,2})[-/](\d{1,2})\b/.exec(text);
  if (isoMatch) {
    const y = parseInt(isoMatch[1], 10);
    const m = parseInt(isoMatch[2], 10);
    const d = parseInt(isoMatch[3], 10);
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
      const resolved = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      const cleaned = text.slice(0, isoMatch.index) + text.slice(isoMatch.index + isoMatch[0].length);
      return { date: resolved, dateText: isoMatch[0], cleanedText: cleaned.replace(/\s+/g, " ").trim() };
    }
  }

  // 9. Month + Day: "Oct 1", "October 1st", "Nov 15, 2026"
  const monthDayRegex = /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|sept|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{1,2})(?:st|nd|rd|th)?(?:\s*,?\s*(\d{4}))?\b/i;
  const monthDayMatch = monthDayRegex.exec(text);
  if (monthDayMatch) {
    const month = MONTH_NAMES[monthDayMatch[1].toLowerCase()];
    const day = parseInt(monthDayMatch[2], 10);
    const year = monthDayMatch[3] ? parseInt(monthDayMatch[3], 10) : refYear;
    if (month && day >= 1 && day <= 31) {
      let resolved = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      if (!monthDayMatch[3]) {
        const diffMs = Date.parse(`${resolved}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`);
        if (diffMs < -90 * 86_400_000) {
          resolved = `${year + 1}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
        }
      }
      const cleaned = text.slice(0, monthDayMatch.index) + text.slice(monthDayMatch.index + monthDayMatch[0].length);
      return { date: resolved, dateText: monthDayMatch[0], cleanedText: cleaned.replace(/\s+/g, " ").trim() };
    }
  }

  // 10. Day + Month: "1 Oct", "1st of October", "15 November"
  const dayMonthRegex = /\b(\d{1,2})(?:st|nd|rd|th)?(?:\s+of)?\s+(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|sept|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)(?:\s*,?\s*(\d{4}))?\b/i;
  const dayMonthMatch = dayMonthRegex.exec(text);
  if (dayMonthMatch) {
    const day = parseInt(dayMonthMatch[1], 10);
    const month = MONTH_NAMES[dayMonthMatch[2].toLowerCase()];
    const year = dayMonthMatch[3] ? parseInt(dayMonthMatch[3], 10) : refYear;
    if (month && day >= 1 && day <= 31) {
      let resolved = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      if (!dayMonthMatch[3]) {
        const diffMs = Date.parse(`${resolved}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`);
        if (diffMs < -90 * 86_400_000) {
          resolved = `${year + 1}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
        }
      }
      const cleaned = text.slice(0, dayMonthMatch.index) + text.slice(dayMonthMatch.index + dayMonthMatch[0].length);
      return { date: resolved, dateText: dayMonthMatch[0], cleanedText: cleaned.replace(/\s+/g, " ").trim() };
    }
  }

  return { date: null, dateText: null, cleanedText: text };
}

/**
 * Extracts and cleans the event title by removing noise, greetings, prepositions, and boilerplates.
 */
export function extractEventTitle(rawText: string, course: string | null): string {
  let text = rawText;

  // Remove common announcement boilerplates and headers
  text = text.replace(/^(?:dear\s+students?|attention(?:\s+everyone|\s+all)?|notice|announcement|reminder|greetings|hello|hi)[\s,:!-]+/gi, "");
  text = text.replace(/\b(?:please\s+note\s+that|please\s+be\s+informed\s+that|be\s+informed\s+that|this\s+is\s+to\s+inform\s+you\s+that)\b/gi, "");
  text = text.replace(/\b(?:all\s+students\s+must|don'?t\s+forget\s+to|make\s+sure\s+to|be\s+present\s+on\s+time)[\s\S]*$/gi, "");

  // Remove conversational prefixes
  text = text.replace(/^(?:i\s+have\s+an?|i\s+have|i'?ve\s+got\s+an?|i'?ve\s+got|i\s+got\s+an?|i\s+got)\b/gi, "");
  text = text.replace(/^(?:there\s+is\s+an?|there\s+is|there'?s\s+an?|there'?s|there\s+will\s+be\s+an?|there\s+will\s+be)\b/gi, "");
  text = text.replace(/^(?:we\s+have\s+an?|we\s+have|we\s+will\s+have\s+an?|we\s+will\s+have)\b/gi, "");
  text = text.replace(/^(?:add|create|set|put|schedule|plan|remind\s+me\s+about|remind\s+me\s+to)\b/gi, "");

  // Remove deadline connectors
  text = text.replace(/\b(?:deadline\s+for|deadline\s+is|due\s+date\s+is|is\s+due|due\s+on|due\s+at|due)\b/gi, "");
  text = text.replace(/\b(?:will\s+be\s+held\s+on|will\s+be\s+held\s+at|will\s+be\s+held|will\s+take\s+place\s+on|will\s+take\s+place\s+at|will\s+take\s+place|taking\s+place\s+on|taking\s+place|is\s+scheduled\s+for|is\s+scheduled\s+on|scheduled\s+for|scheduled\s+on|held\s+on)\b/gi, "");

  // Remove room/location information at the end (e.g. "in room 404", "in UB404", "via Zoom", "on the portal")
  text = text.replace(/\s+(?:in\s+room|at\s+room|room|in\s+bldg|in\s+building|via\s+zoom|on\s+zoom|on\s+the\s+portal|on\s+canvas|on\s+blackboard)\s+[A-Za-z0-9_-]+/gi, "");

  // If a known academic or personal event keyword is clearly present, we can prioritize that
  const academicKeywordMatch = text.match(/\b((?:lab\s+)?(?:quiz|exam|midterm(?:\s+exam)?|final(?:\s+exam)?|assignment|homework|hw|project(?:\s+demo|\s+submission|\s+presentation)?|presentation|viva|make-up\s+class|lecture|tutorial)\s*\d*)\b/i);
  if (academicKeywordMatch) {
    const kw = academicKeywordMatch[1].trim();
    if (text.length > 50 || /^(?:the\s+)?/i.test(text)) {
      text = kw;
    }
  }

  // Remove trailing and leading prepositions and punctuation
  text = text
    .replace(/^[\s,.:;!-]+/, "")
    .replace(/[\s,.:;!-]+$/, "")
    .replace(/^(?:on|at|for|by|in)\s+/i, "")
    .replace(/\s+(?:on|at|for|by|in)$/i, "")
    .trim();

  // If text is empty or just punctuation, fallback
  if (!text) {
    text = course ? "Task" : "Event";
  }

  // Clean double spaces
  text = text.replace(/\s+/g, " ");

  // Title-case capitalization for words
  text = text.replace(/\b([a-z])/g, (c) => c.toUpperCase());

  return text;
}

export type ParsedIntent =
  | {
      type: "CREATE_EVENT";
      course: string;
      title: string;
      date: string;
      time24: string | null;
      timeFormatted: string | null;
      rawInput: string;
    }
  | {
      type: "GET_TODAY";
    }
  | {
      type: "GET_TOMORROW";
      date: string;
    }
  | {
      type: "GET_WEEK";
    }
  | {
      type: "GET_DEADLINES";
    }
  | {
      type: "GET_UNFINISHED";
    }
  | {
      type: "FIND_EVENT";
      query: string;
    }
  | {
      type: "MARK_COMPLETE";
      targetText: string;
    }
  | {
      type: "MARK_INCOMPLETE";
      targetText: string;
    }
  | {
      type: "DELETE_EVENT";
      targetText: string;
    }
  | {
      type: "MOVE_EVENT";
      targetText: string;
      targetDate: string;
    }
  | {
      type: "HELP";
    };

/**
 * Smart string verification & intent parser.
 * Understands user instructions, extracts course codes, dates, times, and actions.
 */
export function parseSmartInput(rawInput: string, today: string): ParsedIntent {
  const input = rawInput.trim();
  const inputCleaned = input.replace(/[?!.,;:]+$/, "").trim();
  const lower = inputCleaned.toLowerCase();

  // 1. Help / Greetings
  if (/^(?:hi|hello|hey|help|what\s+can\s+you\s+do|how\s+to\s+use)$/i.test(lower)) {
    return { type: "HELP" };
  }

  // 2. Schedule queries
  // Today's schedule
  if (/^(?:what\s+(?:do\s+i\s+have|is\s+on)\s+today|today'?s?\s+schedule|show\s+today|today)$/i.test(lower)) {
    return { type: "GET_TODAY" };
  }

  // Tomorrow's schedule
  if (/^(?:what\s+(?:do\s+i\s+have|is\s+on)\s+tomorrow|tomorrow'?s?\s+schedule|show\s+tomorrow|tomorrow)$/i.test(lower)) {
    return { type: "GET_TOMORROW", date: addDays(today, 1) };
  }

  // This week's schedule
  if (/^(?:what\s+(?:do\s+i\s+have|is\s+on)\s+this\s+week|week'?s?\s+schedule|weekly\s+schedule|show\s+(?:this\s+)?week|this\s+week)$/i.test(lower)) {
    return { type: "GET_WEEK" };
  }

  // Deadlines
  if (/^(?:what\s+are\s+my\s+deadlines|show\s+deadlines|upcoming\s+deadlines|deadlines)$/i.test(lower)) {
    return { type: "GET_DEADLINES" };
  }

  // Unfinished / pending tasks
  if (/^(?:what(?:'?s|\s+is)\s+unfinished|unfinished\s+events|pending\s+(?:tasks|events)|show\s+unfinished|pending)$/i.test(lower)) {
    return { type: "GET_UNFINISHED" };
  }

  // 3. Mark complete / incomplete
  const markCompleteMatch = /^(?:mark\s+(.+?)\s+(?:as\s+)?(?:complete|done|finished)|(?:complete|finish|done\s+with)\s+(.+))$/i.exec(inputCleaned);
  if (markCompleteMatch) {
    const target = (markCompleteMatch[1] || markCompleteMatch[2] || "").trim();
    if (target) return { type: "MARK_COMPLETE", targetText: target };
  }

  const markIncompleteMatch = /^(?:mark\s+(.+?)\s+(?:as\s+)?(?:incomplete|pending|uncompleted)|(?:uncomplete|reopen)\s+(.+))$/i.exec(inputCleaned);
  if (markIncompleteMatch) {
    const target = (markIncompleteMatch[1] || markIncompleteMatch[2] || "").trim();
    if (target) return { type: "MARK_INCOMPLETE", targetText: target };
  }

  // 4. Delete / Remove
  const deleteMatch = /^(?:delete|remove|cancel)\s+(.+)$/i.exec(inputCleaned);
  if (deleteMatch && !/^(?:account|sheet|planner)$/i.test(deleteMatch[1].trim())) {
    const target = deleteMatch[1].trim();
    return { type: "DELETE_EVENT", targetText: target };
  }

  // 5. Move / Reschedule
  const moveMatch = /^(?:move|reschedule)\s+(.+?)\s+(?:to|for)\s+(.+)$/i.exec(inputCleaned);
  if (moveMatch) {
    const target = moveMatch[1].trim();
    const datePart = moveMatch[2].trim();
    const { date: targetDate } = extractDate(datePart, today);
    if (targetDate) {
      return { type: "MOVE_EVENT", targetText: target, targetDate };
    }
  }

  // 6. Find / Search
  const findMatch = /^(?:find|search(?:\s+for)?|look\s+for|where\s+is)\s+(.+)$/i.exec(inputCleaned);
  if (findMatch) {
    const query = findMatch[1].trim();
    return { type: "FIND_EVENT", query };
  }

  // 7. Core Default: CREATE_EVENT (smart extraction of course, event, date, and time)
  // Step A: Extract Time
  const time24 = extractTimeFromText(input);
  const timeFormatted = time24 ? formatTime12h(time24) : null;
  const textWithoutTime = stripTimeFromText(input);

  // Step B: Extract Date
  const dateResult = extractDate(textWithoutTime, today);
  const targetDate = dateResult.date || today; // If no date specified, default to today
  const textWithoutDateAndTime = dateResult.cleanedText;

  // Step C: Extract Course
  const courseResult = extractCourseCode(textWithoutDateAndTime);
  const course = courseResult.course || "";
  const remainingText = courseResult.cleanedText;

  // Step D: Extract Event Title
  const title = extractEventTitle(remainingText, course);

  return {
    type: "CREATE_EVENT",
    course,
    title,
    date: targetDate,
    time24,
    timeFormatted,
    rawInput: input,
  };
}
