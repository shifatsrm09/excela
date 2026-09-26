# Excela Discord Assist

This is the first Discord integration for Excela. It uses a real Discord bot account, monitors only explicitly configured channel IDs, sends matching messages through the existing academic AI pipeline, stores the extracted events in MongoDB, and waits for user approval at `/discord` before changing Google Sheets.

## Architecture

```text
Discord channel
   -> discord-bot/index.ts
   -> POST /api/discord/process
   -> Ollama + existing academic prompt
   -> validation
   -> Discord message-id + event duplicate detection
   -> MongoDB discordEvents
   -> /discord review page
   -> /api/sync
   -> Google Sheets
```

## 1. Create the Discord bot

Create a Discord application and bot, enable the Message Content privileged intent, and invite the bot to a test server with permission to view the monitored channels and read message history.

For the first test, use one private/test channel rather than a large university server.

## 2. Install dependencies

From the project directory:

```bash
npm install
```

The Discord bot uses `discord.js` and `tsx`.

## 3. Environment variables

Add these to `.env`:

```env
DISCORD_BOT_TOKEN=your_bot_token
DISCORD_INTERNAL_SECRET=a_long_random_secret
DISCORD_USER_EMAIL=the_google_email_used_for_your_excela_account
DISCORD_CHANNEL_IDS=123456789012345678
EXCELA_API_URL=https://localhost:3000
```

For several channels:

```env
DISCORD_CHANNEL_IDS=111111111111111111,222222222222222222
```

`DISCORD_USER_EMAIL` is intentionally simple for the first version: the bot sends matching announcements to one existing Excela account. A future version can replace this with Discord/Excela account linking.

## 4. Start Excela

Terminal 1:

```bash
npm run dev
```

The existing development command uses HTTPS, so the local URL is:

```text
https://localhost:3000
```

## 5. Start the Discord bot

Terminal 2:

```bash
npm run discord
```

You should see:

```text
Excela Discord bot ready as ...
Monitoring 1 configured channel(s).
```

## 6. Test

Post an announcement in one configured channel:

```text
CSE422 Quiz 2 will be held on October 5.
```

The bot should log something like:

```text
[CHANNEL_ID] pending: 1 event(s)
```

Then open:

```text
https://localhost:3000/discord
```

Review the event and click **Add to planner**. Excela then calls the existing `/api/sync` route, so the same Google Sheets validation and duplicate protection used by manual injection remain in place.

## Duplicate protection

There are two Discord-side checks:

1. The Discord message ID is stored, so the same message is never processed twice.
2. Extracted events are fingerprinted using course + title + date, so two different Discord messages announcing the same event do not create two pending items.

The existing Google Sheets sync remains the final duplicate check.

## Images

The bot also downloads the first PNG/JPEG/WebP image attachment from a monitored message when it is at most 3 MB and sends it to the same AI endpoint as image source material.

## Important first-version limitation

This version intentionally uses one `DISCORD_USER_EMAIL` and one list of monitored channel IDs. It is designed for a personal/student deployment and testing. Multi-user Discord account linking, per-user channel configuration, automatic mode, and edited-message synchronization should be added after this version is working end-to-end.
