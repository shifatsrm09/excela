import type { ObjectId } from "mongodb";
import { getDb } from "@/lib/mongodb";

export type DiscordEvent = {
  course: string;
  title: string;
  date: string;
};

export type DiscordPendingDoc = {
  _id?: ObjectId;
  userId: ObjectId;
  guildId: string;
  guildName?: string;
  channelId: string;
  channelName?: string;
  messageId: string;
  messageUrl?: string;
  author?: string;
  contentPreview?: string;
  events: DiscordEvent[];
  status: "pending" | "approved" | "ignored";
  createdAt: Date;
  updatedAt: Date;
};

export async function discordEventsCollection() {
  const db = await getDb();
  const collection = db.collection<DiscordPendingDoc>("discordEvents");
  await Promise.all([
    collection.createIndex({ userId: 1, status: 1, createdAt: -1 }),
    collection.createIndex({ userId: 1, messageId: 1 }, { unique: true }),
  ]);
  return collection;
}

export function eventFingerprint(event: DiscordEvent) {
  return [event.course, event.title, event.date]
    .map((value) => value.trim().toLowerCase().replace(/\s+/g, " "))
    .join("|");
}
