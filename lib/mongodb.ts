import { MongoClient, type Db } from "mongodb";
import type {
  SessionDoc,
  TaskReminderDoc,
  TelegramConversationDoc,
  TelegramLinkingTokenDoc,
  TelegramProcessedUpdateDoc,
  UserDoc,
} from "@/lib/models";
import type { PendingConfirmation } from "@/lib/agent/confirmations";

// Cache the connection on globalThis so dev-server reloads and serverless
// invocations reuse one client instead of opening a new pool every time.
const globalForMongo = globalThis as unknown as { excelaDb?: Promise<Db>; excelaIndexes?: Promise<unknown> };

export function getDb(): Promise<Db> {
  if (!globalForMongo.excelaDb) {
    const uri = process.env.MONGODB_URI;
    if (!uri) return Promise.reject(new Error("MONGODB_URI is missing."));
    globalForMongo.excelaDb = (async () => {
      // Small pool: each serverless instance keeps its own, and Atlas free tiers cap total connections.
      const client = new MongoClient(uri, { serverSelectionTimeoutMS: 10_000, maxPoolSize: 10 });
      await client.connect();
      // The database name comes from the URI path (/Excela). MongoDB creates it on first write.
      const db = client.db();
      // Indexes are created in the background so they don't slow down the first request on a cold start.
      globalForMongo.excelaIndexes = Promise.all([
        db.collection<UserDoc>("users").createIndex({ googleId: 1 }, { unique: true }),
        db.collection<UserDoc>("users").createIndex({ email: 1 }),
        db.collection<UserDoc>("users").createIndex({ "telegram.id": 1 }, { unique: true, sparse: true }),
        db.collection<UserDoc>("users").createIndex({ "dailyNotification.enabled": 1, "dailyNotification.nextRunAt": 1 }, { sparse: true }),
        db.collection<SessionDoc>("sessions").createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
        db.collection<SessionDoc>("sessions").createIndex({ userId: 1 }),
        db.collection<PendingConfirmation>("pending_confirmations").createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
        db.collection<TelegramLinkingTokenDoc>("telegram_linking_tokens").createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
        db.collection<TelegramConversationDoc>("telegram_conversations").createIndex({ updatedAt: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 }),
        db.collection<TelegramProcessedUpdateDoc>("telegram_processed_updates").createIndex({ createdAt: 1 }, { expireAfterSeconds: 3600 }),
        db.collection<TaskReminderDoc>("task_reminders").createIndex({ enabled: 1, scheduledFor: 1, sentAt: 1 }, { sparse: true }),
        db.collection<TaskReminderDoc>("task_reminders").createIndex({ userId: 1, date: 1, time: 1, title: 1 }),
        db.collection<TaskReminderDoc>("task_reminders").createIndex({ userId: 1, enabled: 1 }),
      ]).catch((error) => {
        console.error("Creating MongoDB indexes failed:", error instanceof Error ? error.message : error);
      });
      return db;
    })().catch((error) => {
      globalForMongo.excelaDb = undefined; // allow a retry on the next request
      throw error;
    });
  }
  return globalForMongo.excelaDb;
}

// Call before writing new users, so the unique index on googleId is guaranteed to exist first.
export async function ensureIndexes() {
  await getDb();
  await globalForMongo.excelaIndexes;
}

export async function usersCollection() {
  return (await getDb()).collection<UserDoc>("users");
}

export async function sessionsCollection() {
  return (await getDb()).collection<SessionDoc>("sessions");
}

export async function telegramTokensCollection() {
  return (await getDb()).collection<TelegramLinkingTokenDoc>("telegram_linking_tokens");
}

export async function telegramConversationsCollection() {
  return (await getDb()).collection<TelegramConversationDoc>("telegram_conversations");
}

export async function telegramProcessedUpdatesCollection() {
  return (await getDb()).collection<TelegramProcessedUpdateDoc>("telegram_processed_updates");
}

export async function taskRemindersCollection() {
  return (await getDb()).collection<TaskReminderDoc>("task_reminders");
}


