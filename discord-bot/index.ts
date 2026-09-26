import { Client, GatewayIntentBits, Events, Partials } from "discord.js";

const token = process.env.DISCORD_BOT_TOKEN;
const apiUrl = (process.env.EXCELA_API_URL || "https://localhost:3000").replace(/\/$/, "");
const secret = process.env.DISCORD_INTERNAL_SECRET;
const userEmail = process.env.DISCORD_USER_EMAIL?.toLowerCase();
const channelIds = new Set((process.env.DISCORD_CHANNEL_IDS || "").split(",").map((id: string) => id.trim()).filter(Boolean));
if (apiUrl.startsWith("https://localhost") && process.env.NODE_ENV !== "production") {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  console.warn("Local HTTPS certificate verification is disabled for the Discord bot only.");
}

if (!token || !secret || !userEmail || !channelIds.size) {
  throw new Error("Set DISCORD_BOT_TOKEN, DISCORD_INTERNAL_SECRET, DISCORD_USER_EMAIL and DISCORD_CHANNEL_IDS before starting the bot.");
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  partials: [Partials.Channel],
});

client.once(Events.ClientReady, (ready) => {
  console.log(`Excela Discord bot ready as ${ready.user.tag}`);
  console.log(`Monitoring ${channelIds.size} configured channel(s).`);
});

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot || !message.guild || !channelIds.has(message.channelId)) return;
  try {
    const images = message.attachments.filter((attachment) => ["image/png", "image/jpeg", "image/webp"].includes(attachment.contentType || "")).first();
    let image: { mimeType: string; data: string } | undefined;
    if (images) {
      const response = await fetch(images.url);
      if (response.ok) {
        const buffer = Buffer.from(await response.arrayBuffer());
        if (buffer.length <= 3 * 1024 * 1024) image = { mimeType: images.contentType!, data: buffer.toString("base64") };
      }
    }

    const response = await fetch(`${apiUrl}/api/discord/process`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-excela-discord-secret": secret },
      body: JSON.stringify({
        userEmail,
        guildId: message.guildId,
        guildName: message.guild.name,
        channelId: message.channelId,
        channelName: "name" in message.channel ? message.channel.name : undefined,
        messageId: message.id,
        messageUrl: message.url,
        author: message.author.tag,
        content: message.content,
        ...(image ? { image } : {}),
      }),
    });
    const data = await response.json();
    if (!response.ok) console.error("Discord processing failed:", data.error || response.status);
    else console.log(`[${message.channelId}] ${data.status}: ${data.events?.length || 0} event(s)`);
  } catch (error) {
    console.error("Discord message processing error:", error);
  }
});

client.login(token);
