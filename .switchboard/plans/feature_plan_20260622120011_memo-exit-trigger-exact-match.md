# Memo Should Only Exit Capture Mode on an Exact Trigger, Not a Word Mid-Sentence

## Goal

The agent currently leaves memo capture mode whenever a trigger word (e.g. "investigate", "process", "analyze") appears anywhere in a message. A captured note like *"memo instruction gets overridden by antigravity app system instruction, investigate and propose a fix"* contains "investigate" and "memo" but is clearly a memo entry, NOT a command to exit. Capture mode must only exit when the user's entire message is exactly one of the defined exit commands.

### Problem Analysis

The exit triggers are defined in [.agent/skills/memo/SKILL.md:23-39](.agent/skills/memo/SKILL.md#L23) as bare phrases:

```
When the user says any of:
- "investigate memo"
- "analyze memo"
- "refine memo"
- "process memo"
- "send memo to planner"
Then: ...process all entries into plans.
```

"When the user says any of" is ambiguous and the agent interprets it as substring/intent matching. Any memo entry that happens to contain words like "investigate"/"process"/"analyze" near "memo" (extremely common when the memo itself is about the memo/agent system) is misread as an exit command, dumping the user out of capture mode and triggering plan generation on a half-written memo.

### Root Cause

The exit condition is specified as loose phrase-presence rather than an exact, whole-message match, so trigger words embedded in legitimate memo content fire the exit.

## Metadata

**Complexity:** 2
**Tags:** prompt-engineering, skills, memo, ux

## Complexity Audit

### Routine
- Rewording the exit-trigger section to require an exact, standalone message match.

### Complex / Risky
- Must be unambiguous enough that the agent reliably distinguishes "the whole message IS the command" from "the message contains the words." Pair with the capture-mode re-assertion (issue 10) so the rule is restated each turn.

## Edge-Case & Dependency Audit

- **Race Conditions:** None.
- **Security:** None.
- **Side Effects:** Stricter matching means the user must type the exit command cleanly. Document the exact commands in the acknowledgement line so users know what to type. The Memo modal's explicit buttons (Copy Prompt / Send to Planner) remain the unambiguous, click-driven exit path.
- **Dependencies & Conflicts:** Coordinate wording with the capture-mode override plan and the write-out plan so the three memo edits stay consistent. After the `.agent` → `.agents` rename, the skill path changes.

## Proposed Changes

### 1. `.agent/skills/memo/SKILL.md` — require exact, whole-message exit commands

Replace the Exit Triggers section ([23-39](.agent/skills/memo/SKILL.md#L23)) with:

```markdown
### Exit Triggers (EXACT MATCH ONLY)

Exit capture mode ONLY when the user's ENTIRE message, trimmed and
case-insensitive, is exactly one of:

- `investigate memo`
- `analyze memo`
- `refine memo`
- `process memo`
- `send memo to planner`

A trigger word appearing INSIDE a longer sentence is memo content, never a
command. Example: "memo instruction gets overridden..., investigate and propose
a fix" is a memo entry — APPEND it, do not exit. If you are unsure whether a
message is a command or a note, treat it as a note and append it; the user can
always send the exact command afterward.

When an exact exit command is received:
1. Read all entries from `.switchboard/memo.md`.
2. Split on blank lines into separate issues.
3. Create a separate plan file in `.switchboard/plans/` per issue (standard plan format), investigating the codebase first.
4. Report which plan files were created.
```

### 2. (Consistency) `AGENTS.md`
Update the memo row to say capture mode exits only on an exact command, matching the skill.

## Verification Plan

1. Run `/memo`; send the exact note from the issue ("...investigate and propose a fix") → confirm it is appended, not treated as an exit.
2. Send other notes containing "process", "analyze", "memo" inside sentences → confirm all are appended.
3. Send a message that is exactly `investigate memo` → confirm the agent exits capture mode and generates one plan per entry.
4. Send `Investigate Memo` (different case) and ` process memo ` (whitespace) → confirm trimming + case-insensitivity still exit.
5. Confirm a near-miss like "can you investigate the memo?" does NOT exit (it is not an exact command).
