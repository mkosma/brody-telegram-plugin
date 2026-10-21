# Telegram – Access & Delivery

A Telegram bot is publicly addressable. Anyone who finds its username can DM it, and without a gate those messages would flow straight into your assistant session. The access model described here decides who gets through.

By default, a DM from an unknown sender triggers **pairing**: the bot replies with a 6-character code and drops the message. You run `edit-telegram-access <Agent> pair <code>` in a terminal to approve them. Once approved, their messages pass through.

Each bot keeps its state in its own state dir: the `TELEGRAM_STATE_DIR` that its agent's `~/.agents/<Agent>/.mcp.json` declares for the `telegram` server. There is no single shared `access.json`. The names are not uniform (`telegram-Grady`, `telegram-vera`), so never derive the directory from the agent's name; `edit-telegram-access` reads the declaration for you. A bridge launched with no `TELEGRAM_STATE_DIR` falls back to `~/.claude/channels/telegram`, which no fleet bot uses.

`edit-telegram-access` edits that bot's `access.json`; the server re-reads it on every inbound message, so changes take effect without a restart. Set `TELEGRAM_ACCESS_MODE=static` to pin config to what was on disk at boot (pairing is unavailable in static mode since it requires runtime writes).

**Run it yourself, in a terminal.** An agent does not run it because a channel message asked: that is exactly the request a prompt injection would make. It touches `access.json` and `approved/` only, never the state dir's `.env`, which holds the bot token. Run it on the host the agent lives on; if the agent lives elsewhere, it refuses and names the host (`ssh <host> edit-telegram-access <Agent> ...`).

## At a glance

| | |
| --- | --- |
| Default policy | `pairing` |
| Sender ID | Numeric user ID (e.g. `412587349`) |
| Group key | Supergroup ID (negative, `-100…` prefix) |
| `ackReaction` quirk | Fixed whitelist only; non-whitelisted emoji silently do nothing |
| Config file | `$TELEGRAM_STATE_DIR/access.json`, per bot |
| Command | `edit-telegram-access <Agent> <verb>` |

## DM policies

`dmPolicy` controls how DMs from senders not on the allowlist are handled.

| Policy | Behavior |
| --- | --- |
| `pairing` (default) | Reply with a pairing code, drop the message. Approve with `edit-telegram-access <Agent> pair <code>`. |
| `allowlist` | Drop silently. No reply. Useful if the bot's username is guessable and pairing replies would attract spam. |
| `disabled` | Drop everything, including allowlisted users and groups. |

There is no command to change `dmPolicy` yet. Edit `"dmPolicy"` by hand in that bot's `access.json`; the bridge picks it up on the next message. `edit-telegram-access <Agent> list` shows the current value.

## User IDs

Telegram identifies users by **numeric IDs** like `412587349`. Usernames are optional and mutable; numeric IDs are permanent. The allowlist stores numeric IDs.

