/**
 * The bridge refuses a post into a private chat.
 *
 * Design: agents/Grady/design/DESIGN-bridge-refuses-bot-dms-2026-11-27.
 *
 * WHAT WAS SO. assertAllowedChat passed any chat in allowFrom. Monty's user id
 * is in it for his inbound DMs, and a private chat's id equals the user id, so
 * every agent bot could reply, edit or react in his DM and nothing refused it.
 * Maya's Shortcut replies landed in an archived DM that way and returned
 * success to her.
 *
 * TWO LAYERS, ONE RULE.
 *   1. assertOutboundChat is the outbound tools' gate. A tool handed a private
 *      chat fails at once with PRIVATE_CHAT_REFUSAL, before anything is sent,
 *      so the agent reads where the post belongs.
 *   2. refusePrivateChat is a transformer on the bot's API. It sees every call
 *      the bridge makes, so a send path nobody thought to gate is refused by
 *      default rather than allowed by default.
 *
 * EXEMPTIONS ARE NAMED HERE AND NOWHERE ELSE. A path of the bridge's own that
 * must keep posting into a private chat is one row of PRIVATE_CHAT_EXEMPTIONS,
 * with its reason and the API methods it covers, and its call site marks the
 * payload with exempt('<name>'). The mark is a symbol key: tool arguments
 * arrive as JSON, which cannot carry one, so there is no override an agent can
 * pass.
 *
 * INBOUND IS UNTOUCHED. He can still message a bot directly; the bot answers
 * in the FLEET topic where the work is.
 */

/** The tool's error, word for word from the design: it names the home. */
export const PRIVATE_CHAT_REFUSAL = "Monty's DM is not a work channel: post in the FLEET topic where the work is."

/**
 * Telegram chat ids: a user (so a DM) is positive, a group or supergroup is
 * negative. A private chat's id is the user's id.
 */
export function isPrivateChatId(chat_id: unknown): boolean {
  return (typeof chat_id === 'string' || typeof chat_id === 'number') && /^[1-9]\d*$/.test(String(chat_id))
}

/**
 * Every path that may still post into a private chat, by name. To add one,
 * add a row with its reason; there is no other way through.
 */
export const PRIVATE_CHAT_EXEMPTIONS = {
  pairing: {
    reason: 'A stranger being paired has no FLEET topic: the pairing code and the "Paired!" confirmation can only go to the DM the request came from.',
    methods: ['sendMessage'],
  },
  'dm-command': {
    reason: '/start, /help and /status are answered only in a DM, because a group answer would show a pairing code to the group. They say how pairing stands and carry no work.',
    methods: ['sendMessage'],
  },
  'permission-relay': {
    reason: 'A Claude Code permission prompt goes only to a paired DM, because Allow and Deny are his alone and a group member was never paired. Covers the prompt, the edit that records his choice and the mark on his typed yes or no.',
    methods: ['sendMessage', 'editMessageText', 'setMessageReaction'],
  },
  'tap-answer': {
    reason: "The bridge's answer to a button he tapped goes on or under the tapped message: the mark on the tapped button, and the one line that says an open or an alert action failed. A button already standing in a DM must not fail silently.",
    methods: ['sendMessage', 'editMessageReplyMarkup'],
  },
  'pin-release': {
    reason: 'Taking a pin down posts nothing, and a pin placed in a DM before this refusal existed must still come down.',
    methods: ['unpinChatMessage'],
  },
  'wake-ack': {
    reason: 'wake-check answers his DM to a sleeping agent where he sent it, as SPEC-on-call-agents-wake-and-sleep-2026-11-09 has it. Dormant while FLEET_ONCALL is empty.',
    methods: ['sendMessage'],
  },
} as const satisfies Record<string, { reason: string; methods: readonly string[] }>

export type PrivateChatExemption = keyof typeof PRIVATE_CHAT_EXEMPTIONS

const EXEMPT = Symbol('private-chat-exemption')

/**
 * Spread into a call's `other` to mark it as one of the named exemptions:
 * `bot.api.sendMessage(id, text, exempt('pairing'))`.
 */
export function exempt(name: PrivateChatExemption): Record<never, never> {
  return { [EXEMPT]: name }
}

function exemptionCovers(name: unknown, method: string): boolean {
  if (typeof name !== 'string' || !Object.hasOwn(PRIVATE_CHAT_EXEMPTIONS, name)) return false
  return (PRIVATE_CHAT_EXEMPTIONS[name as PrivateChatExemption].methods as readonly string[]).includes(method)
}

/**
 * The transformer. Any call that carries a private chat_id is refused unless
 * it is a read (get*: it posts nothing) or its payload is marked with an
 * exemption that covers the method.
 */
export async function refusePrivateChat<T>(
  prev: (method: never, payload: never, signal?: AbortSignal) => Promise<T>,
  method: string,
  payload: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const p = (payload ?? {}) as Record<PropertyKey, unknown>
  if (isPrivateChatId(p.chat_id) && !method.startsWith('get') && !exemptionCovers(p[EXEMPT], method)) {
    throw new Error(`${PRIVATE_CHAT_REFUSAL} (${method} to a private chat refused by the bridge)`)
  }
  return prev(method as never, payload as never, signal)
}

export type OutboundAccess = { allowFrom: string[]; groups: Record<string, unknown> }

/**
 * The outbound tools' gate. A private chat is refused first, allowlisted or
 * not: allowlisting a user lets his DMs in, it never made his DM a place to
 * post. Then the chat must be a group the inbound gate would deliver from.
 *
 * `exemption` is for a tool that is itself a named exemption (unpin_message);
 * it is fixed where the tool is wired, never read from the tool's arguments.
 */
export function assertOutboundChat(
  access: OutboundAccess,
  chat_id: string,
  accessCmd: string,
  exemption?: PrivateChatExemption,
): void {
  if (isPrivateChatId(chat_id)) {
    if (exemption === undefined || !Object.hasOwn(PRIVATE_CHAT_EXEMPTIONS, exemption)) throw new Error(PRIVATE_CHAT_REFUSAL)
    if (access.allowFrom.includes(chat_id)) return
  }
  if (chat_id in access.groups) return
  throw new Error(`chat ${chat_id} is not allowlisted: add it with ${accessCmd} group-add <chat_id>`)
}
