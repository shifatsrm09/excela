import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ObjectId } from "mongodb";
import type { UserDoc } from "@/lib/models";
import { runSmartAgent, type ToolRunner } from "@/lib/agent/agent";

describe("Smart String Agent - runSmartAgent end-to-end integration", () => {
  const dummyUser: UserDoc = {
    _id: new ObjectId(),
    googleId: "google123",
    email: "test@example.com",
    name: "Test User",
    picture: null,
    sheetId: "sheet123",
    sheetUrl: "https://docs.google.com/spreadsheets/d/sheet123/edit",
    sheetTitle: "Planner",
    createdAt: new Date(),
    updatedAt: new Date(),
    lastLoginAt: new Date(),
  };

  const BASE_TODAY = "2026-10-01";

  it("1. should handle creating a timed event: 'I have self advising at 7pm Oct 1'", async () => {
    const mockRunner: ToolRunner = {
      executeTool: async (name: string, rawArgs: unknown) => {
        const args = rawArgs as Record<string, unknown>;
        assert.equal(name, "create_event");
        assert.equal(args.course, "");
        assert.equal(args.title, "Self Advising");
        assert.equal(args.date, "2026-10-01");
        assert.equal(args.time, "7:00 PM");

        return {
          status: "created",
          date: "2026-10-01",
          label: "SELF ADVISING 7:00 PM",
          cell: "E5",
          reminderSet: true,
          reminderTime: "6:55 PM",
          existingEventsOnDate: [],
          slotsUsed: 1,
          slotsFree: 3,
        };
      },
      findEventsDetailed: async () => [],
    };

    const res = await runSmartAgent(null, dummyUser, BASE_TODAY, "I have self advising at 7pm Oct 1", [], mockRunner);

    assert.ok(res.reply.includes("SELF ADVISING 7:00 PM"));
    assert.ok(res.reply.includes("Cell E5"));
    assert.ok(res.reply.includes("6:55 PM"));
    assert.equal(res.log.length, 1);
    assert.equal(res.log[0].name, "create_event");
  });

  it("2. should handle creating an untimed event: 'I have gym on Oct 2'", async () => {
    const mockRunner: ToolRunner = {
      executeTool: async (name: string, rawArgs: unknown) => {
        const args = rawArgs as Record<string, unknown>;
        assert.equal(name, "create_event");
        assert.equal(args.course, "");
        assert.equal(args.title, "Gym");
        assert.equal(args.date, "2026-10-02");
        assert.equal(args.time, "");

        return {
          status: "created",
          date: "2026-10-02",
          label: "GYM",
          cell: "E6",
          reminderSet: false,
          existingEventsOnDate: [],
          slotsUsed: 1,
          slotsFree: 3,
        };
      },
      findEventsDetailed: async () => [],
    };

    const res = await runSmartAgent(null, dummyUser, BASE_TODAY, "I have gym on Oct 2", [], mockRunner);

    assert.ok(res.reply.includes("GYM"));
    assert.ok(res.reply.includes("Cell E6"));
    assert.ok(!res.reply.includes("reminder has been scheduled"));
  });

  it("3. should handle relative tomorrow date: 'Meeting tomorrow at 3pm'", async () => {
    const mockRunner: ToolRunner = {
      executeTool: async (name: string, rawArgs: unknown) => {
        const args = rawArgs as Record<string, unknown>;
        assert.equal(name, "create_event");
        assert.equal(args.title, "Meeting");
        assert.equal(args.date, "2026-10-02"); // Oct 1 + 1 day
        assert.equal(args.time, "3:00 PM");

        return {
          status: "created",
          date: "2026-10-02",
          label: "MEETING 3:00 PM",
          cell: "E6",
          reminderSet: true,
          reminderTime: "2:55 PM",
        };
      },
      findEventsDetailed: async () => [],
    };

    const res = await runSmartAgent(null, dummyUser, BASE_TODAY, "Meeting tomorrow at 3pm", [], mockRunner);

    assert.ok(res.reply.includes("MEETING 3:00 PM"));
    assert.ok(res.reply.includes("tomorrow"));
    assert.ok(res.reply.includes("2:55 PM"));
  });

  it("4. should handle academic course: 'CSE340 Quiz 2 on tomorrow at 3pm'", async () => {
    const mockRunner: ToolRunner = {
      executeTool: async (name: string, rawArgs: unknown) => {
        const args = rawArgs as Record<string, unknown>;
        assert.equal(name, "create_event");
        assert.equal(args.course, "CSE340");
        assert.equal(args.title, "Quiz 2");
        assert.equal(args.date, "2026-10-02");
        assert.equal(args.time, "3:00 PM");

        return {
          status: "created",
          date: "2026-10-02",
          label: "CSE340 QUIZ 2 3:00 PM",
          cell: "F6",
          reminderSet: true,
          reminderTime: "2:55 PM",
        };
      },
      findEventsDetailed: async () => [],
    };

    const res = await runSmartAgent(null, dummyUser, BASE_TODAY, "CSE340 Quiz 2 on tomorrow at 3pm", [], mockRunner);

    assert.ok(res.reply.includes("CSE340 QUIZ 2 3:00 PM"));
  });

  it("5. should handle schedule queries: 'What do I have today?'", async () => {
    const mockRunner: ToolRunner = {
      executeTool: async (name: string) => {
        assert.equal(name, "get_today_schedule");
        return {
          date: "2026-10-01",
          items: [{ text: "CSE340 LECTURE", status: "pending" }],
        };
      },
      findEventsDetailed: async () => [],
    };

    const res = await runSmartAgent(null, dummyUser, BASE_TODAY, "What do I have today?", [], mockRunner);

    assert.ok(res.reply.includes("CSE340 LECTURE"));
    assert.ok(res.reply.includes("PENDING"));
  });

  it("6. should handle 'help' intent", async () => {
    const res = await runSmartAgent(null, dummyUser, BASE_TODAY, "help");
    assert.ok(res.reply.includes("I'm Excela"));
    assert.ok(res.reply.includes("Add timed tasks"));
  });
});
