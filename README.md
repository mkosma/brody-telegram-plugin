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

With Claude Code running from the previous step, DM your bot on Telegram — it replies with a 6-character pairing code. If the bot doesn't respond, make sure your session is running with `--channels`. In a terminal:

```
edit-telegram-access <Agent> pair <code>
```

Your next DM reaches the assistant.

> Unlike Discord, there's no server invite step — Telegram bots accept DMs immediately. Pairing handles the user-ID lookup so you never touch numeric IDs.

**6. Lock it down.**

Pairing is for capturing IDs. Once you're in, switch to `allowlist` so strangers don't get pairing-code replies. Set `dmPolicy` to `allowlist` in the bot's `access.json` (`edit-telegram-access` has no policy verb yet).

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
| `pin_message` | (fork addition) Pin the bot's own one-line question in its chat or topic. Refused for any other message, and for a second pin in the same topic. In a group it needs the admin right `can_pin_messages` and says so when it is missing. The bridge unpins it when the allowlisted user replies to it, taps one of its buttons or puts a 👍 on it; after 24 hours unanswered it is filed with `interrupt add --tier blocker`. |
| `unpin_message` | (fork addition) Unpin a message this bot pinned. |
| `list_pins` | (fork addition) List the pins this bot holds, from `pins.json` in its state dir. |

Replies can also carry inline keyboard buttons (`reply_markup` with an `inline_keyboard` array); button taps arrive as `callback_query` events. The fork handles `open:<vault>:<path>` callbacks to open vault notes.

A button may carry `copy_text: {"text": "..."}` in place of `callback_data` (Bot API 7.11): a tap copies the text and sends no callback. The text is one line of at most 256 characters, or the reply is refused.

After a tap the bridge edits the message's keyboard: the chosen button becomes "✓ label" and the others are removed. A button that opens or shows something (`omf:`, `open:`, an alert's Show fix) is marked and the others stay. `pin-right-check.ts <Agent>` reports whether that agent's bot holds `can_pin_messages` in each of its groups.

Inbound messages trigger a typing indicator automatically - Telegram shows
"botname is typing…" while the assistant works on a response.

## What a deploy changes without a restart

The server does not import `outbound.ts` at launch. It loads it through `outbound-loader.ts`, which compares the file's mtime and size before each tool call and imports the file again when either changed. When nothing changed the cost is that one stat.

**Live at the next tool call after the file changes on that host, with no restart:** everything in `outbound.ts`.

- The private-chat gate: the refusal, its wording and the table of named exemptions.
- Reference links: which references become links, the short repo names, and where nothing is linked.
- The send path of `reply`, `react` and `edit_message`: the format, the chunks, the copy-button check, and what goes to the post log and the tag relay.

`pin_message`, `unpin_message` and the forum-topic tools are not in that file, and the gate they call is, so a change to the gate is live for them too.

**A bad deploy cannot silence a bot.** A version that does not import, or lacks a function the server calls (`OUTBOUND_EXPORTS`), is not taken. The bridge keeps sending with the last version that loaded and raises one `fleet-andon --severity P2 --owner Grady --key bridge-reload:<host>`, once and not once per call. The first good version to load resolves it. A bridge launched on a file that does not load still listens; its posting tools fail with the reason until a good file lands.

**Still needs a restart, by construction:**

- A new or renamed tool, or a changed tool description or schema (the tool list is in `server.ts`).
- The MCP instructions text.
- The inbound loop: the poll, the gates, the handlers, the commands, the taps and the reactions.
- A call site in `server.ts` that takes a new exemption. The row in the table is live; the call that names it is not.
- Every file other than `outbound.ts`, including the ones it imports (`post-log.ts`, `tag-relay.ts`) and the loader itself.
- The channel flag and every context file (`CLAUDE.md`, `FLEET.md`, the charters), which a session reads at launch.

Between tool calls a session keeps the version it last loaded: the bridge's own posts (a tap answer, a pairing reply) are checked by that version, and take the new one after the session's next tool call.

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