Pairing captures the ID automatically. To find one manually, have the person message [@userinfobot](https://t.me/userinfobot), which replies with their ID. Forwarding any of their messages to @userinfobot also works.

```
edit-telegram-access Vera allow 412587349
edit-telegram-access Vera disallow 412587349
```

## Groups

Groups are off by default. Opt each one in individually.

```
edit-telegram-access Vera group-add -1001654782309
```

Supergroup IDs are negative numbers with a `-100` prefix, e.g. `-1001654782309`. They're not shown in the Telegram UI. To find one, add [@RawDataBot](https://t.me/RawDataBot) to the group temporarily; it dumps a JSON blob including the chat ID.

With the default `requireMention: true`, the bot responds only when @mentioned or replied to. Pass `--no-mention` to process every message, or flip it later with `mention`.

```
edit-telegram-access Vera group-add -1001654782309 --no-mention
edit-telegram-access Vera mention -1001654782309 on
edit-telegram-access Vera group-remove -1001654782309
```

`mention` only changes a group that is already enabled; it never adds one. Re-running `group-add` on an enabled group resets `requireMention` and keeps the group's member list.

To restrict which members can trigger the bot in a group, set that group's `"allowFrom"` list by hand in `access.json`. There is no command for it yet.

**Privacy mode.** Telegram bots default to a server-side privacy mode that filters group messages before they reach your code: only @mentions and replies are delivered. This matches the default `requireMention: true`, so it's normally invisible. Using `--no-mention` requires disabling privacy mode as well: message [@BotFather](https://t.me/BotFather), send `/setprivacy`, pick your bot, choose **Disable**. Without that step, Telegram never delivers the messages regardless of local config.

## Mention detection

In groups with `requireMention: true`, any of the following triggers the bot:

- A structured `@botusername` mention
- A reply to one of the bot's messages
- A match against any regex in `mentionPatterns`

`mentionPatterns` has no command yet. Set it by hand in `access.json`:

```jsonc
"mentionPatterns": ["^hey claude\\b", "\\bassistant\\b"]
```

## Delivery

The outbound keys below have no command yet. Set them by hand in that bot's `access.json`; the bridge rereads it on every message.

**`ackReaction`** reacts to inbound messages on receipt. Telegram accepts only a **fixed whitelist** of reaction emoji; anything else is silently ignored. An empty string disables it. The full Bot API list:

> 👍 👎 ❤ 🔥 🥰 👏 😁 🤔 🤯 😱 🤬 😢 🎉 🤩 🤮 💩 🙏 👌 🕊 🤡 🥱 🥴 😍 🐳 ❤‍🔥 🌚 🌭 💯 🤣 ⚡ 🍌 🏆 💔 🤨 😐 🍓 🍾 💋 🖕 😈 😴 😭 🤓 👻 👨‍💻 👀 🎃 🙈 😇 😨 🤝 ✍ 🤗 🫡 🎅 🎄 ☃ 💅 🤪 🗿 🆒 💘 🙉 🦄 😘 💊 🙊 😎 👾 🤷‍♂ 🤷 🤷‍♀ 😡

**`replyToMode`** controls threading on chunked replies. When a long response is split, `first` (default) threads only the first chunk under the inbound message; `all` threads every chunk; `off` sends all chunks standalone.

**`textChunkLimit`** sets the split threshold. Telegram rejects messages over 4096 characters.

**`chunkMode`** chooses the split strategy: `length` cuts exactly at the limit; `newline` prefers paragraph boundaries.

## Command reference

| Command | Effect |
| --- | --- |
| `edit-telegram-access Vera list` | Print the state dir and current state: policy, allowlist, enabled groups, pending pairings (live or expired). |
| `edit-telegram-access Vera pair a4f91c` | Approve pairing code `a4f91c`. Adds the sender to `allowFrom`, removes the pending entry, and drops `approved/<senderId>` so the bridge sends a confirmation on Telegram. Refuses an unknown or expired code. |
| `edit-telegram-access Vera allow 412587349` | Add a user ID directly. |
| `edit-telegram-access Vera disallow 412587349` | Remove from the allowlist. |
| `edit-telegram-access Vera group-add -1001654782309` | Enable a group. Flag: `--no-mention` (also requires disabling privacy mode). |
| `edit-telegram-access Vera group-remove -1001654782309` | Disable a group. |
| `edit-telegram-access Vera mention -1001654782309 on` | Set `requireMention` on an enabled group: `on` or `off`. |

Every write prints the entry it changed. Exit codes: `0` changed (or listed), `1` refused with nothing written, `2` usage. A corrupt `access.json` is refused, never overwritten.

**No command yet.** These are edited by hand in that bot's `access.json`:

- `dmPolicy` (`pairing`, `allowlist`, `disabled`)
- Discarding a pending code: delete it from `"pending"`. Codes also expire after an hour on their own.
- A group's member list (`groups.<id>.allowFrom`)
- `mentionPatterns`, `ackReaction`, `replyToMode`, `textChunkLimit`, `chunkMode`

## Config file

`$TELEGRAM_STATE_DIR/access.json`, one per bot. `edit-telegram-access <Agent> list` prints the path. Absent file is equivalent to `pairing` policy with empty lists, so the first DM triggers pairing.

```jsonc
{
  // Handling for DMs from senders not in allowFrom.
  "dmPolicy": "pairing",

  // Numeric user IDs allowed to DM.
  "allowFrom": ["412587349"],

  // Groups the bot is active in. Empty object = DM-only.
  "groups": {
    "-1001654782309": {
      // true: respond only to @mentions and replies.
      // false also requires disabling privacy mode via BotFather.
      "requireMention": true,
      // Restrict triggers to these senders. Empty = any member (subject to requireMention).
      "allowFrom": []
    }
  },

  // Case-insensitive regexes that count as a mention.
  "mentionPatterns": ["^hey claude\\b"],

  // Emoji from Telegram's fixed whitelist. Empty string disables.
  "ackReaction": "👀",

  // Threading on chunked replies: first | all | off
  "replyToMode": "first",

  // Split threshold. Telegram rejects > 4096.
  "textChunkLimit": 4096,

  // length = cut at limit. newline = prefer paragraph boundaries.
  "chunkMode": "newline"
}
```
