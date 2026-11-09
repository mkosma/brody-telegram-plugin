#!/usr/bin/python3 -I
"""revert-proofs.py - every feature's test can fail.

Spec SPEC-bridge-tee-topic-gate-tag-relay-2026-11-09, acceptance 6: revert
each feature's core line and show that its test goes red. Extended for
SPEC-bridge-names-invite-excuse-2026-11-09 (ids N*, L*, I*), whose every
acceptance case carries a revert that goes red. Extended again for
SPEC-on-call-agents-wake-and-sleep-2026-11-09, "The wake check" (ids W*).

Each revert is applied to a COPY of this tree in a temp dir (node_modules is
symlinked in), never to the tree itself. A revert whose text is not found
exactly once is an error, not a pass: a revert that changes nothing proves
nothing. For each one the script runs `bun test` and requires (a) a nonzero
exit and (b) the named test among the failures.

Usage: ./revert-proofs.py [ID ...]     exit 0 when every revert went red.
"""
import os
import re
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))

# (id, feature, file, original, reverted, a test that must go red)
REVERTS = [
    ("T1", "post log", "reply.ts",
     "const writeAll = () => { for (const e of entries) safeTee(deps.tee, e) }",
     "const writeAll = () => {}",
     "outbound log: a group reply writes one line per chunk with the sent message ids"),
    ("T2", "post log", "reply.ts",
     "  } finally {\n    if (isGroupChatId(chat_id)) {",
     "  } finally {\n    if (true) {",
     "outbound log: a DM reply writes nothing"),
    ("T3", "post log", "post-log.ts",
     "      stderr(`telegram channel: post log write failed (send unaffected): ${err}\\n`)",
     "      throw err",
     "outbound log: when the log write throws, the send still succeeds with the same result"),
    ("T4", "post log", "post-log.ts",
     "    if (p.chat && isGroupChatType(p.chat.type)) {",
     "    if (p.chat && isGroupChatType(p.chat.type) && result?.action === 'deliver') {",
     "inbound log: a group message the gate drops is logged with delivered:false"),
    ("G1", "thread gate", "group-gate.ts",
     "  const thread = policy.threads?.[threadKey(threadId)]",
     "  const thread = undefined as ThreadPolicy | undefined",
     "thread gate: group off, thread 39 on"),
    ("R1", "tag relay", "tag-relay.ts",
     "      '--to', `agent:${agent}`,\n      '--from', deps.sender,",
     "      '--to', agent,\n      '--from', deps.sender,",
     "relay: a post tagging @MK_MayaBot calls dispatch send --to agent:Maya once"),
    ("R2", "tag relay", "tag-relay.ts",
     "      if (own && u.toLowerCase() === own) continue\n",
     "",
     "relay: tagging the bridge's own bot calls nothing"),
    ("R2b", "tag relay", "tag-relay.ts",
     "    if (agent.toLowerCase() === deps.sender.toLowerCase()) return\n",
     "",
     "relay: @monty, @page and @clerk relay nothing"),
    ("R3", "tag relay", "tag-relay.ts",
     "  const m = /^MK_([A-Za-z][A-Za-z0-9]*)Bot$/i.exec(username)",
     "  const m = /^(?:MK_)?([A-Za-z][A-Za-z0-9]*?)(?:Bot)?$/i.exec(username)",
     "relay: tagging @EmmaBrodybot calls nothing"),
    ("R4", "tag relay", "tag-relay.ts",
     "    if (!deps.limiter.take(deps.sender, agent)) {",
     "    if (false) {",
     "relay: the 7th relay in an hour to one recipient is skipped and logged"),
    ("R5", "tag relay", "reply.ts",
     "      if (ok && deps.relay) {",
     "      if (false && deps.relay) {",
     "relay: the 7th relay in an hour to one recipient is skipped and logged"),
    ("E1", "edit_forum_topic", "forum-topic.ts",
     "    await deps.api.editForumTopic(chat_id, thread, { name })",
     "    // reverted",
     "edit_forum_topic: calls editForumTopic with the topic and name"),
    ("E2", "edit_forum_topic", "forum-topic.ts",
     "(err as { description?: string }).description ?? ",
     "",
     "edit_forum_topic: on error returns the API's own description"),
    # SPEC-bridge-names-invite-excuse-2026-11-09, item 1
    ("N1", "@name mention", "group-gate.ts",
     "  if (nameMentionPattern(agent)?.test(text)) return true\n",
     "",
     "name mention: @vera, @Vera, and hi @vera match; @verabot, x@vera.com and @veranda do not"),
    ("N2", "@name mention", "group-gate.ts",
     "  return new RegExp(`(^|[^\\\\w@])@${agent}(?![\\\\w])`, 'i')",
     "  return new RegExp(`@${agent}`, 'i')",
     "name mention: @vera, @Vera, and hi @vera match; @verabot, x@vera.com and @veranda do not"),
    ("N3", "@name mention", "group-gate.ts",
     "  if (!agent || !/^[A-Za-z][A-Za-z0-9]*$/.test(agent)) return undefined\n",
     "  if (!agent) return undefined\n",
     "name mention: an unverified name has no pattern"),
    ("N4", "@name mention", "server.ts",
     "inboundDecision(access, ctx, botUsername, ACCESS_AGENT)",
     "inboundDecision(access, ctx, botUsername, '<Agent>')",
     "name mention: gate() passes the bridge's agent name to groupDecision"),
    # SPEC-bridge-names-invite-excuse-2026-11-09, item 1, the relay
    ("L1", "@name relay", "tag-relay.ts",
     "      else if (member) add(member, n)\n",
     "",
     "relay: @maya in a post of Vera's relays to Maya"),
    ("L2", "@name relay", "tag-relay.ts",
     "      else if (member) add(member, n)\n",
     "      else add(member ?? n, n)\n",
     "relay: @monty, @page and @clerk relay nothing"),
    ("L3", "@name relay", "tag-relay.ts",
     "      else add(member ?? agent, u, member ? undefined : 'roster')\n",
     "      else add(agent, u)\n",
     "relay: a bot username off the standing roster is skipped, whatever dispatch resolve says"),
    ("L4", "@name relay", "tag-relay.ts",
     "      if (!roster) add(agent, u, 'no-roster')\n      else ",
     "      ",
     "relay: if the roster cannot be read, nothing relays and skipped:\"no-roster\" is logged"),
    ("L5", "@name relay", "tag-relay.ts",
     "    if (skip) return { to: agent, skipped: skip }\n",
     "",
     "relay: if the roster cannot be read, nothing relays and skipped:\"no-roster\" is logged"),
    ("L6", "@name relay", "server.ts",
     "  roster: () => readRoster(),\n",
     "  roster: () => ['Vera', 'Maya', 'Grady', 'Taiichi', 'Werner'],\n",
     "relay: the server hands relayTags the real roster"),
    ("L7", "@name relay", "tag-relay.ts",
     "  return [...text.matchAll(/(?:^|[^\\w@])@([A-Za-z][A-Za-z0-9]*)(?![\\w])/g)].map(m => m[1])",
     "  return [...text.matchAll(/@([A-Za-z][A-Za-z0-9]*)/g)].map(m => m[1])",
     "relay: @monty, @page and @clerk relay nothing"),
    # SPEC-bridge-names-invite-excuse-2026-11-09, item 2 (agents 16d16c3)
    ("I1", "/invite", "invite-excuse.ts",
     "    group.threads = { ...(group.threads ?? {}), [key]: { ...(group.threads?.[key] ?? {}), requireMention: false } }\n",
     "",
     "invite: /invite @grady from Monty in thread 40 sets thread 40 open in Grady's access, and answers once"),
    ("I2", "/invite", "invite-excuse.ts",
     "  if (!deps.loadAccess().allowFrom.includes(String(msg.from.id))) return { kind: 'ignore' }\n",
     "",
     "invite: from a non-allowFrom user it does nothing and sends no answer"),
    ("I3", "/invite", "invite-excuse.ts",
     "  if (!cmd.names.some(n => mine.has(n))) return { kind: 'ignore' }\n",
     "",
     "invite: /invite @vera leaves Grady's access unchanged, and a nameless /invite does nothing"),
    ("I4", "/invite", "invite-excuse.ts",
     "      access.groups[chat_id] = { requireMention: true, allowFrom: [], threads: { [key]: { requireMention: false } } }\n      return true\n",
     "      return false\n",
     "invite: into a group not yet enabled creates it mention-only with one thread open; a second writes nothing and answers the same"),
    ("I5", "/invite", "invite-excuse.ts",
     "    if (group.threads?.[key]?.requireMention === false) return false\n",
     "",
     "invite: into a group not yet enabled creates it mention-only with one thread open; a second writes nothing and answers the same"),
    ("I6", "/excuse", "invite-excuse.ts",
     "  group.threads = { ...(group.threads ?? {}), [key]: { ...(group.threads?.[key] ?? {}), requireMention: true } }\n",
     "",
     "excuse: /excuse @grady sets the entry true; then an untagged post in 40 drops and @grady delivers"),
    ("I7", "general key", "group-gate.ts",
     "  const thread = policy.threads?.[threadKey(threadId)]\n",
     "  const thread = threadId != null ? policy.threads?.[String(threadId)] : undefined\n",
     "invite: in General keys \"general\", and an untagged post in thread 40 is still dropped"),
    ("I8", "general key", "invite-excuse.ts",
     "key: threadKey(msg.message_thread_id) }",
     "key: String(msg.message_thread_id) }",
     "invite: in General keys \"general\", and an untagged post in thread 40 is still dropped"),
    ("I9", "/invite STATIC", "invite-excuse.ts",
     "  if (deps.isStatic) {\n    await say(STATIC_ANSWER)\n    return 'static'\n  }\n",
     "",
     "invite: in STATIC mode the bot answers that it cannot, and nothing claims the change"),
    ("I10", "/invite", "invite-excuse.ts",
     "      return 'failed'\n",
     "",
     "invite: a failed access.json write says nothing and tells nobody"),
    ("I11", "/invite", "invite-excuse.ts",
     "  if (!msg.from || msg.from.is_bot) return { kind: 'ignore' }\n",
     "  if (!msg.from) return { kind: 'ignore' }\n",
     "invite: from a non-allowFrom user it does nothing and sends no answer"),
    ("I12", "/invite wiring", "server.ts",
     "    if (command.kind === 'act') await runGroupCommand(deps, command)\n    return\n  }\n",
     "    if (command.kind === 'act') await runGroupCommand(deps, command)\n  }\n",
     "invite: handleInbound plans the command before gate() and never delivers it as chat"),
    ("I13", "/invite wiring", "server.ts",
     "On an invite, read the topic with `tail-fleet-posts --thread <id> --since 2h` before you answer; you were not following it.",
     "",
     "invite: the MCP instructions tell the agent to read the topic on an invite"),
    ("P1", "phrases", "phrases.ts",
     "        valid = validPhrases(parsed?.[kind])\n",
     "        valid = validPhrases(parsed?.arrive)\n",
     "phrases: a pick comes from the list for its kind, read on each use"),
    ("P2", "phrases", "phrases.ts",
     "    .filter(p => p.length > 0 && p.split(/\\s+/).length <= PHRASE_MAX_WORDS)\n",
     "    .filter(p => p.length > 0)\n",
     "phrases: a phrase over 12 words, or empty, is never picked"),
    ("P3", "phrases", "phrases.ts",
     "    const choices = valid.length > 1 ? valid.filter(p => p !== this.last) : valid\n",
     "    const choices = valid\n",
     "phrases: never the same phrase twice in a row"),
    ("P4", "phrases", "phrases.ts",
     "      return fallbackPhrase(kind, this.opts.name())\n",
     "      return ''\n",
     "phrases: missing, unreadable or empty list falls back to \"<Name> here.\" / \"<Name> out.\" with one stderr line"),
    ("P5", "phrases", "phrases.ts",
     "      stderr(`telegram channel: ${why}; answering with the fallback\\n`)\n",
     "",
     "phrases: missing, unreadable or empty list falls back to \"<Name> here.\" / \"<Name> out.\" with one stderr line"),
    ("P6", "phrases", "phrases.ts",
     "        const parsed = JSON.parse((this.opts.read ?? (p => readFileSync(p, 'utf8')))(this.opts.file))\n",
     "        const parsed = JSON.parse(this.cache ??= (this.opts.read ?? (p => readFileSync(p, 'utf8')))(this.opts.file))\n",
     "phrases: a pick comes from the list for its kind, read on each use"),
    ("P7", "phrases wiring", "server.ts",
     "    phrase: verb => phrasePicker.pick(verb === 'invite' ? 'arrive' : 'depart'),\n",
     "    phrase: verb => phrasePicker.pick('arrive'),\n",
     "phrases: the server answers invite with an arrive phrase and excuse with a depart phrase"),
    # SPEC-on-call-agents-wake-and-sleep-2026-11-09, "The wake check"
    ("W1", "wake: exit 10", "wake-check.ts",
     "      if (v.action === 'deliver') {\n        if (dropsThisPage > 0) {",
     "      if (false) {\n        if (dropsThisPage > 0) {",
     "wake check: a DM from allowFrom exits 10, leaves it pending, and posts the ack in its chat"),
    ("W2", "wake: unconfirmed", "wake-check.ts",
     "offset: u.update_id, limit: 1",
     "offset: u.update_id + 1, limit: 1",
     "wake check: a mention behind a full 100-update page of chatter wakes the agent, in its own thread"),
    ("W3", "wake: drop tee", "wake-check.ts",
     "      if (v.tee) teeInbound({ ...v.tee, tee }, () => ({ action: 'drop' }))\n",
     "",
     "wake check: chatter the bridge would drop is logged delivered:false and confirmed"),
    ("W4", "wake: 100-page", "wake-check.ts",
     "    offset = updates[updates.length - 1].update_id + 1\n",
     "    return EXIT.NOTHING\n",
     "wake check: a mention behind a full 100-update page of chatter wakes the agent, in its own thread"),
    ("W5", "wake: peek", "wake-check.ts",
     "...(offset != null ? { offset } : {})",
     "offset: offset ?? -1",
     "wake check: nothing pending exits 0, and the peek is timeout 0 with no offset"),
    ("W6", "wake: dedupe", "wake-check.ts",
     "  if (prev?.update_id === update_id) return 'already'\n",
     "",
     "wake check: the ack is posted once per wake (dedupe on update id)"),
    ("W7", "wake: refuse", "wake-check.ts",
     "  if (running !== false) {",
     "  if (running === 'unknown') {",
     "wake check: refuses, touching no API, while a server.ts for this state dir runs"),
    ("W8", "wake: refuse", "wake-check.ts",
     "  try { return realpathSync(p).toLowerCase() } catch { return p.toLowerCase() }",
     "  try { return realpathSync(p) } catch { return p }",
     "bridge probe: case-blind match on TELEGRAM_STATE_DIR; a ps failure is unknown; its own pid never counts"),
    ("W9", "wake: exit 3", "wake-check.ts",
     "      return fail(`getUpdates failed: ${describeError(e)}`)",
     "      return EXIT.NOTHING",
     "wake check: a failed peek exits 3, naming class and description, never the token"),
    ("W10", "wake: no token", "wake-check.ts",
     "  if (err instanceof HttpError) return 'HttpError: network request failed'",
     "  if (err instanceof HttpError) return `HttpError: network request failed (${(err as any).error?.path})`",
     "wake check: a failed peek exits 3, naming class and description, never the token"),
    ("W11", "wake: pairing", "wake-check.ts",
     "    if (decision === 'deliver') {",
     "    if (decision !== 'drop') {",
     "wake classify: a stranger's DM is a drop under every dmPolicy, and disabled drops Monty too"),
    ("W12", "wake: /invite", "wake-check.ts",
     "    if (plan.kind === 'act') return { action: 'deliver', why: plan.verb, ack: { chat_id, thread_id } }\n",
     "",
     "wake classify: an /invite or /excuse naming this agent delivers even where the gate would drop"),
    ("W13", "wake: commands", "wake-check.ts",
     "    if (Context.has.command(BRIDGE_COMMANDS)(ctx)) {",
     "    if (false) {",
     "wake classify: /status in a DM from allowFrom delivers; a group /start is dropped and never logged"),
    ("W14", "wake: button", "wake-check.ts",
     "    if (!env.access.allowFrom.includes(String(cq.from.id))) return { action: 'drop', why: 'button-not-allowed' }\n",
     "",
     "wake classify: a reaction or a button tap from allowFrom delivers; from anyone else drops"),
    ("W15", "wake: reaction", "wake-check.ts",
     "    if (!userId || !env.access.allowFrom.includes(userId)) return",
     "    if (!userId) return",
     "wake classify: a reaction or a button tap from allowFrom delivers; from anyone else drops"),
    ("W16", "wake: kinds", "wake-check.ts",
     "    if (text === undefined) return { action: 'drop', why: 'unhandled-kind' }\n",
     "",
     "wake classify: kinds the bridge has no handler for are dropped and never logged"),
    ("W17", "wake: ack thread", "wake-check.ts",
     "ack.thread_id != null ? { message_thread_id: ack.thread_id } : {}",
     "{}",
     "wake check: a mention behind a full 100-update page of chatter wakes the agent, in its own thread"),
    ("W18", "shared gate", "inbound-gate.ts",
     "    if (access.dmPolicy === 'allowlist') return 'drop'\n",
     "",
     "wake classify: a stranger's DM is a drop under every dmPolicy, and disabled drops Monty too"),
    ("W19", "shared text", "inbound-gate.ts",
     "  if (m.video_note) return '(video note)'\n",
     "  if (m.video_note) return m.caption ?? '(video note)'\n",
     "inbound text: each kind is logged under the text the bridge hands handleInbound"),
    ("W20", "server wiring", "server.ts",
     "        allowed_updates: [...ALLOWED_UPDATES],",
     "        allowed_updates: ['message'],",
     "server wiring: polls ALLOWED_UPDATES and takes every handler text from inboundText"),
]

