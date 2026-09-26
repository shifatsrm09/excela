import { getSessionUser } from "@/lib/auth";
import { redirect } from "next/navigation";
import DiscordInbox from "./discord-inbox";

export default async function DiscordPage() {
  const current = await getSessionUser();
  if (!current) redirect("/");
  return <DiscordInbox />;
}
