import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ObjectId } from "mongodb";
import type { UserDoc } from "@/lib/models";
import { runSmartAgent, resolveRecentEventFromHistory, type ToolRunner, type AgentMessage } from "@/lib/agent/agent";
import { matchEventText } from "@/lib/planner-service";

describe("Smart String Agent - Context resolution & No markdown asterisks", () => {
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

  const BASE_TODAY = "2026-11-12";

  it("1. should never output literal markdown asterisks (**) in replies", async () => {
    const mockRunner: ToolRunner = {
      executeTool: async () => ({
        status: "created",
        date: "2026-11-27",
        label: "CSE550 QUIZ",
        cell: "E29",
        reminderSet: false,
      }),
      findEventsDetailed: async () => [],
    };

    const res = await runSmartAgent(null, dummyUser, BASE_TODAY, "nov 27 cse 550 quiz", [], mockRunner);

    assert.ok(!res.reply.includes("**"), "Reply must not contain literal markdown asterisks");
    assert.equal(res.reply, "Added CSE550 QUIZ to your planner for Nov 27, 2026 (Cell E29).");
  });

  it("2. should NOT match short pronoun 'it' inside unrelated words like 'COMPETITION'", () => {
    const score = matchEventText("CONGRESS DAY DIU AI COMPETITION", "it");
    assert.equal(score, 0, "Pronoun 'it' must have score 0 against 'COMPETITION'");
  });

  it("3. should correctly resolve 'delete it' to the last created event from conversation history", async () => {
    // Exact scenario from user's screenshot:
    const history: AgentMessage[] = [
      { role: "user", content: "nov 27 cse 550 quiz" },
      { role: "assistant", content: "Added CSE550 QUIZ to your planner for Nov 27, 2026 (Cell E29)." },
    ];

    const resolved = resolveRecentEventFromHistory(history);
    assert.ok(resolved);
    assert.equal(resolved.label, "CSE550 QUIZ");
    assert.equal(resolved.cell, "E29");

    let deletedCell = "";
    const mockRunner: ToolRunner = {
      executeTool: async (name: string, rawArgs: unknown) => {
        if (name === "delete_event") {
          const args = rawArgs as { cell: string; sheetId: number };
          deletedCell = args.cell;
          return { ok: true };
        }
        return {};
      },
      findEventsDetailed: async () => {
        // Return two events on the sheet: an unrelated one with 'competition' and the real quiz
        return [
          {
            date: "2026-11-27",
            sheet: "Nov 2026",
            sheetId: 100,
            rowIndex: 28,
            text: "CSE550 QUIZ",
            status: "pending",
            cell: "E29",
            column: "E",
          },
        ];
      },
    };

    const res = await runSmartAgent(null, dummyUser, BASE_TODAY, "delete it", history, mockRunner);

    assert.equal(deletedCell, "E29", "Must delete cell E29 belonging to CSE550 QUIZ");
    assert.ok(res.reply.includes("Deleted CSE550 QUIZ from your planner"));
    assert.ok(res.reply.includes("Cell E29"));
    assert.ok(!res.reply.includes("COMPETITION"));
    assert.ok(!res.reply.includes("**"));
  });

  it("4. should prompt for event name if user says 'delete it' with empty history", async () => {
    const res = await runSmartAgent(null, dummyUser, BASE_TODAY, "delete it", []);
    assert.ok(res.reply.includes("Which event would you like to delete?"));
  });

  it("5. should resolve 'mark it complete' to recent event from history", async () => {
    const history: AgentMessage[] = [
      { role: "user", content: "nov 27 cse 550 quiz" },
      { role: "assistant", content: "Added CSE550 QUIZ to your planner for Nov 27, 2026 (Cell E29)." },
    ];

    let completedCell = "";
    const mockRunner: ToolRunner = {
      executeTool: async (name: string, rawArgs: unknown) => {
        if (name === "mark_complete") {
          const args = rawArgs as { cell: string; sheetId: number };
          completedCell = args.cell;
          return { ok: true };
        }
        return {};
      },
      findEventsDetailed: async () => [
        {
          date: "2026-11-27",
          sheet: "Nov 2026",
          sheetId: 100,
          rowIndex: 28,
          text: "CSE550 QUIZ",
          status: "pending",
          cell: "E29",
          column: "E",
        },
      ],
    };

    const res = await runSmartAgent(null, dummyUser, BASE_TODAY, "mark it complete", history, mockRunner);

    assert.equal(completedCell, "E29");
    assert.ok(res.reply.includes("Marked CSE550 QUIZ"));
    assert.ok(!res.reply.includes("**"));
  });

  it("6. should format clean help output with zero asterisks or backticks", async () => {
    const res = await runSmartAgent(null, dummyUser, BASE_TODAY, "help");
    assert.ok(!res.reply.includes("**"));
    assert.ok(!res.reply.includes("`"));
    assert.ok(res.reply.includes("Hi! I'm Excela"));
  });
});
