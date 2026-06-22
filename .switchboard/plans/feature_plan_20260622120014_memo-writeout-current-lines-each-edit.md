# Memo Skill: Write Out the Current Memo Lines After `/memo` and After Every Edit

## Goal

When using the memo skill, after the user types `/memo` and after every subsequent edit (append) to the memo file, the agent should write out the current list of memo lines so the user always sees the full, up-to-date memo contents.

### Problem Analysis

The memo skill [.agent/skills/memo/SKILL.md](.agent/skills/memo/SKILL.md) currently:
- On `/memo` ("Capture Mode") — reads the file and displays "current entry count and last few entries" ([9-13](.agent/skills/memo/SKILL.md#L9)).
- On each appended entry — responds only with `Added to memo: "<first 50 chars>..." (N entries total)` ([15-21](.agent/skills/memo/SKILL.md#L15)).

So after edits the user sees a one-line truncated acknowledgement, not the full current memo. There is no instruction to echo the complete, numbered list of memo lines after each change, which makes it hard to track what has been captured and to catch mis-captured entries.

### Root Cause

The skill specifies a truncated, single-entry acknowledgement instead of re-emitting the full current memo list after each append (and on `/memo` entry).

## Metadata

**Complexity:** 1
**Tags:** prompt-engineering, skills, memo, ux

## Complexity Audit

### Routine
- Editing the skill instructions to require a full, numbered write-out of memo lines after `/memo` and after each append.

### Complex / Risky
- None. Keep the write-out concise (numbered list) so long memos remain readable; large memos may be summarized with a count + full list.

## Edge-Case & Dependency Audit

- **Race Conditions:** None.
- **Security:** None.
- **Side Effects:** Echoing the full memo each turn is more verbose; acceptable and explicitly requested. Must not break capture mode (no analysis — just display).
- **Dependencies & Conflicts:** Stay consistent with the capture-mode override plan and the exact-match exit plan. After the `.agent` → `.agents` rename, the skill file path changes. The on-disk format is one issue per blank-line-separated block (see `_parseMemoEntries` in [KanbanProvider.ts:6965-6987](src/services/KanbanProvider.ts#L6965)); the write-out should mirror that segmentation so the numbering matches what "Send to Planner" will produce.

## Proposed Changes

### 1. `.agent/skills/memo/SKILL.md` — require a full write-out

Update Capture Mode entry ([9-13](.agent/skills/memo/SKILL.md#L9)):
```markdown
### Capture Mode
1. Read `.switchboard/memo.md` (create if missing).
2. Write out the FULL current memo as a numbered list (one number per
   blank-line-separated entry), then state the total count.
3. Enter capture mode.
```

Update Appending Entries ([15-21](.agent/skills/memo/SKILL.md#L15)):
```markdown
### Appending Entries
For each user message while in capture mode:
1. Append the message to `.switchboard/memo.md`, separated from the previous
   entry by a blank line.
2. Re-read the file and write out the FULL current memo as a numbered list
   (each blank-line-separated entry = one numbered item), ending with
   "(N entries total)".
3. Do NOT analyze, investigate, plan, or write code — just capture and echo the list.
```

Example output the skill should produce after each edit:
```
[MEMO CAPTURE ACTIVE]
1. Bug: login button overlaps on mobile
2. Thought: maybe cache the user profile
3. Issue: API returns 500 on empty payload
(3 entries total) — still capturing.
```

## Verification Plan

1. Run `/memo` in a workspace with an existing `.switchboard/memo.md` → confirm the agent prints the full numbered list of existing entries and the count.
2. Append three entries one at a time → after each, confirm the agent prints the complete current numbered list (not just the new line) with the updated count.
3. Confirm the numbering matches blank-line segmentation (so it equals the issue count "Send to Planner" would generate).
4. Confirm capture mode is not broken (no analysis, entries still appended).