FAIL_RE = re.compile(r"^\(fail\) (.*?)(?: \[[0-9.]+m?s\])?$", re.M)


def copy_tree(dst):
    for name in os.listdir(HERE):
        if name.endswith(".ts") or name in ("package.json", "bun.lock"):
            shutil.copy2(os.path.join(HERE, name), os.path.join(dst, name))
    os.symlink(os.path.join(HERE, "node_modules"), os.path.join(dst, "node_modules"))


def run_tests(d):
    p = subprocess.run(["bun", "test"], cwd=d, capture_output=True, text=True, timeout=120)
    out = p.stdout + p.stderr
    return p.returncode, FAIL_RE.findall(out), out


def main(argv):
    if not os.path.isdir(os.path.join(HERE, "node_modules")):
        print("no node_modules here; run `bun install` first", file=sys.stderr)
        return 2
    want = set(argv)
    # An id that names no revert would run nothing and report green.
    unknown = want - {r[0] for r in REVERTS}
    if unknown:
        print("unknown revert id(s): %s" % " ".join(sorted(unknown)), file=sys.stderr)
        return 2
    bad = 0
    with tempfile.TemporaryDirectory(prefix="bridge-revert-") as base:
        d = os.path.join(base, "baseline")
        os.mkdir(d)
        copy_tree(d)
        rc, fails, out = run_tests(d)
        print("baseline: rc=%d, %d failing" % (rc, len(fails)))
        if rc != 0:
            print(out)
            return 1
        for rid, feature, fname, orig, rev, must_fail in REVERTS:
            if want and rid not in want:
                continue
            d = os.path.join(base, rid)
            os.mkdir(d)
            copy_tree(d)
            path = os.path.join(d, fname)
            src = open(path).read()
            n = src.count(orig)
            if n != 1:
                print("%s %-16s ERROR: revert text found %d times in %s" % (rid, feature, n, fname))
                bad += 1
                continue
            open(path, "w").write(src.replace(orig, rev))
            rc, fails, _ = run_tests(d)
            red = rc != 0 and must_fail in fails
            print("%s %-16s %s  rc=%d  %s: %r reverted -> red: %s" % (
                rid, feature, "RED " if red else "MISS", rc, fname,
                orig.strip().split("\n")[0][:60], "; ".join(fails)))
            if not red:
                bad += 1
    print("=== %s ===" % ("every revert went red" if bad == 0 else "%d revert(s) did NOT go red" % bad))
    return 0 if bad == 0 else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
