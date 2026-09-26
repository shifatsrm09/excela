import { buildInstruction } from "@/ai/pipelines";
import { decrypt } from "@/lib/crypto";
import { discordEventsCollection, eventFingerprint, type DiscordEvent } from "@/lib/discord";
import { usersCollection } from "@/lib/mongodb";
import { normalizeOllamaKey } from "@/lib/ollama-key";
import { IMAGE_TYPES, MAX_IMAGE_BYTES, type ImageInput } from "@/lib/image-input";

export const runtime = "nodejs";
export const maxDuration = 60;

const fields = ["course", "title", "date"] as const;

function validEvent(value: unknown): value is DiscordEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  if (fields.some((field) => typeof item[field] !== "string")) return false;
  const course = item.course as string;
  const title = item.title as string;
  const date = item.date as string;
  const full = /^\d{2}-\d{2}$/.test(date) ? `2000-${date}` : date;
  const parsed = new Date(`${full}T00:00:00Z`);
  return Boolean(title.trim()) && title.length <= 200 && course.length <= 80 &&
    /^(?:\d{4}-)?\d{2}-\d{2}$/.test(date) &&
    !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === full;
}

function imageIsValid(image: unknown): image is ImageInput {
  if (!image || typeof image !== "object") return false;
  const item = image as Record<string, unknown>;
  return typeof item.mimeType === "string" && IMAGE_TYPES.includes(item.mimeType as never) &&
    typeof item.data === "string" && item.data.length > 0 &&
    item.data.length <= 4 * Math.ceil(MAX_IMAGE_BYTES / 3) &&
    item.data.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(item.data);
}

export async function POST(request: Request) {
  if (!process.env.DISCORD_INTERNAL_SECRET || request.headers.get("x-excela-discord-secret") !== process.env.DISCORD_INTERNAL_SECRET) {
    return Response.json({ error: "Unauthorized." }, { status: 401 });
  }

  let body: any;
  try { body = await request.json(); } catch { return Response.json({ error: "Invalid JSON." }, { status: 400 }); }

  const required = ["userEmail", "guildId", "channelId", "messageId", "content"];
  if (required.some((key) => typeof body?.[key] !== "string")) return Response.json({ error: "Missing Discord message fields." }, { status: 400 });
  if (body.content.length > 20_000) return Response.json({ error: "Message is too long." }, { status: 400 });
  if (body.image && !imageIsValid(body.image)) return Response.json({ error: "Unsupported Discord image." }, { status: 400 });

  const users = await usersCollection();
  const user = await users.findOne({ email: body.userEmail.toLowerCase() });
  if (!user) return Response.json({ error: "No Excela account matches DISCORD_USER_EMAIL." }, { status: 404 });
  if (!user.ollamaApiKey || !user.sheetId) return Response.json({ error: "The Excela account needs a planner and Ollama API key first." }, { status: 409 });

  const collection = await discordEventsCollection();
  const existing = await collection.findOne({ userId: user._id, messageId: body.messageId });
  if (existing) return Response.json({ status: "already_processed", events: existing.events });

  const apiKey = normalizeOllamaKey(decrypt(user.ollamaApiKey));
  if (!apiKey) return Response.json({ error: "The saved Ollama API key is invalid." }, { status: 409 });
  const today = new Date().toISOString().slice(0, 10);
  const schema = {
    type: "object",
    properties: {
      accepted: { type: "boolean" },
      action: { type: "string", enum: ["add_events", "declined"] },
      events: { type: "array", items: { type: "object", properties: Object.fromEntries(fields.map((f) => [f, { type: "string" }])), required: [...fields], additionalProperties: false } },
    },
    required: ["accepted", "action", "events"],
    additionalProperties: false,
  };

  const image = body.image as ImageInput | undefined;
  const result = await fetch("https://ollama.com/api/chat", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gemma4:31b",
      stream: false,
      messages: [
        { role: "system", content: `${buildInstruction("academic", today)}\nThis source came from a Discord academic announcement. Ignore chat unrelated to academic planning. Return only JSON matching this schema: ${JSON.stringify(schema)}` },
        { role: "user", content: body.content.trim() || "Extract dated academic events from the attached Discord image.", ...(image ? { images: [image.data] } : {}) },
      ],
    }),
    signal: AbortSignal.timeout(60_000),
  });

  if (!result.ok) return Response.json({ error: `Ollama request failed (${result.status}).` }, { status: 502 });
  const data = await result.json();
  const raw = typeof data.message?.content === "string" ? data.message.content : "";
  let extracted: any;
  try { extracted = JSON.parse(raw.trim().replace(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i, "$1")); }
  catch { return Response.json({ error: "Ollama returned invalid JSON." }, { status: 502 }); }

  const events: DiscordEvent[] = Array.isArray(extracted?.events) && extracted.events.length <= 50 && extracted.events.every(validEvent)
    ? extracted.events.map((event: DiscordEvent) => ({ course: event.course.trim(), title: event.title.trim(), date: event.date }))
    : [];

  if (!extracted?.accepted || extracted?.action !== "add_events" || !events.length) {
    await collection.insertOne({ userId: user._id, guildId: body.guildId, guildName: body.guildName, channelId: body.channelId, channelName: body.channelName, messageId: body.messageId, messageUrl: body.messageUrl, author: body.author, contentPreview: body.content.slice(0, 500), events: [], status: "ignored", createdAt: new Date(), updatedAt: new Date() });
    return Response.json({ status: "ignored", events: [] });
  }

  const recent = await collection.find({ userId: user._id, status: { $in: ["pending", "approved"] } }).sort({ createdAt: -1 }).limit(500).toArray();
  const existingFingerprints = new Set(recent.flatMap((doc) => doc.events.map(eventFingerprint)));
  const fresh = events.filter((event) => !existingFingerprints.has(eventFingerprint(event)));

  await collection.insertOne({
    userId: user._id,
    guildId: body.guildId,
    guildName: body.guildName,
    channelId: body.channelId,
    channelName: body.channelName,
    messageId: body.messageId,
    messageUrl: body.messageUrl,
    author: body.author,
    contentPreview: body.content.slice(0, 500),
    events: fresh,
    status: fresh.length ? "pending" : "ignored",
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  return Response.json({ status: fresh.length ? "pending" : "duplicate", events: fresh });
}
