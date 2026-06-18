# Telegram (brody fork)

Connect a Telegram bot to your Claude Code with an MCP server.

The MCP server logs into Telegram as a bot and provides tools to Claude to reply, react, or edit messages. When you message the bot, the server forwards the message to your Claude Code session.

> This is a fork of the official `claude-plugins-official` Telegram plugin. It adds forum-topic support (`create_forum_topic` + `message_thread_id`), inline keyboard buttons, expanded `callback_query` surfacing, an `open:` callback handler that opens vault notes, and a `download_attachment` tool. See the fork rationale and load-mechanism decision in `monty-ops/telegram/telegram-plugin-fork-plan.md`. The exact plugin/channel name used to launch depends on how this fork is installed (see step 4).

## Prerequisites

- [Bun](https://bun.sh) — the MCP server runs on Bun. Install with `curl -fsSL https://bun.sh/install | bash`.

## Quick Setup
> Default pairing flow for a single-user DM bot. See [ACCESS.md](./ACCESS.md) for groups and multi-user setups.

**1. Create a bot with BotFather.**

Open a chat with [@BotFather](https://t.me/BotFather) on Telegram and send `/newbot`. BotFather asks for two things:

- **Name** — the display name shown in chat headers (anything, can contain spaces)
- **Username** — a unique handle ending in `bot` (e.g. `my_assistant_bot`). This becomes your bot's link: `t.me/my_assistant_bot`.

BotFather replies with a token that looks like `123456789:AAHfiqksKZ8...` — that's the whole token, copy it including the leading number and colon.

**2. Install the plugin.**

These are Claude Code commands - run `claude` to start a session first.

Install the upstream plugin (the fork shadows it locally; the marketplace copy is left untouched):
```
/plugin install telegram@claude-plugins-official
/reload-plugins
```

To run this fork instead of the marketplace copy, point Claude Code at this directory rather than re-installing. The two supported mechanisms (a `~/.claude/settings.json` plugin-path override, or a launch-command override) are described in `monty-ops/telegram/telegram-plugin-fork-plan.md`. Keep the bot token out of this repo: it lives in `~/.claude/channels/telegram/.env`.

**3. Give the server the token.**

```
/telegram:configure 123456789:AAHfiqksKZ8...
```

Writes `TELEGRAM_BOT_TOKEN=...` to `~/.claude/channels/telegram/.env`. You can also write that file by hand, or set the variable in your shell environment — shell takes precedence.

> To run multiple bots on one machine (different tokens, separate allowlists), point `TELEGRAM_STATE_DIR` at a different directory per instance.

**4. Relaunch with the channel flag.**

The server won't connect without this. A plain `claude` session gets the bot's outbound tools but NOT the inbound notification-to-turn listener: messages are silently dropped. You must relaunch with `--channels`. Exit your session and start a new one:

```sh
claude --channels plugin:telegram@claude-plugins-official
```

That command loads the marketplace copy. To launch this fork, substitute the plugin/channel name the fork is installed under per step 2 (for the dev `.mcp.json` path the form is `--dangerously-load-development-channels server:telegram`, which the auto-mode classifier blocks without explicit authorization). The fleet's working launcher uses `claude --channels plugin:telegram@claude-plugins-official` in tmux (see `monty-ops/sre/watchdog.sh`).

**5. Pair.**

With Claude Code running from the previous step, DM your bot on Telegram — it replies with a 6-character pairing code. If the bot doesn't respond, make sure your session is running with `--channels`. In your Claude Code session:

```
/telegram:access pair <code>
```

Your next DM reaches the assistant.

> Unlike Discord, there's no server invite step — Telegram bots accept DMs immediately. Pairing handles the user-ID lookup so you never touch numeric IDs.

**6. Lock it down.**

Pairing is for capturing IDs. Once you're in, switch to `allowlist` so strangers don't get pairing-code replies. Ask Claude to do it, or `/telegram:access policy allowlist` directly.

## Access control

See **[ACCESS.md](./ACCESS.md)** for DM policies, groups, mention detection, delivery config, skill commands, and the `access.json` schema.

Quick reference: IDs are **numeric user IDs** (get yours from [@userinfobot](https://t.me/userinfobot)). Default policy is `pairing`. `ackReaction` only accepts Telegram's fixed emoji whitelist.

## Tools exposed to the assistant

| Tool | Purpose |
| --- | --- |
| `reply` | Send to a chat. Takes `chat_id` + `text`, optionally `reply_to` (message ID) for native threading and `files` (absolute paths) for attachments. Images (`.jpg`/`.png`/`.gif`/`.webp`) send as photos with inline preview; other types send as documents. Max 50MB each. Auto-chunks text; files send as separate messages after the text. Returns the sent message ID(s). |
| `react` | Add an emoji reaction to a message by ID. **Only Telegram's fixed whitelist** is accepted (👍 👎 ❤ 🔥 👀 etc). |
| `edit_message` | Edit a message the bot previously sent. Useful for "working…" to result progress updates. Only works on the bot's own messages. |
| `download_attachment` | (fork addition) Fetch a file by `file_id` from an inbound message and return its local path so the assistant can `Read` it. |
| `create_forum_topic` | (fork addition) Create a forum topic in a supergroup (Bot API 9.4) and return its `message_thread_id`, so replies can be threaded into topics. |

Replies can also carry inline keyboard buttons (`reply_markup` with an `inline_keyboard` array); button taps arrive as `callback_query` events. The fork handles `open:<vault>:<path>` callbacks to open vault notes.

Inbound messages trigger a typing indicator automatically - Telegram shows
"botname is typing…" while the assistant works on a response.

## Photos

Inbound photos are downloaded to `~/.claude/channels/telegram/inbox/` and the
local path is included in the `<channel>` notification so the assistant can
`Read` it. Telegram compresses photos — if you need the original file, send it
as a document instead (long-press → Send as File).

## No history or search

Telegram's Bot API exposes **neither** message history nor search. The bot
only sees messages as they arrive - no `fetch_messages` tool exists. If the
assistant needs earlier context, it will ask you to paste or summarize.

Photos are still downloaded eagerly on arrival (there is no way to fetch a
historical message later). The fork's `download_attachment` tool fetches
non-photo attachments by `file_id` from the inbound message as it arrives.
