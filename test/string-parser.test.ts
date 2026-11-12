import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  extractDate,
  parseSmartInput,
} from "../lib/agent/string-parser";

describe("String Verification Algorithm - Course, Event & Date Extraction", () => {
  const BASE_TODAY = "2026-10-01"; // Reference date: Thursday, Oct 1, 2026

  it("1. should parse 'I have self advising at 7pm Oct 1' correctly", () => {
    const res = parseSmartInput("I have self advising at 7pm Oct 1", BASE_TODAY);
    assert.equal(res.type, "CREATE_EVENT");
    if (res.type === "CREATE_EVENT") {
      assert.equal(res.course, "");
      assert.equal(res.title, "Self Advising");
      assert.equal(res.date, "2026-10-01");
      assert.equal(res.time24, "19:00");
      assert.equal(res.timeFormatted, "7:00 PM");
    }
  });

  it("2. should parse 'I have gym at 7pm Oct 2' correctly", () => {
    const res = parseSmartInput("I have gym at 7pm Oct 2", BASE_TODAY);
    assert.equal(res.type, "CREATE_EVENT");
    if (res.type === "CREATE_EVENT") {
      assert.equal(res.course, "");
      assert.equal(res.title, "Gym");
      assert.equal(res.date, "2026-10-02");
      assert.equal(res.time24, "19:00");
      assert.equal(res.timeFormatted, "7:00 PM");
    }
  });

  it("3. should parse 'I have self advising at Oct 1' without time", () => {
    const res = parseSmartInput("I have self advising at Oct 1", BASE_TODAY);
    assert.equal(res.type, "CREATE_EVENT");
    if (res.type === "CREATE_EVENT") {
      assert.equal(res.course, "");
      assert.equal(res.title, "Self Advising");
      assert.equal(res.date, "2026-10-01");
      assert.equal(res.time24, null);
      assert.equal(res.timeFormatted, null);
    }
  });

  it("4. should parse 'I have gym on Oct 2' without time", () => {
    const res = parseSmartInput("I have gym on Oct 2", BASE_TODAY);
    assert.equal(res.type, "CREATE_EVENT");
    if (res.type === "CREATE_EVENT") {
      assert.equal(res.course, "");
      assert.equal(res.title, "Gym");
      assert.equal(res.date, "2026-10-02");
      assert.equal(res.time24, null);
    }
  });

  it("5. should parse 'Meeting tomorrow at 3pm' with relative tomorrow date and time", () => {
    const res = parseSmartInput("Meeting tomorrow at 3pm", BASE_TODAY);
    assert.equal(res.type, "CREATE_EVENT");
    if (res.type === "CREATE_EVENT") {
      assert.equal(res.course, "");
      assert.equal(res.title, "Meeting");
      assert.equal(res.date, "2026-10-02"); // Oct 1 + 1 day
      assert.equal(res.time24, "15:00");
      assert.equal(res.timeFormatted, "3:00 PM");
    }
  });

  it("6. should parse 'Assignment due tomorrow' without time", () => {
    const res = parseSmartInput("Assignment due tomorrow", BASE_TODAY);
    assert.equal(res.type, "CREATE_EVENT");
    if (res.type === "CREATE_EVENT") {
      assert.equal(res.course, "");
      assert.equal(res.title, "Assignment");
      assert.equal(res.date, "2026-10-02");
      assert.equal(res.time24, null);
    }
  });

  it("7. should extract course code and event: 'CSE340 Quiz 2 on tomorrow at 3pm'", () => {
    const res = parseSmartInput("CSE340 Quiz 2 on tomorrow at 3pm", BASE_TODAY);
    assert.equal(res.type, "CREATE_EVENT");
    if (res.type === "CREATE_EVENT") {
      assert.equal(res.course, "CSE340");
      assert.equal(res.title, "Quiz 2");
      assert.equal(res.date, "2026-10-02");
      assert.equal(res.time24, "15:00");
      assert.equal(res.timeFormatted, "3:00 PM");
    }
  });

  it("8. should extract course code with spaces: 'MAT 110 Midterm exam Oct 25'", () => {
    const res = parseSmartInput("MAT 110 Midterm exam Oct 25", BASE_TODAY);
    assert.equal(res.type, "CREATE_EVENT");
    if (res.type === "CREATE_EVENT") {
      assert.equal(res.course, "MAT110");
      assert.equal(res.title, "Midterm Exam");
      assert.equal(res.date, "2026-10-25");
      assert.equal(res.time24, null);
    }
  });

  it("9. should parse complex class announcement with room number and boilerplates", () => {
    const text = "Dear students, please note that CSE221 Lab Quiz 3 will be held tomorrow at 10:00 AM in room UB404. All students must be present on time.";
    const res = parseSmartInput(text, BASE_TODAY);
    assert.equal(res.type, "CREATE_EVENT");
    if (res.type === "CREATE_EVENT") {
      assert.equal(res.course, "CSE221");
      assert.equal(res.title, "Lab Quiz 3");
      assert.equal(res.date, "2026-10-02");
      assert.equal(res.time24, "10:00");
      assert.equal(res.timeFormatted, "10:00 AM");
    }
  });

  it("10. should correctly calculate relative dates: 'day after tomorrow', 'in 3 days', 'next Monday'", () => {
    const res1 = extractDate("Self Advising day after tomorrow", BASE_TODAY);
    assert.equal(res1.date, "2026-10-03");

    const res2 = extractDate("Doctor appointment in 5 days", BASE_TODAY);
    assert.equal(res2.date, "2026-10-06");

    const res3 = extractDate("Class on next Monday", BASE_TODAY);
    assert.ok(res3.date === "2026-10-05" || res3.date === "2026-10-12");
  });

  it("11. should parse query intents: today, tomorrow, week, deadlines, unfinished", () => {
    assert.equal(parseSmartInput("What do I have today?", BASE_TODAY).type, "GET_TODAY");
    assert.equal(parseSmartInput("today's schedule", BASE_TODAY).type, "GET_TODAY");
    assert.equal(parseSmartInput("what is on tomorrow", BASE_TODAY).type, "GET_TOMORROW");
    assert.equal(parseSmartInput("what do I have this week", BASE_TODAY).type, "GET_WEEK");
    assert.equal(parseSmartInput("show deadlines", BASE_TODAY).type, "GET_DEADLINES");
    assert.equal(parseSmartInput("what's unfinished", BASE_TODAY).type, "GET_UNFINISHED");
  });

  it("12. should parse action intents: mark complete, delete, move, find", () => {
    const c = parseSmartInput("mark Quiz 2 complete", BASE_TODAY);
    assert.equal(c.type, "MARK_COMPLETE");
    if (c.type === "MARK_COMPLETE") assert.equal(c.targetText, "Quiz 2");

    const d = parseSmartInput("delete Gym", BASE_TODAY);
    assert.equal(d.type, "DELETE_EVENT");
    if (d.type === "DELETE_EVENT") assert.equal(d.targetText, "Gym");

    const m = parseSmartInput("move Quiz 2 to tomorrow", BASE_TODAY);
    assert.equal(m.type, "MOVE_EVENT");
    if (m.type === "MOVE_EVENT") {
      assert.equal(m.targetText, "Quiz 2");
      assert.equal(m.targetDate, "2026-10-02");
    }

    const f = parseSmartInput("find CSE340", BASE_TODAY);
    assert.equal(f.type, "FIND_EVENT");
    if (f.type === "FIND_EVENT") assert.equal(f.query, "CSE340");
  });
});
