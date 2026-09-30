import { processDueNotifications } from "@/lib/telegram/auto-notify";
import { processDueReminders } from "@/lib/telegram/reminders";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(request: Request) {
  return handleCron(request);
}

export async function POST(request: Request) {
  return handleCron(request);
}

async function handleCron(request: Request) {
  const authHeader = request.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;

  if (cronSecret) {
    if (authHeader !== `Bearer ${cronSecret}`) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }
  } else if (process.env.NODE_ENV === "production") {
    return Response.json({ error: "CRON_SECRET is not configured on production" }, { status: 401 });
  }

  try {
    const reminders = await processDueReminders();
    const daily = await processDueNotifications();
    return Response.json({ ok: true, reminders, daily });
  } catch (error) {
    console.error("Cron auto-notify execution error:", error);
    return Response.json(
      { ok: false, error: error instanceof Error ? error.message : "Internal error" },
      { status: 500 },
    );
  }
}
