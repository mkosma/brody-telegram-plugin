#!/usr/bin/python3 -I
"""revert-proofs.py - every feature's test can fail.

Spec SPEC-bridge-tee-topic-gate-tag-relay-2026-11-09, acceptance 6: revert
each feature's core line and show that its test goes red. Extended for
SPEC-bridge-names-invite-excuse-2026-11-09 (ids N*, L*, I*), whose every
acceptance case carries a revert that goes red.

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
     "  const thread = threadId != null ? policy.threads?.[String(threadId)] : undefined",
     "  const thread = undefined as ThreadPolicy | undefined",
     "thread gate: group off, thread 39 on"),
    ("R1", "tag relay", "tag-relay.ts",
     "      '--to', `agent:${agent}`,\n      '--from', deps.sender,",
     "      '--to', agent,\n      '--from', deps.sender,",
     "relay: a post tagging @MK_MayaBot calls dispatch send --to agent:Maya once"),
    ("R2", "tag relay", "tag-relay.ts",
     "      if (own && u.toLowerCase() === own) continue\n      const agent = botAgent(u)\n      if (!agent) continue\n      if (agent.toLowerCase() === deps.sender.toLowerCase()) continue\n",
     "      const agent = botAgent(u)\n      if (!agent) continue\n",
     "relay: tagging the bridge's own bot calls nothing"),
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
     "access.mentionPatterns, ACCESS_AGENT) === 'deliver'",
     "access.mentionPatterns) === 'deliver'",
     "name mention: gate() passes the bridge's agent name to groupDecision"),
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
