import { getSessionUser, isPlannerRequest } from "@/lib/auth";
import { decrypt } from "@/lib/crypto";
import { normalizeOllamaKey } from "@/lib/ollama-key";
import { parseToday } from "@/lib/agent/dates";
import { AgentError, runSmartAgent, type AgentMessage } from "@/lib/agent/agent";

// Dedicated agent endpoint for Excela Smart. The client sends conversation messages; the
// authenticated user, their planner, and their Ollama key are all resolved server-side.
export const maxDuration = 60;

function isValidAgentMessage(item: unknown): item is AgentMessage {
  if (!item || typeof item !== "object") return false;
  const role = (item as { role?: unknown }).role;
  if (role !== "user" && role !== "assistant" && role !== "tool" && role !== "system") return false;
  const content = (item as { content?: unknown }).content;
  return typeof content === "string";
}

export async function POST(request: Request) {
  if (!isPlannerRequest(request)) {
    return Response.json({ error: "Submit requests from Excela." }, { status: 403 });
  }

  let apiKey: string | null;
  let userDoc;
  try {
    const current = await getSessionUser(request);
    if (!current) {
      return Response.json({ error: "Sign in with Google to use Excela.", code: "auth" }, { status: 401 });
    }
    userDoc = current.user;
    apiKey = userDoc.ollamaApiKey ? decrypt(userDoc.ollamaApiKey) : null;
    apiKey = apiKey ? normalizeOllamaKey(apiKey) : null;
    if (!userDoc.sheetId) {
      return Response.json({ error: "Connect your Google Sheets planner in Setup first.", code: "no_sheet" }, { status: 409 });
    }
  } catch {
    return Response.json({ error: "Could not reach the database. Please try again." }, { status: 503 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  let userMessage = "";
  let incomingHistory: AgentMessage[] = [];

  if (typeof body === "object" && body !== null) {
    if ("messages" in body && Array.isArray((body as { messages?: unknown }).messages)) {
      const rawMessages = (body as { messages: unknown[] }).messages;
      const validMessages = rawMessages.filter(isValidAgentMessage);
      if (!validMessages.length) {
        return Response.json({ error: "Provide at least one message." }, { status: 400 });
      }
      const last = validMessages[validMessages.length - 1];
      if (last.role !== "user" || !last.content.trim() || last.content.length > 4_000) {
        return Response.json({ error: "The latest message must be user text up to 4,000 characters." }, { status: 400 });
      }
      userMessage = last.content.trim();
      incomingHistory = validMessages.slice(0, -1);
    } else if ("message" in body && typeof (body as { message?: unknown }).message === "string") {
      const rawMsg = (body as { message: string }).message.trim();
      if (!rawMsg || rawMsg.length > 4_000) {
        return Response.json({ error: "Provide message text, up to 4,000 characters." }, { status: 400 });
      }
      userMessage = rawMsg;
      if ("history" in body && Array.isArray((body as { history?: unknown }).history)) {
        incomingHistory = (body as { history: unknown[] }).history.filter(isValidAgentMessage);
      }
    } else {
      return Response.json({ error: "Provide message text or a messages array." }, { status: 400 });
    }
  } else {
    return Response.json({ error: "Invalid request payload." }, { status: 400 });
  }

  const serverToday = new Date().toISOString().slice(0, 10);
  const clientToday = parseToday(body && typeof body === "object" && "today" in body ? (body as { today?: unknown }).today : undefined);
  const today = clientToday && Math.abs(Date.parse(clientToday) - Date.parse(serverToday)) <= 2 * 86_400_000
    ? clientToday
    : serverToday;

  try {
    const { reply, log, history } = await runSmartAgent(apiKey, userDoc, today, userMessage, incomingHistory);
    return Response.json({
      reply,
      toolCalls: log.map(({ name, ok }) => ({ name, ok })),
      history,
    });
  } catch (error) {
    if (error instanceof AgentError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    return Response.json(
      { error: "Could not connect to Ollama or process its response. The request may have timed out. Please try again." },
      { status: 502 },
    );
  }
}
