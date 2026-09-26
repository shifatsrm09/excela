import { ObjectId } from "mongodb";
import { getSessionUser, isPlannerRequest } from "@/lib/auth";
import { discordEventsCollection } from "@/lib/discord";

export const runtime = "nodejs";

export async function GET(request: Request) {
  if (!isPlannerRequest(request)) return Response.json({ error: "Submit requests from Excela." }, { status: 403 });
  const current = await getSessionUser(request);
  if (!current) return Response.json({ error: "Sign in with Google.", code: "auth" }, { status: 401 });
  const collection = await discordEventsCollection();
  const items = await collection.find({ userId: current.user._id, status: "pending" }).sort({ createdAt: -1 }).limit(50).toArray();
  return Response.json({ items: items.map(({ _id, userId, ...item }) => ({ id: _id?.toString(), ...item })) });
}

export async function POST(request: Request) {
  if (!isPlannerRequest(request)) return Response.json({ error: "Submit requests from Excela." }, { status: 403 });
  const current = await getSessionUser(request);
  if (!current) return Response.json({ error: "Sign in with Google.", code: "auth" }, { status: 401 });
  let body: any;
  try { body = await request.json(); } catch { return Response.json({ error: "Invalid JSON." }, { status: 400 }); }
  if (typeof body?.id !== "string" || !ObjectId.isValid(body.id) || !["approved", "ignored"].includes(body.status)) return Response.json({ error: "Invalid pending event." }, { status: 400 });
  const collection = await discordEventsCollection();
  const result = await collection.updateOne({ _id: new ObjectId(body.id), userId: current.user._id, status: "pending" }, { $set: { status: body.status, updatedAt: new Date() } });
  if (!result.matchedCount) return Response.json({ error: "Pending event was not found or was already handled." }, { status: 404 });
  return Response.json({ ok: true });
}
